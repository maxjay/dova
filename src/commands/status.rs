//! `dova status`: one screen for the branch you're on.

use clap::Args;
use serde::Serialize;

use super::pr::{render_threads, summarize_threads, ThreadSummary};
use super::work_item_table;
use crate::ado::types::{PullRequest, Run, WorkItem, WorkItemRef};
use crate::app::App;
use crate::cli::Output;
use crate::error::{Error, Result};
use crate::par;
use crate::text::{table, Style};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    pub branch: String,
    pub pr: Option<PullRequest>,
    /// The PR's, or with no PR, the ones `dova link` recorded.
    pub work_items: Vec<WorkItemRef>,
    pub runs: Vec<Run>,
    pub threads: Vec<ThreadSummary>,
}

/// Two rounds of parallel requests: everything that doesn't need the PR, then everything that does.
pub fn branch_status(app: &App) -> Result<BranchStatus> {
    let scope = app.scope()?;
    let (project, repo, branch) = (scope.project.as_str(), scope.need_repo("status")?, scope.need_branch()?);
    let ado = app.ado(&scope.org_url);
    let linked = app.git.links(branch)?;
    let (pr, branch_runs) =
        par::join(|| ado.active_pull_request(project, repo, branch), || ado.runs(project, branch, 3));
    let (pr, branch_runs) = (pr?, branch_runs?);

    let Some(pr) = pr else {
        let work_items = WorkItemRef::list(&linked, &ado.work_items(&linked)?);
        return Ok(BranchStatus {
            branch: branch.to_string(),
            pr: None,
            work_items,
            runs: branch_runs,
            threads: Vec::new(),
        });
    };
    // PR validation builds run on the merge commit, under refs/pull/<id>/merge, and gate the merge, so they come first.
    let merge_ref = format!("refs/pull/{}/merge", pr.id);
    let (items, threads, pr_runs) =
        par::join3(|| ado.pull_request_work_items(&pr), || ado.threads(&pr), || ado.runs(project, &merge_ref, 3));
    let mut runs: Vec<Run> = Vec::new();
    for run in pr_runs?.into_iter().chain(branch_runs) {
        if runs.len() < 3 && !runs.iter().any(|seen| seen.id == run.id) {
            runs.push(run);
        }
    }
    Ok(BranchStatus {
        branch: branch.to_string(),
        work_items: items?.iter().map(WorkItem::to_ref).collect(),
        runs,
        threads: summarize_threads(threads?),
        pr: Some(pr),
    })
}

fn render(r: &BranchStatus, s: Style) -> String {
    let mut out = vec![s.bold(&format!("Branch: {}", r.branch)), String::new()];
    match &r.pr {
        Some(pr) => out.extend([
            s.bold("Pull Request"),
            format!("  #{} {}{}", pr.id, pr.title, if pr.is_draft { s.dim(" [draft]") } else { String::new() }),
            s.dim(&format!("  {} · {} · into {}", pr.status, pr.author, pr.target_branch)),
            s.dim(&format!("  {}", pr.url)),
        ]),
        None => out.push(s.dim("No active pull request.")),
    }
    let run_row = |run: &Run| {
        vec![
            run.name.clone(),
            s.outcome(run.outcome()),
            run.queued_at.clone().unwrap_or_else(|| "?".into()),
            s.dim(&run.url),
        ]
    };
    let runs: Vec<Vec<String>> = r.runs.iter().map(run_row).collect();
    out.extend([
        String::new(),
        s.bold("Work Items"),
        if r.work_items.is_empty() { s.dim("  (none — see `dova link`)") } else { work_item_table(&r.work_items) },
        String::new(),
        s.bold("Pipeline Runs"),
        if runs.is_empty() { s.dim("  (none)") } else { table(&["Pipeline", "Result", "Queued", "URL"], &runs) },
    ]);
    if let Some(pr) = &r.pr {
        out.push(String::new());
        out.extend(render_threads(s, pr.id, &r.threads, false));
    }
    out.join("\n")
}

