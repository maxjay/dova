//! Azure DevOps as typed calls against one organization (REST api-version 7.1).

use serde_json::{json, Value};
use url::Url;

use super::map::{
    body_field, is_discussion, same_identity, to_change, to_pull_request, to_run, to_thread, to_timeline_record,
    to_work_item, to_work_item_comment, vote_of, POINTS, WORK_ITEM_FIELDS,
};
use super::types::{
    Anchor, Change, Comment, Iteration, PullRequest, Review, Run, TeamAreas, Thread, TimelineRecord, WorkItem,
};
use super::{Method, Request, Response, Transport};
use crate::error::{Error, Kind, Result};
use crate::par;
use crate::urls::{enc, unique};

/// The most ids the work items batch endpoint takes.
const BATCH: usize = 200;
/// The most pull requests one list asks for.
pub const MOST: usize = 100;
/// How many changed files one request for a pull request's changes asks for.
const PAGE: &str = "2000";
/// How many of a user's teams are asked about at the same time.
const AT_ONCE: usize = 8;
const JSON: &str = "application/json";
/// Work item comments are still a preview API.
const COMMENTS: &str = "7.1-preview.4";

fn head_ref(branch: &str) -> String {
    if branch.starts_with("refs/") {
        branch.to_string()
    } else {
        format!("refs/heads/{branch}")
    }
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

#[derive(Debug, Default)]
pub struct NewWorkItem {
    pub project: String,
    pub kind: String,
    pub title: String,
    pub area_path: Option<String>,
    pub iteration_path: Option<String>,
    /// HTML, as the field stores it.
    pub description: Option<String>,
    pub assigned_to: Option<String>,
    pub parent_id: Option<u64>,
}

#[derive(Debug, Default)]
pub struct NewPullRequest {
    pub project: String,
    pub repo: String,
    pub source_branch: String,
    pub target_branch: String,
    pub title: String,
    pub description: Option<String>,
    pub is_draft: bool,
    pub work_item_ids: Vec<u64>,
}

pub struct AdoClient<'a> {
    http: &'a dyn Transport,
    pub org_url: String,
}

impl<'a> AdoClient<'a> {
    pub fn new(http: &'a dyn Transport, org_url: impl Into<String>) -> Self {
        AdoClient { http, org_url: org_url.into() }
    }

    /* work items */

    pub fn work_item(&self, id: u64) -> Result<WorkItem> {
        self.work_items(&[id])?.pop().ok_or_else(|| Error::not_found(format!("Work item #{id} was not found.")))
    }

    /// In the order asked; ids that don't exist or can't be seen are left out.
    pub fn work_items(&self, ids: &[u64]) -> Result<Vec<WorkItem>> {
        let unique = unique(ids.iter().copied());
        let pages: Vec<&[u64]> = unique.chunks(BATCH).collect();
        let fetched = par::map(&pages, |page| {
            let body = json!({ "ids": page, "fields": WORK_ITEM_FIELDS, "errorPolicy": "omit" });
            self.call(Method::Post, "_apis/wit/workitemsbatch", &[], Some((&body, JSON)))
        });
        let mut found = Vec::with_capacity(unique.len());
        for page in fetched {
            found.extend(list(&page?["value"]).iter().filter(|w| !w.is_null()).map(|w| to_work_item(w, &self.org_url)));
        }
        Ok(unique
            .iter()
            .filter_map(|id| found.iter().position(|w| w.id == *id).map(|at| found.swap_remove(at)))
            .collect())
    }

    pub fn query(&self, wiql: &str) -> Result<Vec<WorkItem>> {
        let res =
            self.call(Method::Post, "_apis/wit/wiql", &[("$top", "1000")], Some((&json!({ "query": wiql }), JSON)))?;
        let ids: Vec<u64> = list(&res["workItems"]).iter().filter_map(|w| w["id"].as_u64()).collect();
        self.work_items(&ids)
    }

    pub fn create_work_item(&self, item: &NewWorkItem) -> Result<WorkItem> {
        let (body, _) = body_field(&item.kind);
        let fields = [
            ("System.Title", Some(&item.title)),
            ("System.AreaPath", item.area_path.as_ref()),
            ("System.IterationPath", item.iteration_path.as_ref()),
            (body, item.description.as_ref()),
            ("System.AssignedTo", item.assigned_to.as_ref()),
        ];
        let mut patch: Vec<Value> = fields
            .iter()
            .filter_map(|(field, value)| {
                Some(json!({ "op": "add", "path": format!("/fields/{field}"), "value": (*value)? }))
            })
            .collect();
        if let Some(parent) = item.parent_id {
            let parent = json!({ "rel": "System.LinkTypes.Hierarchy-Reverse", "url": format!("{}/_apis/wit/workItems/{parent}", self.org_url) });
            patch.push(json!({ "op": "add", "path": "/relations/-", "value": parent }));
        }
        let path = format!("{}/_apis/wit/workitems/${}", enc(&item.project), enc(&item.kind));
        let raw = self.call(Method::Post, &path, &[], Some((&Value::Array(patch), "application/json-patch+json")))?;
        Ok(to_work_item(&raw, &self.org_url))
    }

