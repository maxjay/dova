//! The Azure Repos PR page can return current thread positions, iteration
//! and changed files together. Keep the private wire format here. If the
//! provider is unavailable or its shape changes, use the REST reads.

use super::{check_status, settle, AdoClient, Iteration, Method, PullRequest, Request, Result, JSON};
use crate::ado::map::{is_discussion, to_change, to_pull_request, to_thread};
use crate::ado::sections::{Section, Sections};
use crate::ado::types::{Change, Thread};
use crate::error::Error;
use crate::urls::enc;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{Cursor, Read};

const PROVIDER: &str = "ms.vss-code-web.pr-detail-data-provider";
const ITERATIONS: u16 = 16;
const LATEST_CHANGES: u16 = 256;
const DISCUSSIONS: u16 = 8;
const THREAD_CONTEXTS: u16 = 512;

struct Review {
    iteration: Iteration,
    files: Vec<Change>,
    threads: Vec<Thread>,
}

impl AdoClient<'_> {
    /// Fetch the distinct old and new blobs together. A submodule or a server
    /// without the ZIP endpoint can still be read by the single-blob path.
    pub fn review_blobs(&self, pr: &PullRequest, ids: &BTreeSet<&str>) -> Result<HashMap<String, Option<Vec<u8>>>> {
        let mut blobs = if ids.len() > 1 { self.blob_archive(pr, ids)? } else { HashMap::new() };
        let missing: Vec<_> = ids.iter().copied().filter(|id| !blobs.contains_key(*id)).collect();
        let fetched = crate::par::map(&missing, |id| self.blob(pr, id));
        for (id, bytes) in missing.into_iter().zip(fetched) {
            blobs.insert(id.to_owned(), bytes?);
        }
        Ok(blobs)
    }

    fn blob_archive(&self, pr: &PullRequest, ids: &BTreeSet<&str>) -> Result<HashMap<String, Option<Vec<u8>>>> {
        let path = format!("{}/_apis/git/repositories/{}/blobs", enc(&pr.project), enc(&pr.repo));
        let req = Request {
            method: Method::Post,
            body: Some(json!(ids).to_string()),
            content_type: Some(JSON.into()),
            binary: true,
            zip: true,
            ..Request::get(self.url(&path, &[])?)
        };
        let response = match self.http.send(&req) {
            Ok(response) => response,
            Err(err) if err.kind == crate::error::Kind::External => return Ok(HashMap::new()),
            Err(err) => return Err(err),
        };
        if matches!(response.status, 400 | 403 | 404 | 405 | 413 | 500 | 501) {
            return Ok(HashMap::new());
        }
        check_status(&response, &req)?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(response.body).ok();
        Ok(bytes.and_then(|bytes| unpack(bytes, ids)).unwrap_or_default())
    }

    pub fn review_files(&self, pr: &PullRequest) -> Result<(Iteration, Vec<Change>)> {
        if let Some(review) = self.review(pr, false)? {
            return Ok((review.iteration, review.files));
        }
        let iteration = self.latest_iteration(pr)?;
        let files = self.changes(pr, iteration.id)?;
        Ok((iteration, files))
    }

    pub fn review_threads(&self, pr: &PullRequest) -> Result<Vec<Thread>> {
        match self.review(pr, true)? {
            Some(review) => Ok(review.threads),
            None => self.placed_threads(pr),
        }
    }

    fn review(&self, pr: &PullRequest, discussions: bool) -> Result<Option<Review>> {
        let mask = ITERATIONS | LATEST_CHANGES | if discussions { DISCUSSIONS | THREAD_CONTEXTS } else { 0 };
        let Some(data) = self.provider_data(pr, mask)? else { return Ok(None) };
        let Some(mut review) = self.complete_review(pr, &data, discussions)? else { return Ok(None) };
        for thread in &mut review.threads {
            settle(thread, &review.files);
        }
        Ok(Some(review))
    }

    fn complete_review(&self, pr: &PullRequest, data: &Value, discussions: bool) -> Result<Option<Review>> {
        let Some((mut review, skip)) = parse(data, discussions) else { return Ok(None) };
        if skip > 0 {
            review.files.extend(self.changes_from(pr, review.iteration.id, skip)?);
        }
        Ok(Some(review))
    }

    fn provider_data(&self, pr: &PullRequest, mask: u16) -> Result<Option<Value>> {
        let (Some(project), Some(repo)) = (&pr.project_id, &pr.repo_id) else { return Ok(None) };
        let props = json!({
            "pullRequestId": pr.id, "repositoryId": repo, "types": mask,
            "sourcePage": {"url": format!("{}?_a=files", pr.url)}
        });
        let mut data = self.contribution_data(project, &[PROVIDER], &props, true)?;
        Ok(data.get_mut(PROVIDER).filter(|v| v.is_object()).map(Value::take))
    }
}

