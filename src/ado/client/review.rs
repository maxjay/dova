use super::{settle, AdoClient, Iteration, Method, PullRequest, Request, Result, JSON};
use crate::ado::map::{is_discussion, to_change, to_pull_request, to_thread};
use crate::ado::sections::{Section, Sections};
use crate::ado::types::{Change, Thread, WorkItemRef};
use crate::error::Error;
use crate::urls::enc;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::io::{Cursor, Read};

const PROVIDER: &str = "ms.vss-code-web.pr-detail-data-provider";
const ITERATIONS: u16 = 16;
const LATEST_CHANGES: u16 = 256;
const DISCUSSIONS: u16 = 8;
const THREAD_CONTEXTS: u16 = 512;

#[derive(Default)]
pub struct PrRead {
    pub snapshot: Value,
    files: Option<(Iteration, Vec<Change>)>,
    pub threads: Vec<Thread>,
    pub work_items: Vec<WorkItemRef>,
}

fn incomplete() -> Error {
    Error::external("Azure DevOps omitted requested PR data.")
}

impl AdoClient<'_> {
    pub fn review_blobs(&self, pr: &PullRequest, ids: &BTreeSet<&str>) -> Result<HashMap<String, Vec<u8>>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let path = format!("{}/_apis/git/repositories/{}/blobs", enc(&pr.project), enc(&pr.repo));
        let req = Request {
            method: Method::Post,
            body: Some(json!(ids).to_string()),
            content_type: Some(JSON.into()),
            binary: true,
            zip: true,
            ..Request::get(self.url(&path, &[])?)
        };
        let response = self.send(&req)?;
        let invalid = || Error::external("Azure DevOps returned an invalid Git blob archive.");
        let bytes = base64::engine::general_purpose::STANDARD.decode(response.body).map_err(|_| invalid())?;
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid())?;
        let mut blobs = HashMap::new();
        for id in ids {
            let mut file = zip.by_name(&id.to_ascii_lowercase()).map_err(|_| invalid())?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).map_err(|_| invalid())?;
            blobs.insert((*id).to_owned(), bytes);
        }
        Ok(blobs)
    }

    pub fn review_files(&self, pr: &PullRequest) -> Result<(Iteration, Vec<Change>)> {
        self.read_pr(pr, &[Section::Files].into())?.files.ok_or_else(incomplete)
    }

    fn provider_data(&self, pr: &PullRequest, mask: u16) -> Result<Value> {
        let project = pr.project_id.as_deref().ok_or_else(incomplete)?;
        let repo = pr.repo_id.as_deref().ok_or_else(incomplete)?;
        let props = json!({
            "pullRequestId": pr.id, "repositoryId": repo, "types": mask,
            "sourcePage": {"url": format!("{}?_a=files", pr.url)}
        });
        let mut data = self.contribution_data(project, &[PROVIDER], &props)?;
        data.get_mut(PROVIDER).filter(|v| v.is_object()).map(Value::take).ok_or_else(incomplete)
    }

    fn review_changes(
        &self,
        pr: &PullRequest,
        data: &Value,
        want_files: bool,
        threads: &[Thread],
    ) -> Result<(Iteration, Vec<Change>)> {
        let id = data["latestIterationId"].as_u64().ok_or_else(incomplete)?;
        let raw = data["iterations"]
            .as_array()
            .and_then(|items| items.iter().find(|i| i["id"] == id))
            .ok_or_else(incomplete)?;
        let iteration = Iteration {
            id,
            base: raw["commonRefCommit"]["commitId"].as_str().ok_or_else(incomplete)?.to_owned(),
            head: raw["sourceRefCommit"]["commitId"].as_str().ok_or_else(incomplete)?.to_owned(),
        };
        let page = &data["latestChanges"];
        let mut files: Vec<_> =
            page["changeEntries"].as_array().ok_or_else(incomplete)?.iter().filter_map(to_change).collect();
        if let Some(skip) = page["nextSkip"].as_u64().filter(|n| *n > 0) {
            let missing_path = |thread: &Thread| {
                thread.location.as_ref().is_some_and(|at| !files.iter().any(|file| file.at() == at.file))
            };
            if want_files || threads.iter().any(missing_path) {
                files.extend(self.changes_from(pr, id, skip)?);
            }
        }
        Ok((iteration, files))
    }

    pub fn read_pr(&self, pr: &PullRequest, sections: &Sections) -> Result<PrRead> {
        use Section::*;
        let mut mask = 0;
        for s in sections {
            mask |= match s {
                Details | Reviewers => 1,
                Discussion => DISCUSSIONS | THREAD_CONTEXTS | ITERATIONS | LATEST_CHANGES,
                Checks => 66,
                Statuses => 128,
                Labels => 32,
                WorkItems => 0,
                Files => ITERATIONS | LATEST_CHANGES,
                Relations | Comments => return Err(Error::user("Invalid PR section.")),
            };
        }

        let provider = || if mask == 0 { Ok(Value::Null) } else { self.provider_data(pr, mask) };
        let (data, items) = if sections.contains(&WorkItems) {
            let (data, items) = crate::par::join(provider, || self.pull_request_work_item_refs(pr));
            (data?, items?)
        } else {
            (provider()?, Vec::new())
        };
        let mut read = PrRead { work_items: items, ..PrRead::default() };
        let out = &mut read.snapshot;
        if sections.contains(&Details) || sections.contains(&Reviewers) {
            let raw = &data["pullRequest"];
            if raw["pullRequestId"].as_u64() != Some(pr.id) {
                return Err(incomplete());
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
                out["reviewers"] = json!(raw["reviewers"].as_array().ok_or_else(incomplete)?.iter().map(|r| json!({
                    "id":r["id"], "name":r["displayName"], "vote":r["vote"], "required":r["isRequired"].as_bool().unwrap_or(false)
                })).collect::<Vec<_>>());
            }
        }
        if sections.contains(&Checks) {
            out["checks"] = json!(data["policies"].as_array().ok_or_else(incomplete)?.iter().map(|p| json!({
                "id":p["evaluationId"], "name":p["displayName"], "description":p["displayText"],
                "status":p["status"], "blocking":p["isBlocking"], "buildId":p["buildId"], "buildOutputPreview":p["buildOutputPreview"]
            })).collect::<Vec<_>>());
        }
        if sections.contains(&Statuses) {
            out["statuses"] = json!(data["statuses"]
                .as_array()
                .ok_or_else(incomplete)?
                .iter()
                .map(|s| json!({
                    "id":s["id"], "context":s["context"], "state":s["state"], "description":s["description"],
                    "url":s["targetUrl"], "iteration":s["iterationId"], "updatedAt":s["updatedDate"]
                }))
                .collect::<Vec<_>>());
        }
        if sections.contains(&Labels) {
            out["labels"] = json!(data["labels"].as_array().ok_or_else(incomplete)?);
        }
        if sections.contains(&Discussion) {
            read.threads = data["discussionThreads"]
                .as_array()
                .ok_or_else(incomplete)?
                .iter()
                .filter(|t| is_discussion(t))
                .map(to_thread)
                .collect();
            out["discussion"] = json!(&read.threads);
        }
        if sections.contains(&WorkItems) {
            out["workItems"] = json!(&read.work_items);
        }
        let want_files = sections.contains(&Files);
        if want_files || read.threads.iter().any(|t| t.location.is_some()) {
            let (iteration, files) = self.review_changes(pr, &data, want_files, &read.threads)?;
            for thread in &mut read.threads {
                settle(thread, &files);
            }
            if want_files {
                out["files"] = json!({"iteration":iteration, "entries": files.iter().map(|f| json!({
                    "path":f.at(), "oldPath":f.old_path, "change":f.kind, "oldBlob":f.old_blob, "newBlob":f.blob
                })).collect::<Vec<_>>()});
                read.files = Some((iteration, files));
            }
        }
        Ok(read)
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
    fn diff_loads_duplicate_blobs_once_in_one_archive() {
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
                zip.start_file("b", zip::write::SimpleFileOptions::default()).unwrap();
                zip.write_all(b"new").unwrap();
                return Some(bytes_response(&zip.finish().unwrap().into_inner()));
            }
            None
        }));
        let diff = cli(bed.app(), &["pr", "diff", "9", "--files", "first", "second", "--json"]).json();
        for file in diff["files"].as_array().unwrap() {
            assert_eq!(file["old"], "old");
            assert_eq!(file["new"], "new");
        }
        assert_eq!(bed.ado.requests().iter().filter(|r| r.path.ends_with("/blobs")).count(), 1);
    }
}
