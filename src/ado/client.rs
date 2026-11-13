//! Azure DevOps as typed calls against one organization (REST api-version 7.1).

use serde_json::{json, Value};
use url::Url;

use super::map::{
    is_discussion, to_pull_request, to_run, to_thread, to_timeline_record, to_work_item, WORK_ITEM_FIELDS,
};
use super::types::{PullRequest, Run, TeamAreas, Thread, TimelineRecord, WorkItem};
use super::{Method, Request, Response, Transport};
use crate::error::{Error, Kind, Result};
use crate::par;
use crate::urls::{enc, unique};

/// The most ids the work items batch endpoint takes.
const BATCH: usize = 200;
const JSON: &str = "application/json";

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
        let fields = [
            ("System.Title", Some(&item.title)),
            ("System.AreaPath", item.area_path.as_ref()),
            ("System.IterationPath", item.iteration_path.as_ref()),
            ("System.Description", item.description.as_ref()),
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

    pub fn pull_request_work_items(&self, pr: &PullRequest) -> Result<Vec<WorkItem>> {
        let res = self.get(&pr_path(pr, "workitems"), &[])?;
        let ids: Vec<u64> = list(&res["value"])
            .iter()
            .filter_map(|r| r["id"].as_u64().or_else(|| r["id"].as_str()?.parse().ok()))
            .collect();
        self.work_items(&ids)
    }

    pub fn threads(&self, pr: &PullRequest) -> Result<Vec<Thread>> {
        let res = self.get(&pr_path(pr, "threads"), &[])?;
        Ok(list(&res["value"]).iter().filter(|t| is_discussion(t)).map(to_thread).collect())
    }

    pub fn thread(&self, pr: &PullRequest, id: u64) -> Result<Thread> {
        let raw = self.get_or(&pr_path(pr, &format!("threads/{id}")), || {
            format!("Thread #{id} was not found on PR #{}.", pr.id)
        })?;
        Ok(to_thread(&raw))
    }

    pub fn add_comment(&self, pr: &PullRequest, text: &str) -> Result<Thread> {
        let body = json!({ "comments": [{ "parentCommentId": 0, "content": text, "commentType": "text" }], "status": "active" });
        Ok(to_thread(&self.call(Method::Post, &pr_path(pr, "threads"), &[], Some((&body, JSON)))?))
    }

    /// Nested under the thread's last comment, so it lands in the actual conversation.
    pub fn reply(&self, pr: &PullRequest, thread_id: u64, text: &str) -> Result<()> {
        let parent = self.thread(pr, thread_id)?.comments.last().map_or(1, |c| c.id);
        let body = json!({ "content": text, "commentType": "text", "parentCommentId": parent });
        self.call(Method::Post, &pr_path(pr, &format!("threads/{thread_id}/comments")), &[], Some((&body, JSON)))
            .map(drop)
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
    /// Re-filtered on each run's own branch (another ref's run shown as this
    /// branch's CI is worse than none), so it over-fetches.
    pub fn runs(&self, project: &str, reference: &str, top: usize) -> Result<Vec<Run>> {
        let wanted = head_ref(reference);
        let fetch = (top * 4).max(20).to_string();
        let query = [("branchName", wanted.as_str()), ("$top", fetch.as_str()), ("queryOrder", "queueTimeDescending")];
        let res = self.get(&format!("{}/_apis/build/builds", enc(project)), &query)?;
        let ours = |b: &&Value| b["sourceBranch"].as_str().map_or(true, |branch| branch == wanted);
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
        let user = &self.get("_apis/connectionData", &[("api-version", "7.1-preview")])?["authenticatedUser"];
        Ok(user["properties"]["Account"]["$value"]
            .as_str()
            .or(user["providerDisplayName"].as_str())
            .map(str::to_string))
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
        self.send(&Request { method, url, body, content_type, text: false })
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
            text: false,
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
    fn keeps_only_runs_for_the_ref_asked_about_even_if_the_service_sends_others() {
        let builds = json!({ "value": [{ "id": 1, "status": "completed", "sourceBranch": "refs/heads/other" }, { "id": 2, "status": "completed", "sourceBranch": "refs/heads/feature/x" }] });
        let ado = fake_ado(Box::new(move |_| Some(json_response(200, builds.clone()))));
        let runs = AdoClient::new(&ado, ORG).runs("MyProject", "feature/x", 3).unwrap();
        assert_eq!(runs.iter().map(|r| r.id).collect::<Vec<_>>(), [2]);
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