#[derive(Args)]
pub struct Status {
    /// Open the branch's PR in the browser
    #[arg(short, long)]
    pub web: bool,
}

impl Status {
    pub fn run(&self, app: &App) -> Result<Output> {
        let status = branch_status(app)?;
        let output = Output::new(&status, render(&status, app.style));
        match (&status.pr, self.web) {
            (Some(pr), _) => Ok(output.web(self.web, &pr.url)),
            (None, true) => Err(Error::not_found(format!("No active pull request for branch \"{}\".", status.branch))),
            (None, false) => Ok(output),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::testing::{batch, cli, ok, rest_pr, wi, Bed, GitOpts, Recorded};

    #[test]
    fn without_a_pr_the_linked_work_items_branch_runs_no_threads_in_one_round() {
        let bed = Bed::new(Box::new(|r: &Recorded| {
            if r.path.ends_with("/pullrequests") {
                ok(json!({ "value": [] }))
            } else if r.path.ends_with("/builds") {
                let build = json!({ "id": 5, "status": "completed", "result": "failed", "sourceBranch": "refs/heads/feature/x" });
                ok(json!({ "value": [build] }))
            } else {
                batch(vec![wi(11, json!({}))])(r)
            }
        }))
        .git(GitOpts::linked());
        let res = cli(bed.app(), &["status", "--json"]);
        assert_eq!(res.code, 0, "{}", res.stderr);
        let status = res.json();
        assert_eq!(
            (&status["branch"], &status["pr"], &status["threads"]),
            (&json!("feature/x"), &json!(null), &json!([]))
        );
        let known = json!({ "id": 11, "title": "Item 11", "type": "Task", "state": "Active" });
        let gone = json!({ "id": 12, "title": null, "type": null, "state": null });
        assert_eq!(status["workItems"], json!([known, gone]));
        assert_eq!((&status["runs"][0]["id"], &status["runs"][0]["result"]), (&json!(5), &json!("failed")));
        assert_eq!(bed.ado.requests().iter().filter(|r| r.path.ends_with("/builds")).count(), 1);

        let text = cli(bed.app(), &["status"]).stdout;
        assert!(
            text.contains("No active pull request.") && text.contains("│ #11 │ Task │ Item 11 │ Active │"),
            "{text}"
        );
        assert_eq!(cli(bed.app(), &["status", "--web"]).code, 2);
    }

    #[test]
    fn with_a_pr_its_work_items_validation_runs_first_open_threads_first() {
        let bed = Bed::new(Box::new(|r: &Recorded| {
            if r.path.ends_with("/pullrequests") {
                ok(json!({ "value": [rest_pr(7, json!({}))] }))
            } else if r.path.ends_with("/builds") {
                let id = if r.query("branchName").unwrap().contains("pull") { 2 } else { 1 };
                ok(json!({ "value": [{ "id": id, "status": "completed", "result": "succeeded" }] }))
            } else if r.path.ends_with("/workitems") {
                ok(json!({ "value": [{ "id": "30" }] }))
            } else if r.path.ends_with("/threads") {
                ok(json!({ "value": [
                    { "id": 1, "status": "fixed", "comments": [{ "id": 1, "content": "ok" }] },
                    { "id": 2, "status": "active", "comments": [{ "id": 1, "content": "fix", "author": { "displayName": "Ann" } }] },
                ] }))
            } else {
                batch(vec![wi(30, json!({}))])(r)
            }
        }));
        let status = cli(bed.app(), &["status", "--json"]).json();
        let ids =
            |key: &str| status[key].as_array().unwrap().iter().map(|x| x["id"].as_u64().unwrap()).collect::<Vec<_>>();
        assert_eq!(status["pr"]["id"], 7);
        assert_eq!((ids("workItems"), ids("runs"), ids("threads")), (vec![30], vec![2, 1], vec![2, 1]));
        assert_eq!(cli(bed.app(), &["status", "--web"]).stdout, "");
    }
}