    /// Sets fields on a work item, each by its reference name (`System.Title`).
    pub fn update_work_item(&self, id: u64, fields: &[(&str, Value)]) -> Result<WorkItem> {
        let set =
            |(field, value): &(&str, Value)| json!({ "op": "add", "path": format!("/fields/{field}"), "value": value });
        let patch = Value::Array(fields.iter().map(set).collect());
        let path = format!("_apis/wit/workitems/{id}");
        let raw = self.call(Method::Patch, &path, &[], Some((&patch, "application/json-patch+json")))?;
        Ok(to_work_item(&raw, &self.org_url))
    }

    /// One field of a work item exactly as stored (HTML, for the rich-text ones).
    pub fn work_item_field(&self, id: u64, field: &str) -> Result<Option<String>> {
        let raw = self.get(&format!("_apis/wit/workitems/{id}"), &[("fields", field)])?;
        Ok(raw["fields"][field].as_str().map(str::to_string))
    }

    /// The states a work item type can be in, in the order its workflow lists them.
    pub fn work_item_states(&self, project: &str, kind: &str) -> Result<Vec<String>> {
        let res = self.get(&format!("{}/_apis/wit/workitemtypes/{}/states", enc(project), enc(kind)), &[])?;
        Ok(list(&res["value"]).iter().filter_map(|state| state["name"].as_str().map(str::to_string)).collect())
    }

