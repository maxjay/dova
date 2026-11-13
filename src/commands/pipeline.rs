//! Pipeline runs: what ran, why it failed, and waiting for one to finish.

use std::time::Duration;

use clap::{Args, Subcommand};
use serde::Serialize;
use serde_json::json;

use crate::ado::client::AdoClient;
use crate::ado::types::Run;
use crate::app::{App, Scope};
use crate::cli::Output;
use crate::error::{Error, Result};
use crate::par;
use crate::text::{table, tail};
use crate::urls::parse_id;

/// A run by id, or the latest one of a branch (the checked-out one unless `--branch`).
fn find_run<'a>(app: &'a App, run: Option<&str>, branch: Option<&str>) -> Result<(Scope, AdoClient<'a>, Run)> {
    let scope = app.scope()?;
    let ado = app.ado(&scope.org_url);
    let run = match run {
        Some(given) => ado
            .run(&scope.project, parse_id(given).ok_or_else(|| Error::user(format!("\"{given}\" isn't a run id.")))?)?,
        None => {
            let branch = branch
                .or(scope.branch.as_deref())
                .ok_or_else(|| Error::user("No run id, and not on a branch.").hint("Pass a run id or --branch."))?;
            ado.runs(&scope.project, branch, 1)?
                .pop()
                .ok_or_else(|| Error::not_found(format!("No pipeline runs for branch \"{branch}\".")))?
        }
    };
    Ok((scope, ado, run))
}

#[derive(Args)]
pub struct List {
    /// Another branch
    #[arg(long)]
    pub branch: Option<String>,
}

#[derive(Args)]
pub struct Log {
    /// Run id (default: the current branch's latest run)
    pub run: Option<String>,
    /// Latest run of another branch
    #[arg(long)]
    pub branch: Option<String>,
    /// This failed task
    #[arg(long, value_name = "NAME")]
    pub task: Option<String>,
    /// Every failed task
    #[arg(long)]
    pub all: bool,
    /// Whole logs, not the last 200 lines
    #[arg(long)]
    pub full: bool,
}

#[derive(Args)]
pub struct Watch {
    /// Run id (default: the current branch's latest run)
    pub run: Option<String>,
    /// Latest run of another branch
    #[arg(long)]
    pub branch: Option<String>,
}

#[derive(Serialize)]
struct TaskLog {
    task: String,
    text: String,
}

#[derive(Subcommand)]
pub enum Pipeline {
    /// Recent runs for the current branch
    List(List),
    /// Why a run failed: the failed task's log
    Log(Log),
    /// Follow a run until it finishes; fails if it didn't succeed
    Watch(Watch),
}

impl Pipeline {
    pub fn run(&self, app: &App) -> Result<Output> {
        match self {
            Pipeline::List(c) => c.run(app),
            Pipeline::Log(c) => c.run(app),
            Pipeline::Watch(c) => c.run(app),
        }
    }
}

impl List {
    fn run(&self, app: &App) -> Result<Output> {
        let scope = app.scope()?;
        let branch = self
            .branch
            .as_deref()
            .or(scope.branch.as_deref())
            .ok_or_else(|| Error::user("Not on a branch — pass --branch."))?;
        let runs = app.ado(&scope.org_url).runs(&scope.project, branch, 10)?;
        let s = app.style;
        let row = |run: &Run| {
            vec![
                run.id.to_string(),
                run.name.clone(),
                s.outcome(run.outcome()),
                run.queued_at.clone().unwrap_or_else(|| "?".into()),
            ]
        };
        let text = if runs.is_empty() {
            s.dim(&format!("No runs for \"{branch}\"."))
        } else {
            table(&["Run", "Pipeline", "Result", "Queued"], &runs.iter().map(row).collect::<Vec<_>>())
        };
        Ok(Output::new(&json!({ "branch": branch, "runs": runs }), text))
    }
}

impl Log {
    fn run(&self, app: &App) -> Result<Output> {
        let (scope, ado, run) = find_run(app, self.run.as_deref(), self.branch.as_deref())?;
        let mut failed: Vec<_> = ado
            .timeline(&scope.project, run.id)?
            .into_iter()
            .filter(|r| r.result.as_deref() == Some("failed") && r.log_id.is_some())
            .collect();
        failed.sort_by(|a, b| a.start_time.cmp(&b.start_time));
        // Every failed task is named; only the first (or --task, or --all) has its log fetched.
        let picked: Vec<_> = match &self.task {
            Some(task) => {
                let named: Vec<_> = failed.iter().filter(|r| r.name.eq_ignore_ascii_case(task)).collect();
                if named.is_empty() {
                    let names: Vec<&str> = failed.iter().map(|f| f.name.as_str()).collect();
                    let names = if names.is_empty() { "none".to_string() } else { names.join(", ") };
                    return Err(Error::not_found(format!("No failed task \"{task}\" in run #{}.", run.id))
                        .hint(format!("Failed: {names}")));
                }
                named
            }
            None => failed.iter().take(if self.all { usize::MAX } else { 1 }).collect(),
        };
        let fetched = par::map(&picked, |record| ado.log(&scope.project, run.id, record.log_id.unwrap_or(0)));
        let logs = picked
            .iter()
            .zip(fetched)
            .map(|(record, text)| Ok(TaskLog { task: record.name.clone(), text: text? }))
            .collect::<Result<Vec<_>>>()?;
        let failed_tasks: Vec<&str> = failed.iter().map(|f| f.name.as_str()).collect();

        let s = app.style;
        let mut out = Vec::new();
        if logs.is_empty() {
            out.push(s.dim(&format!("Nothing failed in run #{} ({}).", run.id, run.outcome())));
        }
        for log in &logs {
            let (shown, cut, total) = if self.full { (log.text.clone(), false, 0) } else { tail(&log.text, 200) };
            out.extend([s.bold(&log.task), shown]);
            if cut {
                out.push(s.dim(&format!("… last 200 of {total} lines — --full for all")));
            }
            out.push(String::new());
        }
        let others: Vec<&str> =
            failed_tasks.iter().copied().filter(|task| !logs.iter().any(|l| l.task == *task)).collect();
        if !others.is_empty() {
            out.push(s.yellow(&format!(
                "{} more failed: {} (--all, or --task <name>)",
                others.len(),
                others.join(", ")
            )));
        }
        out.push(s.dim(&run.url));
        Ok(Output::new(&json!({ "run": run, "failedTasks": failed_tasks, "logs": logs }), out.join("\n")))
    }
}