fn unpack(bytes: Vec<u8>, ids: &BTreeSet<&str>) -> Option<HashMap<String, Option<Vec<u8>>>> {
    // Fall back to individual blobs when a batch would expand beyond this budget.
    let mut remaining = 64 * 1024 * 1024_u64;
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let mut blobs = HashMap::new();
    for id in ids {
        let Ok(file) = zip.by_name(&id.to_ascii_lowercase()) else { continue };
        if file.size() > remaining {
            continue;
        }
        let mut bytes = Vec::new();
        file.take(remaining + 1).read_to_end(&mut bytes).ok()?;
        remaining = remaining.checked_sub(bytes.len() as u64)?;
        blobs.insert((*id).to_owned(), Some(bytes));
    }
    Some(blobs)
}

fn parse(data: &Value, discussions: bool) -> Option<(Review, u64)> {
    let id = data["latestIterationId"].as_u64().filter(|i| *i > 0)?;
    let raw = data["iterations"].as_array()?.iter().find(|i| i["id"].as_u64() == Some(id))?;
    let iteration = Iteration {
        id,
        base: raw["commonRefCommit"]["commitId"].as_str()?.to_owned(),
        head: raw["sourceRefCommit"]["commitId"].as_str()?.to_owned(),
    };
    let page = &data["latestChanges"];
    let mut files = Vec::new();
    for entry in page["changeEntries"].as_array()? {
        let kind = &entry["changeType"];
        if !kind.is_string() && !kind.is_u64() {
            return None;
        }
        if let Some(file) = to_change(entry) {
            if file.at().is_empty() || (file.kind != "deleted" && file.path.is_none()) {
                return None;
            }
            files.push(file);
        }
    }
    let threads = if discussions { discussion(data)? } else { Vec::new() };
    let skip = match &page["nextSkip"] {
        Value::Null => 0,
        n => n.as_u64()?,
    };
    Some((Review { iteration, files, threads }, skip))
}

fn discussion(data: &Value) -> Option<Vec<Thread>> {
    let mut threads = Vec::new();
    for raw in data["discussionThreads"].as_array()? {
        raw["id"].as_u64()?;
        // Deleted threads can omit their comments.
        if raw["isDeleted"] != true {
            raw["comments"].as_array()?;
        }
        if is_discussion(raw) {
            threads.push(to_thread(raw));
        }
    }
    Some(threads)
}

/// Latest file membership for positioning discussions without fetching the file list
/// again on every comment. This lives for exactly one subscription.
#[derive(Default)]
pub struct Placement {
    iteration: Option<u64>,
    paths: HashSet<String>,
}

