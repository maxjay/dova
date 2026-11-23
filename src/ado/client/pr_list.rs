use super::{AdoClient, MOST};
use crate::ado::map::{reviewer, same_identity, to_pull_request, to_run, vote_of};
use crate::ado::types::{ListedPullRequest, PullRequest, Review, Run};
use crate::error::{Error, Result};
use crate::urls::{enc, my_pull_requests_url};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

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
        for ((raw, review), artifact) in found.into_iter().zip(artifacts) {
            let pr = to_pull_request(&raw, &self.org_url, project, "");
            let open_threads = *data
                .open_threads
                .get(&artifact.artifact_id)
                .ok_or_else(|| Error::external(format!("Azure DevOps omitted thread counts for PR #{}.", pr.id)))?;
            let check = data.check(&pr, format!("refs/pull/{}/merge", pr.id), &self.org_url);
            rows.push(ListedPullRequest { pr, review, open_threads, check });
        }
        Ok(rows)
    }

    fn search_pull_requests(&self, project: &str, status: &str, review: bool) -> Result<Vec<(Value, Option<Review>)>> {
        if review {
            if status != "active" {
                return Err(Error::user("Review lists only support active pull requests."));
            }
            let props = json!({
                "sourcePage": {"url": my_pull_requests_url(&self.org_url), "routeValues": {"project": project}},
                "queryIds": [DIRECT, TEAMS], "top": MOST
            });
            let data = self.contribution_data(project, &[REVIEW_LIST, MY_PROJECT_TEAMS], &props)?;
            return active_reviews(&data, project);
        }

        let path = format!("{}/_apis/git/pullrequests", enc(project));
        let top = MOST.to_string();
        let me = self.my_id()?;
        let mut page =
            self.get(&path, &[("searchCriteria.creatorId", &me), ("searchCriteria.status", status), ("$top", &top)])?;
        let rows = page["value"].as_array_mut().map(std::mem::take).ok_or_else(|| missing("pull requests"))?;
        Ok(rows.into_iter().map(|pr| (pr, None)).collect())
    }

    fn pr_list_data(
        &self,
        project_id: &str,
        project: &str,
        keywords: &str,
        artifacts: &[PrArtifact],
    ) -> Result<PrListData> {
        let props = json!({
            "sourcePage": {"url": my_pull_requests_url(&self.org_url), "routeValues": {"project": project}},
            "keywordFilter": keywords,
            "artifactIds": artifacts
        });
        let mut data = PrListData::default();
        let result = self.contribution_data(project_id, &[STATS, RUNS], &props)?;
        for stat in result[STATS][ARTIFACT_STATS].as_array().ok_or_else(|| missing("thread counts"))? {
            let artifact = stat["pullRequestArtifactId"].as_str().ok_or_else(|| missing("PR artifact ID"))?;
            let count = stat["activeCommentsCount"].as_u64().ok_or_else(|| missing("open thread count"))?;
            data.open_threads.insert(artifact.to_owned(), count);
        }
        let runs = &result[RUNS];
        for item in runs["runs"].as_array().ok_or_else(|| missing("pipeline runs"))? {
            let run = &item["run"];
            let (Some(repo), Some(branch)) = (run["repository"]["id"].as_str(), run["sourceBranch"].as_str()) else {
                continue;
            };
            data.latest.entry((repo.to_ascii_lowercase(), branch.to_owned())).or_insert_with(|| run.clone());
        }
        Ok(data)
    }
}

fn active_reviews(data: &Value, project: &str) -> Result<Vec<(Value, Option<Review>)>> {
    let list = &data[REVIEW_LIST];
    let queries = list["queries"].as_array().ok_or_else(|| missing("review queries"))?;
    let direct = queries.iter().find(|q| q["id"] == DIRECT).ok_or_else(|| missing("direct review query"))?;
    let me = direct["reviewerIds"][0].as_str().ok_or_else(|| missing("signed-in reviewer"))?;
    let mut rows = BTreeMap::new();
    for section in [DIRECT, TEAMS] {
        let result = &list["queryResults"][section];
        for id in result["ids"].as_array().ok_or_else(|| missing("review query results"))? {
            let id = id.as_u64().ok_or_else(|| missing("review PR ID"))?;
            if rows.contains_key(&id) {
                continue;
            }
            let pr = list["pullRequests"].get(id.to_string()).ok_or_else(|| missing("review PR"))?;
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
                    .as_array()
                    .ok_or_else(|| missing("review teams"))?
                    .iter()
                    .map(|t| &t["value"])
                    .find(|t| t["id"].as_str().is_some_and(|id| reviewer(pr, id).is_some()))
                    .ok_or_else(|| missing("review team"))?;
                Some(team["name"].as_str().ok_or_else(|| missing("review team name"))?.to_owned())
            } else {
                None
            };
            rows.insert(id, (pr.clone(), Some(Review { vote: vote_of(pr, me), team })));
        }
    }
    Ok(rows.into_values().rev().take(MOST).collect())
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

fn missing(field: &str) -> Error {
    Error::external(format!("Azure DevOps omitted {field} from the PR list response."))
}
