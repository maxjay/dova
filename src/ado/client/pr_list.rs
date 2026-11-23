//! Project PR search and the review counts and pipeline checks shown on each row.

use super::{AdoClient, MOST};
use crate::ado::map::{reviewer, same_identity, to_pull_request, to_run, vote_of};
use crate::ado::types::{ListedPullRequest, PullRequest, Review, Run};
use crate::error::{Error, Result};
use crate::par;
use crate::urls::{enc, my_pull_requests_url};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

const REVIEWERS_AT_ONCE: usize = 8;
const REVIEW_LIST: &str = "ms.vss-code-web.prs-list-data-provider";
const MY_PROJECT_TEAMS: &str = "ms.vss-dashboards-web.my-team-list-data-provider";
const DIRECT: &str = "AssignedToMe";
const TEAMS: &str = "AssignedToMyTeams";
const STATS: &str = "ms.vss-code-web.pullrequests-artifact-stats-data-provider";
const RUNS: &str = "ms.vss-build-web.runs-data-provider";
const ARTIFACT_STATS: &str = "TFS.VersionControl.PullRequestListArtifactStatsProvider.artifactStats";

impl AdoClient<'_> {
    pub fn list_pull_requests(&self, project: &str, status: &str, review: bool) -> Result<Vec<ListedPullRequest>> {
        let found = self.search_pull_requests(project, status, review)?;
        let Some((first, _)) = found.first() else { return Ok(Vec::new()) };
        let project_id = first["repository"]["project"]["id"].as_str().ok_or_else(|| missing("project ID"))?.to_owned();
        let mut artifacts = Vec::with_capacity(found.len());
        let mut refs = Vec::with_capacity(found.len());
        for (raw, _) in &found {
            let id = raw["pullRequestId"].as_u64().ok_or_else(|| missing("pull request ID"))?;
            let repo = raw["repository"]["id"].as_str().ok_or_else(|| missing("repository ID"))?;
            let (kind, review_id) = if raw["supportsIterations"] == true {
                ("ReviewId", raw["codeReviewId"].as_u64().ok_or_else(|| missing("code review ID"))?)
            } else {
                ("CodeReviewId", id)
            };
            artifacts.push(PrArtifact {
                artifact_id: format!("vstfs:///Git/PullRequestId/{project_id}%2F{repo}%2F{id}"),
                discussion_artifact_id: format!("vstfs:///CodeReview/{kind}/{project_id}%2F{review_id}"),
            });
            refs.push(format!("refs/pull/{id}/merge"));
        }

        let data = self.pr_list_data(&project_id, project, &refs.join(","), &artifacts)?;
        let mut rows = Vec::with_capacity(found.len());
        let mut fallback = Vec::new();
        for ((raw, review), artifact) in found.into_iter().zip(artifacts) {
            let pr = to_pull_request(&raw, &self.org_url, project, "");
            let open_threads = *data
                .open_threads
                .get(&artifact.artifact_id)
                .ok_or_else(|| Error::external(format!("Azure DevOps omitted thread counts for PR #{}.", pr.id)))?;
            let check = data.check(&pr, format!("refs/pull/{}/merge", pr.id), &self.org_url);
            if check.is_none() {
                let source = raw["sourceRefName"].as_str().ok_or_else(|| missing("source ref"))?;
                fallback.push((rows.len(), source.to_owned()));
            }
            rows.push(ListedPullRequest { pr, review, open_threads, check });
        }
        if !fallback.is_empty() {
            let mut refs: Vec<_> = fallback.iter().map(|(_, source)| source.as_str()).collect();
            refs.sort_unstable();
            refs.dedup();
            let sources = self.pr_list_data(&project_id, project, &refs.join(","), &[])?;
            for (index, source) in fallback {
                let row = &mut rows[index];
                row.check = sources.check(&row.pr, source, &self.org_url);
            }
        }
        Ok(rows)
    }

    fn search_pull_requests(&self, project: &str, status: &str, review: bool) -> Result<Vec<(Value, Option<Review>)>> {
        if review && status == "active" {
            let props = json!({
                "sourcePage": {"url": my_pull_requests_url(&self.org_url), "routeValues": {"project": project}},
                "queryIds": [DIRECT, TEAMS], "top": MOST
            });
            let data = self.contribution_data(project, &[REVIEW_LIST, MY_PROJECT_TEAMS], &props, true)?;
            if let Some(rows) = active_reviews(&data, project) {
                return Ok(rows);
            }
        }

        let path = format!("{}/_apis/git/pullrequests", enc(project));
        let top = MOST.to_string();
        let search = |filter: Option<(&str, &str)>| -> Result<Vec<Value>> {
            let mut query = vec![("searchCriteria.status", status), ("$top", top.as_str())];
            query.extend(filter);
            let mut page = self.get(&path, &query)?;
            page["value"].as_array_mut().map(std::mem::take).ok_or_else(|| missing("pull requests"))
        };
        if !review {
            let rows = search(Some(("searchCriteria.creatorId", &self.my_id()?)))?;
            return Ok(rows.into_iter().map(|pr| (pr, None)).collect());
        }

        // A complete project page already contains the reviewers. On large histories use
        // Azure's reviewer index instead of downloading the rest of the project.
        let mut prs = search(None)?;
        if prs.is_empty() {
            return Ok(Vec::new());
        }
        let me = self.my_id()?;
        let large = prs.len() >= MOST;
        let needs_team = |pr: &Value| {
            !same_identity(&pr["createdBy"]["id"], &me)
                && reviewer(pr, &me).is_none()
                && super::list(&pr["reviewers"]).iter().any(|r| r["isContainer"] == true)
        };
        let teams = if large || prs.iter().any(needs_team) { self.my_teams()? } else { Vec::new() };
        if large {
            prs.clear();
            let ids: Vec<_> = std::iter::once(&me).chain(teams.iter().map(|(id, _)| id)).collect();
            for group in ids.chunks(REVIEWERS_AT_ONCE) {
                for page in par::map(group, |id| search(Some(("searchCriteria.reviewerId", id)))) {
                    prs.extend(page?);
                }
            }
        }

        let mut found = BTreeMap::new();
        for pr in prs {
            let team = if reviewer(&pr, &me).is_some() {
                None
            } else {
                if same_identity(&pr["createdBy"]["id"], &me) {
                    continue;
                }
                let Some((_, name)) = teams.iter().find(|(id, _)| reviewer(&pr, id).is_some()) else { continue };
                Some(name.clone())
            };
            let id = pr["pullRequestId"].as_u64().ok_or_else(|| missing("pull request ID"))?;
            let review = Review { vote: vote_of(&pr, &me), team };
            found.insert(id, (pr, Some(review)));
        }
        Ok(found.into_values().rev().take(MOST).collect())
    }

    fn pr_list_data(
        &self,
        project_id: &str,
        project: &str,
        keywords: &str,
        artifacts: &[PrArtifact],
    ) -> Result<PrListData> {
        let mut props = json!({
            "sourcePage": {"url": my_pull_requests_url(&self.org_url), "routeValues": {"project": project}},
            "keywordFilter": keywords
        });
        let mut data = PrListData::default();
        let mut result = if artifacts.is_empty() {
            self.contribution_data(project_id, &[RUNS], &props, false)?
        } else {
            let mut first = props.clone();
            first["artifactIds"] = json!(artifacts);
            let page = self.contribution_data(project_id, &[STATS, RUNS], &first, false)?;
            for stat in page[STATS][ARTIFACT_STATS].as_array().ok_or_else(|| missing("thread counts"))? {
                let artifact = stat["pullRequestArtifactId"].as_str().ok_or_else(|| missing("PR artifact ID"))?;
                let count = stat["activeCommentsCount"].as_u64().ok_or_else(|| missing("open thread count"))?;
                data.open_threads.insert(artifact.to_owned(), count);
            }
            page
        };
        loop {
            let runs = &result[RUNS];
            for item in runs["runs"].as_array().ok_or_else(|| missing("pipeline runs"))? {
                let run = &item["run"];
                let (Some(repo), Some(branch)) = (run["repository"]["id"].as_str(), run["sourceBranch"].as_str())
                else {
                    continue;
                };
                let key = (repo.to_ascii_lowercase(), branch.to_owned());
                let previous = data.latest.entry(key).or_default();
                if previous.is_null() || queued(run) > queued(previous) {
                    *previous = run.clone();
                }
            }
            let next = &runs["continuationToken"];
            if next.is_null() || next == "" {
                return Ok(data);
            }
            if next == &props["continuationToken"] {
                return Err(Error::external("Azure DevOps repeated the pipeline runs page."));
            }
            props["continuationToken"] = next.clone();
            result = self.contribution_data(project_id, &[RUNS], &props, false)?;
        }
    }
}