impl AdoClient<'_> {
    pub fn read_sections(&self, pr: &PullRequest, sections: &Sections, placement: &mut Placement) -> Result<Value> {
        use Section::*;
        let mut mask = 0;
        for s in sections {
            mask |= match s {
                Details | Reviewers => 1,
                Discussion => DISCUSSIONS | THREAD_CONTEXTS,
                Checks => 66,
                Statuses => 128,
                Labels => 32,
                WorkItems => 0,
                Files => ITERATIONS | LATEST_CHANGES,
                Relations | Comments => return Err(Error::user("Invalid PR section.")),
            };
        }
        let bad = || Error::external("Azure DevOps did not return the requested PR sections.");
        let provider = || if mask == 0 { Ok(Value::Null) } else { self.provider_data(pr, mask)?.ok_or_else(bad) };
        let (data, items) = if sections.contains(&WorkItems) {
            let (data, items) = crate::par::join(provider, || self.pull_request_work_item_refs(pr));
            (data?, items?)
        } else {
            (provider()?, Vec::new())
        };
        let mut out = json!({});
        if sections.contains(&Details) || sections.contains(&Reviewers) {
            let raw = &data["pullRequest"];
            if raw["pullRequestId"].as_u64() != Some(pr.id) {
                return Err(bad());
            }
            if sections.contains(&Details) {
                let mut detail = json!(to_pull_request(raw, &self.org_url, &pr.project, &pr.repo));
                detail["mergeStatus"] = json!(match raw["mergeStatus"].as_u64() {
                    Some(1) => "queued",
                    Some(2) => "conflicts",
                    Some(3) => "succeeded",
                    Some(4) => "rejectedByPolicy",
                    Some(5) => "failure",
                    _ => raw["mergeStatus"].as_str().unwrap_or("notSet"),
                });
                detail["createdAt"] = raw["creationDate"].clone();
                out["details"] = detail;
            }
            if sections.contains(&Reviewers) {
                out["reviewers"] = json!(raw["reviewers"].as_array().ok_or_else(bad)?.iter().map(|r| json!({
                    "id":r["id"], "name":r["displayName"], "vote":r["vote"], "required":r["isRequired"].as_bool().unwrap_or(false)
                })).collect::<Vec<_>>());
            }
        }
        if sections.contains(&Checks) {
            out["checks"] = json!(data["policies"].as_array().ok_or_else(bad)?.iter().map(|p| json!({
                "id":p["evaluationId"], "name":p["displayName"], "description":p["displayText"],
                "status":p["status"], "blocking":p["isBlocking"], "buildId":p["buildId"], "buildOutputPreview":p["buildOutputPreview"]
            })).collect::<Vec<_>>());
        }
        if sections.contains(&Statuses) {
            out["statuses"] = json!(data["statuses"]
                .as_array()
                .ok_or_else(bad)?
                .iter()
                .map(|s| json!({
                    "id":s["id"], "context":s["context"], "state":s["state"], "description":s["description"],
                    "url":s["targetUrl"], "iteration":s["iterationId"], "updatedAt":s["updatedDate"]
                }))
                .collect::<Vec<_>>());
        }
        if sections.contains(&Labels) {
            out["labels"] = json!(data["labels"].as_array().ok_or_else(bad)?);
        }
        if sections.contains(&WorkItems) {
            out["workItems"] = json!(items);
        }
        let needs_files = sections.contains(&Files);
        let needs_threads = sections.contains(&Discussion);
        let latest = data["latestIterationId"].as_u64();
        if needs_files || (needs_threads && (latest.is_none() || placement.iteration != latest)) {
            // A discussion-only read can race a push. Re-read both sides together.
            let refreshed;
            let source = if needs_files {
                &data
            } else {
                refreshed = self
                    .provider_data(pr, ITERATIONS | LATEST_CHANGES | DISCUSSIONS | THREAD_CONTEXTS)?
                    .ok_or_else(bad)?;
                &refreshed
            };
            let review = self.complete_review(pr, source, needs_threads)?.ok_or_else(bad)?;
            placement.iteration = Some(review.iteration.id);
            placement.paths = review.files.iter().map(|f| f.at().to_owned()).collect();
            if needs_files {
                out["files"] = json!({"iteration":review.iteration, "entries": review.files.iter().map(|f| json!({
                    "path":f.at(), "oldPath":f.old_path, "change":f.kind, "oldBlob":f.old_blob, "newBlob":f.blob
                })).collect::<Vec<_>>()});
            }
            if needs_threads {
                out["discussion"] = placement.threads(review.threads);
            }
        } else if needs_threads {
            out["discussion"] = placement.threads(discussion(&data).ok_or_else(bad)?);
        }
        Ok(out)
    }
}

