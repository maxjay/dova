//! `dova summarize`: a catch-up on a branch or PR — why it exists (its
//! tickets), what happened (commits), and how big it is (the diff).

use clap::Args;
use serde::Serialize;

use super::pr::find_pull_request;
use crate::ado::types::WorkItem;
use crate::app::App;
use crate::cli::Output;
use crate::error::{Error, Result};
use crate::text::{truncate, Style};
use crate::urls::{looks_like_url, parse_id};

#[derive(Args, Default)]
pub struct Summarize {
    /// Branch name, PR id or PR link (default: the current branch)
    pub target: Option<String>,
    /// Compare against this (default: the PR's target, else the repo's default branch)
    #[arg(long, value_name = "BRANCH")]
    pub base: Option<String>,
    /// Full commit messages and the whole diff
    #[arg(long)]
    pub full: bool,
    /// The actual diff, for just these paths
    #[arg(long, value_name = "PATHS", num_args = 1..)]
    pub files: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Commit {
    pub sha: String,
    pub subject: String,
}

/// Work not committed yet, which the diff of the branch can't show.
#[derive(Debug, Serialize)]
pub struct Uncommitted {
    pub stat: String,
    pub untracked: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub branch: String,
    /// What it's compared against…
    pub base: String,
    /// …and why that: flag | pr-target | origin-head | repo-default.
    pub base_source: &'static str,
    pub work_items: Vec<WorkItem>,
    pub commits: Vec<Commit>,
    pub diff_stat: String,
    /// With --full or --files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    /// With --full.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
    /// Only for the checked-out branch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncommitted: Option<Uncommitted>,
}

impl Summarize {
    pub fn summarize(&self, app: &App) -> Result<Summary> {
        let mut branch = self.target.clone();
        let mut base: Option<(String, &'static str)> = self.base.clone().map(|base| (base, "flag"));
        if let Some(target) = self.target.as_deref().filter(|t| looks_like_url(t) || parse_id(t).is_some()) {
            let (pr, _) = find_pull_request(app, Some(target))?;
            branch = Some(pr.source_branch);
            base = base.or(Some((pr.target_branch, "pr-target")));
        }
        let scope = app.scope()?;
        let branch = branch
            .or_else(|| scope.branch.clone())
            .ok_or_else(|| Error::user("Not on a branch — pass a branch, PR id or PR link."))?;
        let ado = app.ado(&scope.org_url);

        if let (None, Some(repo)) = (&base, &scope.repo) {
            base = ado.active_pull_request(&scope.project, repo, &branch)?.map(|pr| (pr.target_branch, "pr-target"));
        }
        if base.is_none() {
            base = match (app.git.origin_head()?, &scope.repo) {
                (Some(head), _) => Some((head, "origin-head")),
                (None, Some(repo)) => {
                    ado.default_branch(&scope.project, repo)?.map(|default| (default, "repo-default"))
                }
                (None, None) => None,
            };
        }
        let (base, base_source) = base.ok_or_else(|| {
            Error::user(format!("Could not tell what to compare \"{branch}\" against.")).hint("Pass --base <branch>.")
        })?;

        let git = &app.git;
        let head = git.readable_ref(&branch)?;
        let base = if git.has_ref(&format!("origin/{base}"))? { format!("origin/{base}") } else { base };
        let work_items = ado.work_items(&git.links(&branch)?)?;
        let want_diff = self.full || !self.files.is_empty();
        let (since, range) = (format!("{base}..{head}"), format!("{base}...{head}"));
        // `git <args> [-- <paths>]`, empty when git has nothing to say.
        let read = |args: &[&str], paths: bool| {
            let mut args = args.to_vec();
            if paths && !self.files.is_empty() {
                args.push("--");
                args.extend(self.files.iter().map(String::as_str));
            }
            git.try_run(&args).map(Option::unwrap_or_default)
        };

        let log = read(&["log", "--format=%H%x09%s", &since], false)?;
        let mut summary = Summary {
            base_source,
            work_items,
            commits: log
                .lines()
                .filter_map(|line| line.split_once('\t'))
                .map(|(sha, subject)| Commit { sha: sha.to_string(), subject: subject.to_string() })
                .collect(),
            diff_stat: read(&["diff", "--stat", &range], true)?,
            diff: if want_diff { Some(read(&["diff", &range], true)?) } else { None },
            log: if self.full { Some(read(&["log", &since], false)?) } else { None },
            uncommitted: None,
            branch,
            base,
        };
        if scope.branch.as_deref() == Some(summary.branch.as_str()) {
            let stat = read(&["diff", "--stat", "HEAD"], true)?;
            let mut untracked = vec!["ls-files", "--others", "--exclude-standard"];
            untracked.extend(self.files.iter().map(String::as_str));
            let untracked = git.try_run(&untracked)?.unwrap_or_default();
            if !stat.is_empty() || !untracked.is_empty() {
                let diff =
                    if want_diff { Some(read(&["diff", "HEAD"], true)?).filter(|d| !d.is_empty()) } else { None };
                summary.uncommitted =
                    Some(Uncommitted { stat, untracked: untracked.lines().map(str::to_string).collect(), diff });
            }
        }
        Ok(summary)
    }

    pub fn run(&self, app: &App) -> Result<Output> {
        let summary = self.summarize(app)?;
        Ok(Output::new(&summary, render(&summary, app.style, self.full)))
    }
}

fn render(r: &Summary, s: Style, full: bool) -> String {
    let or = |text: &str, empty: &str| if text.is_empty() { s.dim(empty) } else { text.to_string() };
    let mut out =
        vec![s.bold(&format!("Branch: {}", r.branch)), s.dim(&format!("compared against {}", r.base)), String::new()];
    if r.work_items.is_empty() {
        out.push(s.dim("(no linked work items — see `dova link`)"));
    }
    for w in &r.work_items {
        let label = |v: &Option<String>| v.clone().unwrap_or_else(|| "?".into());
        out.push(s.bold(&format!("#{} [{}/{}] {}", w.id, label(&w.kind), label(&w.state), label(&w.title))));
        for section in &w.body {
            let (shown, cut) = if full { (section.text.clone(), false) } else { truncate(&section.text, 500) };
            out.extend([s.dim(&format!("{}:", section.label)), shown]);
            if cut {
                out.push(s.dim("  … --full for the rest"));
            }
        }
        out.push(String::new());
    }
    let commits: Vec<String> =
        r.commits.iter().map(|c| format!("  {} {}", s.dim(&c.sha[..c.sha.len().min(7)]), c.subject)).collect();
    out.extend([
        s.bold(&format!("Commits ({})", r.commits.len())),
        r.log.clone().unwrap_or_else(|| or(&commits.join("\n"), "  (none)")),
        String::new(),
        s.bold("Diff"),
        or(r.diff.as_deref().unwrap_or(&r.diff_stat), "  (no changes)"),
    ]);
    if let Some(uncommitted) = &r.uncommitted {
        out.extend([
            String::new(),
            s.bold("Uncommitted") + &s.dim(" — in the working tree, not in the diff above"),
            uncommitted.diff.clone().unwrap_or_else(|| uncommitted.stat.clone()),
        ]);
        out.extend(uncommitted.untracked.iter().map(|file| format!("  {} {file}", s.green("?"))));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::testing::{batch, cli, ok, rest_pr, wi, Bed, GitOpts};

    #[test]
    fn compares_against_the_prs_target_with_the_branchs_tickets_and_commits() {
        let git = GitOpts::linked()
            .answer("rev-parse --verify --quiet refs/heads/feature/x", "abc")
            .answer("rev-parse --verify --quiet origin/main", "def")
            .answer("log --format=%H%x09%s origin/main..feature/x", &format!("{}\tFirst", "a".repeat(40)))
            .answer("diff --stat origin/main...feature/x", " a.ts | 2 +-")
            .answer("ls-files --others --exclude-standard", "notes.txt");
        let bed = Bed::new(Box::new(|r| {
            if r.path.ends_with("/pullrequests") {
                ok(json!({ "value": [rest_pr(7, json!({}))] }))
            } else {
                batch(vec![wi(11, json!({})), wi(12, json!({}))])(r)
            }
        }))
        .git(git);
        let summary = cli(bed.app(), &["summarize", "--json"]).json();
        assert_eq!(
            (summary["base"].as_str(), summary["baseSource"].as_str()),
            (Some("origin/main"), Some("pr-target"))
        );
        assert_eq!(summary["commits"], json!([{ "sha": "a".repeat(40), "subject": "First" }]));
        assert_eq!(summary["diffStat"], " a.ts | 2 +-");
        assert_eq!(
            (&summary["workItems"][0]["id"], &summary["workItems"][1]["title"]),
            (&json!(11), &json!("Item 12"))
        );
        assert_eq!(summary["uncommitted"], json!({ "stat": "", "untracked": ["notes.txt"] }));
        assert!(summary.get("diff").is_none());

        let text = cli(bed.app(), &["summarize"]).stdout;
        assert!(
            text.contains("#12 [Task/Active] Item 12")
                && text.contains("  aaaaaaa First")
                && text.contains("  ? notes.txt"),
            "{text}"
        );
    }

    #[test]
    fn says_what_to_pass_when_there_is_nothing_to_compare_against() {
        let bed = Bed::new(Box::new(|r| {
            if r.path.ends_with("/pullrequests") {
                ok(json!({ "value": [] }))
            } else {
                ok(json!({}))
            }
        }));
        let res = cli(bed.app(), &["summarize"]);
        assert_eq!((res.code, res.stderr.contains("--base <branch>")), (1, true), "{}", res.stderr);
    }
}