    /// The field a work item type keeps its estimate in: story points, effort or size. None for a type without one.
    pub fn points_field(&self, project: &str, kind: &str) -> Result<Option<&'static str>> {
        let res = self.get(&format!("{}/_apis/wit/workitemtypes/{}/fields", enc(project), enc(kind)), &[])?;
        let has = |field: &&&str| list(&res["value"]).iter().any(|f| f["referenceName"] == **field);
        Ok(POINTS.iter().find(has).copied())
    }

    /// A work item's discussion, oldest first.
    pub fn work_item_comments(&self, project: &str, id: u64) -> Result<Vec<Comment>> {
        let path = format!("{}/_apis/wit/workItems/{id}/comments", enc(project));
        let res = self.get(&path, &[("api-version", COMMENTS), ("$top", "200"), ("order", "asc")])?;
        Ok(list(&res["comments"]).iter().map(to_work_item_comment).collect())
    }

    /// Adds to a work item's discussion; `html` is shown as it is.
    pub fn add_work_item_comment(&self, project: &str, id: u64, html: &str) -> Result<Comment> {
        let path = format!("{}/_apis/wit/workItems/{id}/comments", enc(project));
        let body = json!({ "text": html });
        Ok(to_work_item_comment(&self.call(Method::Post, &path, &[("api-version", COMMENTS)], Some((&body, JSON)))?))
    }

    /* teams */

    pub fn teams(&self, project: &str) -> Result<Vec<String>> {
        let res = self.get(&format!("_apis/projects/{}/teams", enc(project)), &[("$top", "1000")])?;
        Ok(list(&res["value"]).iter().filter_map(|t| t["name"].as_str().map(str::to_string)).collect())
    }

    pub fn team_areas(&self, project: &str, team: &str) -> Result<TeamAreas> {
        let res = self.get(&format!("{}/{}/_apis/work/teamsettings/teamfieldvalues", enc(project), enc(team)), &[])?;
        Ok(TeamAreas {
            default_area: res["defaultValue"].as_str().unwrap_or("").to_string(),
            areas: list(&res["values"]).iter().filter_map(|v| v["value"].as_str().map(str::to_string)).collect(),
        })
    }

    /// None for a Kanban-only team, or one between sprints.
    pub fn current_iteration(&self, project: &str, team: &str) -> Result<Option<String>> {
        let res = self.get(
            &format!("{}/{}/_apis/work/teamsettings/iterations", enc(project), enc(team)),
            &[("$timeframe", "current")],
        )?;
        Ok(res["value"][0]["path"].as_str().map(str::to_string))
    }

    /* repos and pull requests */

    pub fn default_branch(&self, project: &str, repo: &str) -> Result<Option<String>> {
        let res = self.get(&format!("{}/_apis/git/repositories/{}", enc(project), enc(repo)), &[])?;
        Ok(res["defaultBranch"].as_str().map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_string()))
    }

    pub fn pull_request(&self, id: u64) -> Result<PullRequest> {
        let raw =
            self.get_or(&format!("_apis/git/pullrequests/{id}"), || format!("Pull request #{id} was not found."))?;
        Ok(to_pull_request(&raw, &self.org_url, "", ""))
    }

    pub fn active_pull_request(&self, project: &str, repo: &str, branch: &str) -> Result<Option<PullRequest>> {
        let query =
            [("searchCriteria.sourceRefName", head_ref(branch)), ("searchCriteria.status", "active".to_string())];
        let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let res = self.get(&format!("{}/_apis/git/repositories/{}/pullrequests", enc(project), enc(repo)), &query)?;
        Ok(list(&res["value"]).first().map(|raw| to_pull_request(raw, &self.org_url, project, repo)))
    }

    /// The pull requests the signed-in user opened in a project, newest first, [`MOST`] at most.
    /// `status` is active, completed, abandoned or all.
    pub fn my_pull_requests(&self, project: &str, status: &str) -> Result<Vec<PullRequest>> {
        let me = self.my_id()?;
        let most = MOST.to_string();
        let query =
            [("searchCriteria.creatorId", me.as_str()), ("searchCriteria.status", status), ("$top", most.as_str())];
        let res = self.get(&format!("{}/_apis/git/pullrequests", enc(project)), &query)?;
        Ok(list(&res["value"]).iter().map(|raw| to_pull_request(raw, &self.org_url, project, "")).collect())
    }

    /// The pull requests in a project that ask the signed-in user for a
    /// review, newest first, [`MOST`] at most: the ones that name them, and
    /// the ones that name a team of theirs unless they opened it themselves.
    /// `status` is active, completed, abandoned or all.
    pub fn pull_requests_to_review(&self, project: &str, status: &str) -> Result<Vec<(PullRequest, Review)>> {
        let (me, teams) = par::join(|| self.my_id(), || self.my_teams());
        let (me, teams) = (me?, teams?);
        // Azure DevOps matches a reviewer by that one id: asking for a person
        // doesn't find what was given to their team, so each team is asked for too.
        let mut reviewers: Vec<(&str, Option<&str>)> = vec![(&me, None)];
        reviewers.extend(teams.iter().map(|(id, name)| (id.as_str(), Some(name.as_str()))));
        let most = MOST.to_string();
        let path = format!("{}/_apis/git/pullrequests", enc(project));
        let given_to = |(reviewer, _): &(&str, Option<&str>)| {
            self.get(
                &path,
                &[("searchCriteria.reviewerId", reviewer), ("searchCriteria.status", status), ("$top", most.as_str())],
            )
        };
        let found: Vec<Value> =
            reviewers.chunks(AT_ONCE).flat_map(|some| par::map(some, given_to)).collect::<Result<_>>()?;

        let mut asked: Vec<(PullRequest, Review)> = Vec::new();
        for ((_, team), res) in reviewers.iter().zip(&found) {
            for raw in list(&res["value"]) {
                let pr = to_pull_request(raw, &self.org_url, project, "");
                let own = team.is_some() && same_identity(&raw["createdBy"]["id"], &me);
                if !own && asked.iter().all(|(seen, _)| seen.id != pr.id) {
                    asked.push((pr, Review { vote: vote_of(raw, &me), team: team.map(str::to_string) }));
                }
            }
        }
        asked.sort_by_key(|(pr, _)| std::cmp::Reverse(pr.id));
        asked.truncate(MOST);
        Ok(asked)
    }

    /// The id of whoever is signed in.
    fn my_id(&self) -> Result<String> {
        let me = self.authenticated_user()?;
        let id = me["id"].as_str().ok_or_else(|| Error::external("Azure DevOps didn't say who is signed in."))?;
        Ok(id.to_string())
    }

    /// The teams the signed-in user is in, in any project: id and name.
    fn my_teams(&self) -> Result<Vec<(String, String)>> {
        let res = self.get("_apis/teams", &[("$mine", "true"), ("$top", "500"), ("api-version", "7.1-preview.3")])?;
        let team = |raw: &Value| Some((raw["id"].as_str()?.to_string(), raw["name"].as_str()?.to_string()));
        Ok(list(&res["value"]).iter().filter_map(team).collect())
    }

    pub fn create_pull_request(&self, pr: &NewPullRequest) -> Result<PullRequest> {
        let mut body = json!({
            "sourceRefName": head_ref(&pr.source_branch),
            "targetRefName": head_ref(&pr.target_branch),
            "title": pr.title,
            "isDraft": pr.is_draft,
            "workItemRefs": pr.work_item_ids.iter().map(|id| json!({ "id": id.to_string() })).collect::<Vec<_>>(),
            // Completing the PR moves its work items on, so nobody has to.
            "completionOptions": { "transitionWorkItems": true },
        });
        if let Some(description) = &pr.description {
            body["description"] = json!(description);
        }
        let path = format!("{}/_apis/git/repositories/{}/pullrequests", enc(&pr.project), enc(&pr.repo));
        let raw = self.call(Method::Post, &path, &[], Some((&body, JSON)))?;
        Ok(to_pull_request(&raw, &self.org_url, &pr.project, &pr.repo))
    }

    /// Changes a pull request's title, its description, or whether it is a draft: whichever are given.
    pub fn update_pull_request(
        &self,
        pr: &PullRequest,
        title: Option<&str>,
        description: Option<&str>,
        draft: Option<bool>,
    ) -> Result<PullRequest> {
        let mut body = json!({});
        if let Some(draft) = draft {
            body["isDraft"] = json!(draft);
        }
        if let Some(title) = title {
            body["title"] = json!(title);
        }
        if let Some(description) = description {
            body["description"] = json!(description);
        }
        let path = format!("{}/_apis/git/repositories/{}/pullrequests/{}", enc(&pr.project), enc(&pr.repo), pr.id);
        let raw = self.call(Method::Patch, &path, &[], Some((&body, JSON)))?;
        Ok(to_pull_request(&raw, &self.org_url, &pr.project, &pr.repo))
    }

    /// Uploads a file to a pull request, under a name the pull request holds
    /// only once; the address its text can show it at.
    pub fn attach(&self, pr: &PullRequest, name: &str, bytes: &[u8]) -> Result<String> {
        use base64::Engine;
        let preview = [("api-version", "7.1-preview.1")];
        let req = Request {
            method: Method::Post,
            url: self.url(&pr_path(pr, &format!("attachments/{}", enc(name))), &preview)?,
            body: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            content_type: Some("application/octet-stream".to_string()),
            base64: true,
            ..Request::get("")
        };
        let uploaded = match self.send(&req) {
            Ok(res) => serde_json::from_str::<Value>(&res.body).unwrap_or(Value::Null),
            // The same file was attached before: use that upload.
            Err(err) if err.message.contains("already exists") => {
                let all = self.get(&pr_path(pr, "attachments"), &preview)?;
                list(&all["value"]).iter().find(|a| a["displayName"] == name).cloned().unwrap_or(Value::Null)
            }
            Err(err) => return Err(err),
        };
        let url = uploaded["url"].as_str().map(str::to_string);
        url.ok_or_else(|| Error::external(format!("Azure DevOps didn't say where it put \"{name}\".")))
    }

    pub fn pull_request_work_items(&self, pr: &PullRequest) -> Result<Vec<WorkItem>> {
        let res = self.get(&pr_path(pr, "workitems"), &[])?;
        let ids: Vec<u64> = list(&res["value"])
            .iter()
            .filter_map(|r| r["id"].as_u64().or_else(|| r["id"].as_str()?.parse().ok()))
            .collect();
        self.work_items(&ids)
    }

    /// A pull request's threads, each where it was written: enough to count
    /// and read them. [`Self::placed_threads`] says where they are now.
    pub fn threads(&self, pr: &PullRequest) -> Result<Vec<Thread>> {
        let res = self.get(&pr_path(pr, "threads"), &[])?;
        Ok(list(&res["value"]).iter().filter(|t| is_discussion(t)).map(to_thread).collect())
    }

    /// A pull request's threads, each on the lines it is on in the latest
    /// push. Asked plainly, Azure DevOps gives the lines a thread was written
    /// on, which later pushes move, remove, or stop changing the file of.
    pub fn placed_threads(&self, pr: &PullRequest) -> Result<Vec<Thread>> {
        let Some(latest) = self.latest_push(pr) else { return self.threads(pr) };
        let (threads, changes) =
            par::join(|| self.get(&pr_path(pr, "threads"), &tracked_to(&latest)), || self.changes(pr, latest.0));
        let mut threads: Vec<Thread> =
            list(&threads?["value"]).iter().filter(|t| is_discussion(t)).map(to_thread).collect();
        if let Ok(changes) = changes {
            threads.iter_mut().for_each(|thread| settle(thread, &changes));
        }
        Ok(threads)
    }

    /// One thread as it was written.
    pub fn thread(&self, pr: &PullRequest, id: u64) -> Result<Thread> {
        self.thread_at(pr, id, &[])
    }

    /// One thread, on the lines it is on in the latest push.
    pub fn placed_thread(&self, pr: &PullRequest, id: u64) -> Result<Thread> {
        let Some(latest) = self.latest_push(pr) else { return self.thread(pr, id) };
        let (thread, changes) =
            par::join(|| self.thread_at(pr, id, &tracked_to(&latest)), || self.changes(pr, latest.0));
        let mut thread = thread?;
        if let Ok(changes) = changes {
            settle(&mut thread, &changes);
        }
        Ok(thread)
    }

    fn thread_at(&self, pr: &PullRequest, id: u64, query: &[(&str, &str)]) -> Result<Thread> {
        // Azure DevOps answers for a thread that isn't there with a 500, not a 404.
        let missing = |err: Error| match err.kind == Kind::NotFound || err.message.contains("does not exist") {
            true => Error::not_found(format!("Thread #{id} was not found on PR #{}.", pr.id)),
            false => err,
        };
        Ok(to_thread(&self.get(&pr_path(pr, &format!("threads/{id}")), query).map_err(missing)?))
    }

    /// The number of a pull request's latest push, as a number and as it goes
    /// in a query. None when its pushes can't be listed: its threads can
    /// still be read, where they were written.
    fn latest_push(&self, pr: &PullRequest) -> Option<(u64, String)> {
        let res = self.get(&pr_path(pr, "iterations"), &[]).ok()?;
        let latest = list(&res["value"]).last()?["id"].as_u64()?;
        Some((latest, latest.to_string()))
    }

    /// A new thread: about the whole pull request, or `at` some lines of a file it changes.
    pub fn add_comment(&self, pr: &PullRequest, text: &str, at: Option<&Anchor>) -> Result<Thread> {
        let mut body = json!({ "comments": [{ "parentCommentId": 0, "content": text, "commentType": "text" }], "status": "active" });
        if let Some(at) = at {
            let side = if at.old { "left" } else { "right" };
            // Offsets count from 1, and the end is just past the last character: whole lines.
            // Which push it was written against, Azure DevOps fills in itself: the latest.
            body["threadContext"] = json!({
                "filePath": at.file,
                format!("{side}FileStart"): { "line": at.line, "offset": 1 },
                format!("{side}FileEnd"): { "line": at.end_line, "offset": at.end_width + 1 },
            });
        }
        Ok(to_thread(&self.call(Method::Post, &pr_path(pr, "threads"), &[], Some((&body, JSON)))?))
    }

    /* what a pull request changes */

    /// A pull request's latest push.
    pub fn latest_iteration(&self, pr: &PullRequest) -> Result<Iteration> {
        let res = self.get(&pr_path(pr, "iterations"), &[])?;
        let latest = list(&res["value"]).last();
        let latest = latest.ok_or_else(|| Error::external(format!("PR #{} has nothing pushed to it.", pr.id)))?;
        let commit = |name: &str| latest[name]["commitId"].as_str().unwrap_or("").to_string();
        Ok(Iteration {
            id: latest["id"].as_u64().unwrap_or(1),
            base: commit("commonRefCommit"),
            head: commit("sourceRefCommit"),
        })
    }

    /// Every file a push of a pull request changes, against where its branch left the target.
    pub fn changes(&self, pr: &PullRequest, iteration: u64) -> Result<Vec<Change>> {
        let path = pr_path(pr, &format!("iterations/{iteration}/changes"));
        let (mut changes, mut skip) = (Vec::new(), 0);
        loop {
            let from = skip.to_string();
            let res = self.get(&path, &[("$compareTo", "0"), ("$top", PAGE), ("$skip", &from)])?;
            changes.extend(list(&res["changeEntries"]).iter().filter_map(to_change));
            match res["nextSkip"].as_u64() {
                Some(next) if next > skip => skip = next,
                _ => return Ok(changes),
            }
        }
    }

    /// A file's contents by their id, byte for byte. None when the repo holds
    /// no such thing: the id is a submodule's commit, which lives in another repo.
    pub fn blob(&self, pr: &PullRequest, id: &str) -> Result<Option<Vec<u8>>> {
        use base64::Engine;
        let path = format!("{}/_apis/git/repositories/{}/blobs/{id}", enc(&pr.project), enc(&pr.repo));
        let url = self.url(&path, &[("$format", "octetstream")])?;
        match self.send(&Request { binary: true, ..Request::get(url) }) {
            Ok(res) => base64::engine::general_purpose::STANDARD
                .decode(res.body)
                .map(Some)
                .map_err(|_| Error::external("Azure DevOps' answer isn't the file that was asked for.")),
            Err(err) if err.message.contains("TF401035") => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Nested under the thread's last comment, so it lands in the actual conversation.
    pub fn reply(&self, pr: &PullRequest, thread_id: u64, text: &str) -> Result<()> {
        let parent = self.thread(pr, thread_id)?.comments.last().map_or(1, |c| c.id);
        let body = json!({ "content": text, "commentType": "text", "parentCommentId": parent });
        self.call(Method::Post, &pr_path(pr, &format!("threads/{thread_id}/comments")), &[], Some((&body, JSON)))
            .map(drop)
    }

    /// Rewrites the signed-in user's last comment in a thread; its id.
    pub fn amend_comment(&self, pr: &PullRequest, thread_id: u64, text: &str) -> Result<u64> {
        let me = self.authenticated_user()?;
        let thread = self.thread(pr, thread_id)?;
        let mine =
            thread.comments.iter().rev().find(|c| c.author_id.is_some() && c.author_id.as_deref() == me["id"].as_str());
        let comment = mine
            .ok_or_else(|| Error::not_found(format!("You have no comment in thread #{thread_id} on PR #{}.", pr.id)))?;
        let path = pr_path(pr, &format!("threads/{thread_id}/comments/{}", comment.id));
        self.call(Method::Patch, &path, &[], Some((&json!({ "content": text }), JSON)))?;
        Ok(comment.id)
    }

    /// `status` is the API's name: active, fixed, wontFix, closed or pending.
    pub fn set_thread_status(&self, pr: &PullRequest, thread_id: u64, status: &str) -> Result<()> {
        self.call(
            Method::Patch,
            &pr_path(pr, &format!("threads/{thread_id}")),
            &[],
            Some((&json!({ "status": status }), JSON)),
        )
        .map(drop)
    }

    /* pipelines */

    /// Most recent first, for a branch or a full ref (`refs/pull/12/merge`).
    /// Re-filtered on each run's own branch and, when one is given, its repo
    /// (another ref's run, or the same branch name in another repo, shown as
    /// this branch's CI is worse than none), so it over-fetches.
    pub fn runs(&self, project: &str, repo: Option<&str>, reference: &str, top: usize) -> Result<Vec<Run>> {
        let wanted = head_ref(reference);
        let fetch = (top * 4).max(20).to_string();
        let query = [("branchName", wanted.as_str()), ("$top", fetch.as_str()), ("queryOrder", "queueTimeDescending")];
        let res = self.get(&format!("{}/_apis/build/builds", enc(project)), &query)?;
        let same = |said: &Value, wanted: Option<&str>| match (said.as_str(), wanted) {
            (Some(said), Some(wanted)) => said.eq_ignore_ascii_case(wanted),
            _ => true,
        };
        let ours = |b: &&Value| same(&b["sourceBranch"], Some(&wanted)) && same(&b["repository"]["name"], repo);
        Ok(list(&res["value"]).iter().filter(ours).take(top).map(|b| to_run(b, &self.org_url, project)).collect())
    }

    pub fn run(&self, project: &str, id: u64) -> Result<Run> {
        let raw = self.get_or(&format!("{}/_apis/build/builds/{id}", enc(project)), || {
            format!("Pipeline run #{id} was not found.")
        })?;
        Ok(to_run(&raw, &self.org_url, project))
    }

    pub fn timeline(&self, project: &str, run_id: u64) -> Result<Vec<TimelineRecord>> {
        let path = format!("{}/_apis/build/builds/{run_id}/timeline", enc(project));
        let res = self.get_or(&path, || format!("Pipeline run #{run_id} was not found."))?;
        Ok(list(&res["records"]).iter().map(to_timeline_record).collect())
    }

    pub fn log(&self, project: &str, run_id: u64, log_id: u64) -> Result<String> {
        let url = self.url(&format!("{}/_apis/build/builds/{run_id}/logs/{log_id}", enc(project)), &[])?;
        Ok(self.send(&Request { text: true, ..Request::get(url) })?.body)
    }

    /* identity, and the escape hatch */

    /// The signed-in user as `System.AssignedTo` accepts it.
    pub fn me(&self) -> Result<Option<String>> {
        let user = self.authenticated_user()?;
        Ok(user["properties"]["Account"]["$value"]
            .as_str()
            .or(user["providerDisplayName"].as_str())
            .map(str::to_string))
    }

    fn authenticated_user(&self) -> Result<Value> {
        Ok(self.get("_apis/connectionData", &[("api-version", "7.1-preview")])?["authenticatedUser"].take())
    }

    /// What is at an address on Azure DevOps, byte for byte: what it says it is, and its bytes as base64.
    pub fn fetch(&self, url: &str) -> Result<(Option<String>, String)> {
        let res = self.send(&Request { binary: true, ..Request::get(url) })?;
        Ok((res.content_type, res.body))
    }

    /// `dova api`: any request; the body comes back as sent.
    pub fn raw(
        &self,
        method: Method,
        url: String,
        body: Option<String>,
        content_type: Option<String>,
    ) -> Result<Response> {
        let content_type = body.as_ref().map(|_| content_type.unwrap_or_else(|| JSON.to_string()));
        self.send(&Request { method, url, body, content_type, ..Request::get("") })
    }

    /* plumbing */

    /// A path relative to the organization, as a full URL with `api-version` set.
    pub fn url(&self, path: &str, query: &[(&str, &str)]) -> Result<String> {
        let base = Url::parse(&format!("{}/", self.org_url))
            .map_err(|_| Error::user(format!("\"{}\" isn't an organization URL.", self.org_url)))?;
        let mut url = base.join(path).map_err(|_| Error::user(format!("\"{path}\" isn't a request path.")))?;
        url.query_pairs_mut().extend_pairs(query);
        if !url.query_pairs().any(|(key, _)| key == "api-version") {
            url.query_pairs_mut().append_pair("api-version", "7.1");
        }
        Ok(url.into())
    }

    fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        self.call(Method::Get, path, query, None)
    }

    /// A GET whose 404 means the thing asked for doesn't exist, said in those words.
    fn get_or(&self, path: &str, not_found: impl Fn() -> String) -> Result<Value> {
        self.get(path, &[]).map_err(|err| if err.kind == Kind::NotFound { Error::not_found(not_found()) } else { err })
    }

    /// One JSON request. `Null` for an empty answer.
    fn call(&self, method: Method, path: &str, query: &[(&str, &str)], body: Option<(&Value, &str)>) -> Result<Value> {
        let req = Request {
            method,
            url: self.url(path, query)?,
            body: body.map(|(json, _)| json.to_string()),
            content_type: body.map(|(_, content_type)| content_type.to_string()),
            ..Request::get("")
        };
        let res = self.send(&req)?;
        if res.body.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&res.body).map_err(|_| {
            Error::external(format!("Azure DevOps answered {} {path} with something that isn't JSON.", method.as_str()))
        })
    }

    fn send(&self, req: &Request) -> Result<Response> {
        let res = self.http.send(req)?;
        check_status(&res, req)?;
        Ok(res)
    }
}