impl Placement {
    fn threads(&self, mut threads: Vec<Thread>) -> Value {
        for t in &mut threads {
            if let Some(loc) = t.location.as_mut().filter(|l| !self.paths.contains(&l.file)) {
                (loc.line, loc.end_line, loc.outdated) = (None, None, true);
            }
        }
        json!(threads)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{bytes_response, cli, ok, rest_pr, Bed};
    use std::io::Write;

    #[test]
    fn view_and_diff_use_the_same_push_including_files_on_later_pages() {
        let bed = Bed::new(Box::new(|r| {
            if r.path.ends_with("/pullrequests/9") {
                return ok(rest_pr(9, json!({})));
            }
            if r.path.ends_with("/workitems") {
                return ok(json!({"value":[]}));
            }
            if r.path.ends_with("/HierarchyQuery/project/p") {
                let props = &r.body["dataProviderContext"]["properties"];
                assert_eq!(props["repositoryId"], "r");
                assert_eq!(props["pullRequestId"], 9);
                let mut review = json!({
                    "latestIterationId":2,
                    "iterations":[{"id":2,"sourceRefCommit":{"commitId":"new"},"commonRefCommit":{"commitId":"base"}}],
                    "latestChanges":{"changeEntries":[{"changeType":16,"item":{"path":null,"originalObjectId":"old"},"originalPath":"/gone"}],"nextSkip":1}
                });
                match props["types"].as_u64().unwrap() {
                    272 => {}
                    792 => {
                        review["discussionThreads"] = json!([
                            {"id":1,"status":1,"comments":[{"commentType":1,"content":"one"}],
                             "threadContext":{"filePath":"/new","rightFileStart":{"line":5}}},
                            {"id":2,"status":2,"comments":[{"commentType":1,"content":"two"}],
                             "threadContext":{"filePath":"/reverted","leftFileStart":{"line":1}}},
                            {"id":3,"comments":[{"commentType":3,"content":"push"}]}
                        ])
                    }
                    mask => panic!("unexpected mask {mask}"),
                }
                return ok(json!({"dataProviders":{(PROVIDER):review}}));
            }
            assert!(r.path.ends_with("/iterations/2/changes"), "{}", r.path);
            assert_eq!(r.query("$skip").as_deref(), Some("1"));
            ok(json!({"changeEntries":[{"changeType":"add","item":{"path":"/new","objectId":"new"}}]}))
        }));
        let view = cli(bed.app(), &["pr", "view", "9", "--json"]).json();
        let threads = view["threads"].as_array().unwrap();
        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0]["location"]["line"], 5);
        assert_eq!(threads[0]["unresolved"], true);
        assert_eq!(threads[1]["location"]["outdated"], true);
        let diff = cli(bed.app(), &["pr", "diff", "9", "--names", "--json"]).json();
        assert_eq!(diff["iteration"], 2);
        assert_eq!(diff["files"][0]["path"], "/gone");
        assert_eq!(diff["files"][0]["change"], "deleted");
        assert_eq!(diff["files"][1]["path"], "/new");
        assert_eq!(bed.ado.requests().len(), 7);
    }

    #[test]
    fn diff_loads_duplicate_blobs_once_and_can_read_an_entry_missing_from_the_zip() {
        let bed = Bed::new(Box::new(|r| {
            if r.path.ends_with("/pullrequests/9") {
                return ok(rest_pr(9, json!({})));
            }
            if r.path.ends_with("/HierarchyQuery/project/p") {
                let changes: Vec<_> = ["/first", "/second"]
                    .iter()
                    .map(|p| json!({"changeType":2,"item":{"path":p,"objectId":"b","originalObjectId":"a"}}))
                    .collect();
                let review = json!({"latestIterationId":1, "iterations":[{"id":1,"commonRefCommit":{"commitId":"c"},"sourceRefCommit":{"commitId":"d"}}],"latestChanges":{"changeEntries":changes}});
                return ok(json!({"dataProviders":{(PROVIDER):review}}));
            }
            if r.path.ends_with("/blobs") {
                assert!(r.raw.zip && r.raw.binary);
                assert_eq!(r.body, json!(["a", "b"]));
                let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
                zip.start_file("a", zip::write::SimpleFileOptions::default()).unwrap();
                zip.write_all(b"old").unwrap();
                return Some(bytes_response(&zip.finish().unwrap().into_inner()));
            }
            assert!(r.path.ends_with("/blobs/b"), "{}", r.path);
            Some(bytes_response(b"new"))
        }));
        let diff = cli(bed.app(), &["pr", "diff", "9", "--files", "first", "second", "--json"]).json();
        for file in diff["files"].as_array().unwrap() {
            assert_eq!(file["old"], "old");
            assert_eq!(file["new"], "new");
        }
        assert_eq!(bed.ado.requests().iter().filter(|r| r.path.ends_with("/blobs")).count(), 1);
        assert_eq!(bed.ado.requests().iter().filter(|r| r.path.ends_with("/blobs/b")).count(), 1);
    }
}