/// Read the two default review sections. Use REST discovery when a saved section narrows
/// the list, a section has more results, or a team from another project needs to be resolved.
fn active_reviews(data: &Value, project: &str) -> Option<Vec<(Value, Option<Review>)>> {
    let list = &data[REVIEW_LIST];
    if list["partialResults"] == true {
        return None;
    }
    let queries = list["queries"].as_array()?;
    let section = |id: &str| queries.iter().find(|q| q["id"] == id);
    let direct = section(DIRECT)?;
    let team_query = section(TEAMS)?;
    if direct["readonly"] != true
        || direct["status"] != 1
        || team_query["myTeamsAsReviewer"] != true
        || team_query["status"] != 1
        || team_query.as_object()?.keys().any(|k| {
            !matches!(
                k.as_str(),
                "id" | "title" | "status" | "myTeamsAsReviewer" | "includeDuplicates" | "readonly" | "groupByVote"
            )
        })
    {
        return None;
    }
    let me = direct["reviewerIds"][0].as_str()?;
    let mut rows = BTreeMap::new();
    for section in [DIRECT, TEAMS] {
        let result = &list["queryResults"][section];
        if result["hasMore"] == true {
            return None;
        }
        for id in result["ids"].as_array()? {
            let id = id.as_u64()?;
            if rows.contains_key(&id) {
                continue;
            }
            let pr = list["pullRequests"].get(id.to_string())?;
            let scope = &pr["repository"]["project"];
            if !same_identity(&scope["id"], project) && !same_identity(&scope["name"], project) {
                continue;
            }
            let named = section == DIRECT || reviewer(pr, me).is_some();
            let team = if !named {
                if same_identity(&pr["createdBy"]["id"], me) {
                    continue;
                }
                let team = data[MY_PROJECT_TEAMS]
                    .as_array()?
                    .iter()
                    .map(|t| &t["value"])
                    .find(|t| t["id"].as_str().is_some_and(|id| reviewer(pr, id).is_some()))?;
                Some(team["name"].as_str()?.to_owned())
            } else {
                None
            };
            rows.insert(id, (pr.clone(), Some(Review { vote: vote_of(pr, me), team })));
        }
    }
    Some(rows.into_values().rev().take(MOST).collect())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrArtifact {
    artifact_id: String,
    discussion_artifact_id: String,
}

#[derive(Default)]
struct PrListData {
    open_threads: HashMap<String, u64>,
    latest: HashMap<(String, String), Value>,
}

impl PrListData {
    fn check(&self, pr: &PullRequest, branch: String, org_url: &str) -> Option<Run> {
        let key = (pr.repo_id.as_ref()?.to_ascii_lowercase(), branch);
        self.latest.get(&key).map(|raw| to_run(raw, org_url, &pr.project))
    }
}

// Azure queue times are UTC with optional fractional seconds. Keep that precision until the winner is known.
fn queued(raw: &Value) -> (&str, Option<u64>) {
    (raw["queueTime"].as_str().unwrap_or("").trim_end_matches('Z'), raw["id"].as_u64())
}

fn missing(field: &str) -> Error {
    Error::external(format!("Azure DevOps omitted {field} from the PR list response."))
}