/// The query that has Azure DevOps move threads to where they are in a push, compared with the target.
fn tracked_to(push: &(u64, String)) -> [(&str, &str); 2] {
    [("$iteration", push.1.as_str()), ("$baseIteration", "0")]
}

/// A thread on a file the pull request doesn't change, as it is now, is on
/// no line of it: the file was deleted again, or put back as it was. Azure
/// DevOps keeps such a thread where it was written, and leaves it out of its
/// own list of changed files.
fn settle(thread: &mut Thread, changes: &[Change]) {
    if let Some(at) = thread.location.as_mut().filter(|at| !changes.iter().any(|c| c.at() == at.file)) {
        (at.line, at.end_line, at.outdated) = (None, None, true);
    }
}

fn pr_path(pr: &PullRequest, rest: &str) -> String {
    format!("{}/_apis/git/repositories/{}/pullRequests/{}/{rest}", enc(&pr.project), enc(&pr.repo), pr.id)
}

/// A 401, or a 203 bouncing to a sign-in page, arrives here only after the
/// transport already retried with a fresh token for the org's own tenant,
/// so it means no access, not "log in again".
fn check_status(res: &Response, req: &Request) -> Result<()> {
    if (200..300).contains(&res.status) && res.status != 203 {
        return Ok(());
    }
    let said =
        serde_json::from_str::<Value>(&res.body).ok().and_then(|body| body["message"].as_str().map(str::to_string));
    let path = Url::parse(&req.url).map_or_else(|_| req.url.clone(), |url| url.path().to_string());
    Err(match res.status {
        401 | 203 => Error::prereq(format!(
            "Azure DevOps refused the request: {}",
            said.unwrap_or_else(|| format!("HTTP {}", res.status))
        ))
        .hint("The account az is signed in as may lack access to this organization — check: dova auth status"),
        404 => Error::not_found(said.unwrap_or_else(|| format!("Not found: {path}"))),
        status => {
            let said = said.map_or(String::new(), |message| format!(": {message}"));
            Error::external(format!("Azure DevOps returned {status} for {} {path}{said}", req.method.as_str()))
        }
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testing::{batch, fake_ado, json_response, rest_pr, wi, Recorded, Route};

    const ORG: &str = "https://dev.azure.com/contoso";

    #[test]
    fn batches_work_items_200_at_a_time_keeps_the_order_asked_and_drops_missing_ones() {
        let ids: Vec<u64> = (1..=450).collect();
        let ado = fake_ado(batch(ids.iter().filter(|id| **id != 3).map(|id| wi(*id, json!({}))).collect()));
        let reversed: Vec<u64> = ids.iter().rev().copied().collect();
        let items = AdoClient::new(&ado, ORG).work_items(&reversed).unwrap();
        let mut sizes: Vec<usize> = ado.requests().iter().map(|r| r.body["ids"].as_array().unwrap().len()).collect();
        sizes.sort_unstable();
        assert_eq!(sizes, [50, 200, 200]);
        assert_eq!(items[0].id, 450);
        assert_eq!(items.len(), 449);
    }

    #[test]
    fn maps_a_work_item_html_stripped_only_the_body_sections_it_has() {
        let fields = json!({ "System.Parent": 2, "Microsoft.VSTS.TCM.ReproSteps": "<p>Click&nbsp;it</p>", "System.AssignedTo": { "displayName": "Jane" } });
        let ado = fake_ado(batch(vec![wi(5, fields)]));
        let item = AdoClient::new(&ado, ORG).work_item(5).unwrap();
        assert_eq!((item.id, item.parent_id, item.assigned_to.as_deref()), (5, Some(2), Some("Jane")));
        assert_eq!(item.body, [BodySection { label: "Repro Steps".into(), text: "Click it".into() }]);
        assert_eq!(item.url, "https://dev.azure.com/contoso/MyProject/_workitems/edit/5");
    }

    use crate::ado::types::BodySection;

    #[test]
    fn says_which_work_item_is_missing() {
        let ado = fake_ado(batch(vec![]));
        assert_eq!(
            AdoClient::new(&ado, ORG).work_item(9).unwrap_err(),
            Error::not_found("Work item #9 was not found.")
        );
    }

    #[test]
    fn creates_a_work_item_and_its_parent_link_in_one_request() {
        let ado = fake_ado(Box::new(|_| Some(json_response(200, wi(10, json!({}))))));
        let item = NewWorkItem {
            project: "MyProject".into(),
            kind: "User Story".into(),
            title: "T".into(),
            area_path: Some("A".into()),
            parent_id: Some(3),
            ..Default::default()
        };
        AdoClient::new(&ado, ORG).create_work_item(&item).unwrap();
        let requests = ado.requests();
        assert_eq!(requests[0].path, "/MyProject/_apis/wit/workitems/$User Story");
        assert_eq!(requests[0].raw.content_type.as_deref(), Some("application/json-patch+json"));
        assert_eq!(
            requests[0].body,
            json!([
                { "op": "add", "path": "/fields/System.Title", "value": "T" },
                { "op": "add", "path": "/fields/System.AreaPath", "value": "A" },
                { "op": "add", "path": "/relations/-", "value": { "rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://dev.azure.com/contoso/_apis/wit/workItems/3" } },
            ])
        );
    }

    #[test]
    fn a_bugs_body_is_its_repro_steps() {
        let ado = fake_ado(Box::new(|_| Some(json_response(200, wi(10, json!({}))))));
        let bug = |kind: &str| NewWorkItem {
            kind: kind.into(),
            title: "T".into(),
            description: Some("Steps".into()),
            ..Default::default()
        };
        AdoClient::new(&ado, ORG).create_work_item(&bug("Bug")).unwrap();
        AdoClient::new(&ado, ORG).create_work_item(&bug("Task")).unwrap();
        let field = |at: usize| ado.requests()[at].body[1]["path"].clone();
        assert_eq!(
            (field(0), field(1)),
            (json!("/fields/Microsoft.VSTS.TCM.ReproSteps"), json!("/fields/System.Description"))
        );
    }

    #[test]
    fn keeps_only_runs_for_the_ref_and_repo_asked_about_even_if_the_service_sends_others() {
        let run = |id: u64, branch: &str, repo: &str| json!({ "id": id, "status": "completed", "sourceBranch": branch, "repository": { "name": repo }, "queueTime": "2026-11-14T19:48:07.7530236Z" });
        let builds = json!({ "value": [run(1, "refs/heads/other", "web"), run(3, "refs/heads/feature/x", "api"), run(2, "refs/heads/feature/x", "web")] });
        let ado = fake_ado(Box::new(move |_| Some(json_response(200, builds.clone()))));
        let runs = AdoClient::new(&ado, ORG).runs("MyProject", Some("web"), "feature/x", 3).unwrap();
        assert_eq!(runs.iter().map(|r| r.id).collect::<Vec<_>>(), [2]);
        assert_eq!(runs[0].queued_at.as_deref(), Some("2026-11-14T19:48:07Z"));
        assert_eq!(runs[0].url, "https://dev.azure.com/contoso/MyProject/_build/results?buildId=2");
        let request = &ado.requests()[0];
        assert_eq!(request.query("branchName").as_deref(), Some("refs/heads/feature/x"));
        assert_eq!(request.query("$top").as_deref(), Some("20"));
    }

    #[test]
    fn maps_a_pull_request_and_drops_system_only_threads() {
        let route: Route = Box::new(|r: &Recorded| {
            let threads = json!({ "value": [
                { "id": 1, "status": "active", "comments": [{ "id": 1, "content": "Fix this", "commentType": "text" }] },
                { "id": 2, "comments": [{ "id": 1, "content": "Jane pushed", "commentType": "system" }] },
            ] });
            Some(json_response(200, if r.path.ends_with("/threads") { threads } else { rest_pr(7, json!({})) }))
        });
        let ado = fake_ado(route);
        let client = AdoClient::new(&ado, ORG);
        let pr = client.pull_request(7).unwrap();
        assert_eq!(
            (pr.id, pr.source_branch.as_str(), pr.target_branch.as_str(), pr.repo.as_str()),
            (7, "feature/x", "main", "web")
        );
        assert_eq!(pr.url, "https://dev.azure.com/contoso/MyProject/_git/web/pullrequest/7");
        let threads = client.threads(&pr).unwrap();
        assert_eq!(threads.iter().map(|t| (t.id, t.unresolved)).collect::<Vec<_>>(), [(1, true)]);
    }

    #[test]
    fn turns_statuses_into_errors_that_say_what_happened() {
        let answering = |status: u16, message: &'static str| {
            fake_ado(Box::new(move |_| Some(json_response(status, json!({ "message": message })))))
        };
        let ado = answering(404, "TF401019");
        assert_eq!(AdoClient::new(&ado, ORG).pull_request(1).unwrap_err().message, "Pull request #1 was not found.");
        let ado = answering(401, "TF400813: not authorized");
        assert_eq!(AdoClient::new(&ado, ORG).teams("P").unwrap_err().kind, Kind::Prereq);
        let ado = answering(400, "VS402323: bad");
        assert_eq!(AdoClient::new(&ado, ORG).teams("P").unwrap_err().kind, Kind::External);
    }
}