impl Watch {
    fn run(&self, app: &App) -> Result<Output> {
        let (scope, ado, mut run) = find_run(app, self.run.as_deref(), self.branch.as_deref())?;
        app.note(&format!("Watching #{} {} — {}", run.id, run.name, run.url));
        let mut last = String::new();
        loop {
            if run.outcome() != last {
                last = run.outcome().to_string();
                app.note(&format!("  {last}"));
            }
            if run.status == "completed" {
                break;
            }
            std::thread::sleep(Duration::from_secs(5));
            run = ado.run(&scope.project, run.id)?;
        }
        if run.result.as_deref() != Some("succeeded") {
            return Err(Error::external(format!("Run #{} finished: {}.", run.id, run.outcome())));
        }
        Ok(Output::new(&run, format!("{} {}", app.style.bold("Finished:"), app.style.outcome(run.outcome()))))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::ado::Response;
    use crate::testing::{cli, ok, Bed, Recorded, Route};

    fn failed_run() -> Route {
        Box::new(|r: &Recorded| {
            if r.path.ends_with("/builds") {
                ok(
                    json!({ "value": [{ "id": 9, "status": "completed", "result": "failed", "definition": { "name": "CI" }, "sourceBranch": "refs/heads/feature/x" }] }),
                )
            } else if r.path.ends_with("/timeline") {
                ok(json!({ "records": [
                    { "name": "Lint", "result": "failed", "startTime": "2026-01-01T00:02:00Z", "log": { "id": 12 } },
                    { "name": "Test", "result": "failed", "startTime": "2026-01-01T00:01:00Z", "log": { "id": 11 } },
                    { "name": "Build", "result": "succeeded", "log": { "id": 10 } },
                ] }))
            } else if r.path.contains("/logs/") {
                Some(Response {
                    status: 200,
                    content_type: Some("text/plain".into()),
                    body: format!("log {}", r.path.rsplit('/').next().unwrap()),
                })
            } else {
                None
            }
        })
    }

    #[test]
    fn log_shows_the_first_failed_task_and_names_the_rest() {
        let bed = Bed::new(failed_run());
        let log = cli(bed.app(), &["pipeline", "log", "--json"]).json();
        assert_eq!(
            (log["run"]["id"].as_u64(), &log["failedTasks"], &log["logs"]),
            (Some(9), &json!(["Test", "Lint"]), &json!([{ "task": "Test", "text": "log 11" }]))
        );
        assert!(bed.ado.requests().iter().any(|r| r.path.ends_with("/logs/11") && r.raw.text));

        let text = cli(bed.app(), &["pipeline", "log"]).stdout;
        assert!(text.contains("Test\nlog 11") && text.contains("1 more failed: Lint"), "{text}");
    }

    #[test]
    fn log_picks_a_task_by_name_or_all_of_them() {
        let bed = Bed::new(failed_run());
        assert_eq!(
            cli(bed.app(), &["pipeline", "log", "--task", "lint", "--json"]).json()["logs"],
            json!([{ "task": "Lint", "text": "log 12" }])
        );
        assert_eq!(cli(bed.app(), &["pipeline", "log", "--all", "--json"]).json()["logs"].as_array().unwrap().len(), 2);
        let missing = cli(bed.app(), &["pipeline", "log", "--task", "Deploy"]);
        assert_eq!((missing.code, missing.stderr.contains("Failed: Test, Lint")), (2, true), "{}", missing.stderr);
    }

    #[test]
    fn list_and_watch_report_the_run() {
        let bed = Bed::new(Box::new(|r: &Recorded| {
            let run = json!({ "id": 9, "status": "completed", "result": "succeeded", "definition": { "name": "CI" } });
            if r.path.ends_with("/builds") {
                ok(json!({ "value": [run] }))
            } else if r.path.ends_with("/builds/9") {
                ok(run)
            } else {
                None
            }
        }));
        assert_eq!(cli(bed.app(), &["pipeline", "list", "--json"]).json()["runs"][0]["name"], "CI");
        assert_eq!(cli(bed.app(), &["pipeline", "watch", "9"]).stdout, "Finished: succeeded\n");
        assert_eq!(cli(bed.app(), &["pipeline", "watch", "10"]).code, 2);
    }
}
