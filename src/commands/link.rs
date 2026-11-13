//! `dova link` records which work items the branch you're on is for, so
//! `dova pr create` links them. That is all it does: branches are git's,
//! and a work item's state is Azure Boards'.

use clap::Args;
use serde::Serialize;

use super::work_item_table;
use crate::ado::types::WorkItemRef;
use crate::app::App;
use crate::cli::Output;
use crate::error::{Error, Result};
use crate::text::{table, Style};
use crate::urls::{parse_id, unique};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Linked {
    pub branch: String,
    /// What the branch links now.
    pub work_items: Vec<WorkItemRef>,
    /// What `unlink` took off.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub removed: Vec<u64>,
}

fn parse_ids(values: &[String]) -> Result<Vec<u64>> {
    let ids: Option<Vec<u64>> = values.iter().map(|value| parse_id(value)).collect();
    ids.map(unique).ok_or_else(|| Error::user(format!("Not work item ids: {}", values.join(" "))))
}

fn hashes(ids: &[u64]) -> String {
    ids.iter().map(|id| format!("#{id}")).collect::<Vec<_>>().join(", ")
}

/// Adds the work items to the current branch's links. They have to exist.
pub fn link(app: &App, values: &[String]) -> Result<Linked> {
    let ids = parse_ids(values)?;
    let scope = app.scope()?;
    let branch = scope.need_branch()?;
    let all = unique(app.git.links(branch)?.into_iter().chain(ids.iter().copied()));
    let known = app.ado(&scope.org_url).work_items(&all)?;
    let missing: Vec<u64> = ids.iter().copied().filter(|id| !known.iter().any(|w| w.id == *id)).collect();
    if !missing.is_empty() {
        return Err(Error::not_found(format!("Not found: {}", hashes(&missing))));
    }
    app.git.set_links(branch, &all)?;
    Ok(Linked { branch: branch.to_string(), work_items: WorkItemRef::list(&all, &known), removed: Vec::new() })
}

/// Takes the work items, or all of them, off the current branch's links.
pub fn unlink(app: &App, values: &[String], all: bool) -> Result<Linked> {
    if all != values.is_empty() {
        return Err(Error::user("Pass the ids to unlink, or --all."));
    }
    let ids = parse_ids(values)?;
    let scope = app.scope()?;
    let branch = scope.need_branch()?;
    let linked = app.git.links(branch)?;
    let (removed, kept): (Vec<u64>, Vec<u64>) = linked.iter().partition(|id| all || ids.contains(id));
    if removed.is_empty() {
        let linked = if linked.is_empty() { "nothing".to_string() } else { hashes(&linked) };
        return Err(
            Error::not_found(format!("None of those are linked to \"{branch}\".")).hint(format!("Linked: {linked}"))
        );
    }
    app.git.set_links(branch, &kept)?;
    let known = app.ado(&scope.org_url).work_items(&kept)?;
    Ok(Linked { branch: branch.to_string(), work_items: WorkItemRef::list(&kept, &known), removed })
}

fn render(r: &Linked, s: Style) -> String {
    let mut out = Vec::new();
    if !r.removed.is_empty() {
        out.push(format!("{} {}", s.bold("Removed:"), hashes(&r.removed)));
    }
    out.push(format!("{} {}", s.bold("Branch:"), r.branch));
    out.push(if r.work_items.is_empty() { s.dim("No work items linked.") } else { work_item_table(&r.work_items) });
    out.join("\n")
}

#[derive(Args)]
pub struct Link {
    /// Work item ids
    #[arg(required = true)]
    pub ids: Vec<String>,
}

impl Link {
    pub fn run(&self, app: &App) -> Result<Output> {
        let linked = link(app, &self.ids)?;
        Ok(Output::new(&linked, render(&linked, app.style)))
    }
}

#[derive(Args)]
pub struct Unlink {
    /// Work item ids
    pub ids: Vec<String>,
    /// Remove all of them
    #[arg(long)]
    pub all: bool,
}

impl Unlink {
    pub fn run(&self, app: &App) -> Result<Output> {
        let unlinked = unlink(app, &self.ids, self.all)?;
        Ok(Output::new(&unlinked, render(&unlinked, app.style)))
    }
}

#[derive(Args)]
pub struct List {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedBranch {
    branch: String,
    last_commit: Option<String>,
    work_items: Vec<WorkItemRef>,
}

impl List {
    pub fn run(&self, app: &App) -> Result<Output> {
        let linked = app.git.linked_branches()?;
        let format = "--format=%(refname:short)%09%(committerdate:iso-strict)";
        let dates = app.git.try_run(&["for-each-ref", format, "refs/heads/"])?.unwrap_or_default();
        let scope = app.scope()?;
        let every_id = unique(linked.iter().flat_map(|(_, ids)| ids.iter().copied()));
        let known = app.ado(&scope.org_url).work_items(&every_id)?;

        let last_commit = |branch: &str| {
            let date = dates.lines().filter_map(|line| line.split_once('\t')).find(|(name, _)| *name == branch);
            date.map(|(_, date)| date.to_string())
        };
        let mut branches: Vec<LinkedBranch> = linked
            .into_iter()
            .map(|(branch, ids)| LinkedBranch {
                last_commit: last_commit(&branch),
                work_items: WorkItemRef::list(&ids, &known),
                branch,
            })
            .collect();
        branches.sort_by(|a, b| b.last_commit.cmp(&a.last_commit));

        // A row per branch: its first work item, and how many more there are.
        let row = |b: &LinkedBranch| {
            let first = &b.work_items[0];
            let more = if b.work_items.len() > 1 { format!("+{}", b.work_items.len() - 1) } else { String::new() };
            vec![b.branch.clone(), format!("#{}", first.id), first.title.clone().unwrap_or_else(|| "?".into()), more]
        };
        let text = if branches.is_empty() {
            app.style.dim("No branches are linked to work items — see `dova link`.")
        } else {
            table(&["Branch", "Work item", "Title", ""], &branches.iter().map(row).collect::<Vec<_>>())
        };
        Ok(Output::new(&serde_json::json!({ "branches": branches }), text))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::testing::{batch, cli, wi, Bed, GitOpts};

    const LINKS: &str = "branch.feature/x.dova-workitems";

    #[test]
    fn adds_to_what_the_branch_already_links() {
        let bed = Bed::new(batch(vec![wi(11, json!({})), wi(12, json!({})), wi(13, json!({}))])).git(GitOpts::linked());
        let linked = cli(bed.app(), &["link", "13", "#11", "--json"]).json();
        let ids: Vec<u64> = linked["workItems"].as_array().unwrap().iter().map(|w| w["id"].as_u64().unwrap()).collect();
        assert_eq!(ids, [11, 12, 13]);
        assert_eq!(linked["workItems"][2], json!({ "id": 13, "title": "Item 13", "type": "Task", "state": "Active" }));
        assert_eq!(bed.git.config(LINKS).as_deref(), Some("11,12,13"));
        assert_eq!(bed.ado.requests().len(), 1, "one request, for everything the branch now links");
    }

    #[test]
    fn links_nothing_when_one_of_them_does_not_exist() {
        let bed = Bed::new(batch(vec![wi(13, json!({}))]));
        let res = cli(bed.app(), &["link", "13", "99"]);
        assert_eq!((res.code, res.stderr.contains("Not found: #99")), (2, true), "{}", res.stderr);
        assert_eq!(bed.git.config(LINKS), None);
        assert_eq!(cli(bed.app(), &["link", "abc"]).code, 1);
    }

    #[test]
    fn unlink_removes_some_or_all() {
        let bed = Bed::new(batch(vec![wi(11, json!({}))])).git(GitOpts::linked());
        let unlinked = cli(bed.app(), &["unlink", "12", "--json"]).json();
        assert_eq!(unlinked["removed"], json!([12]));
        assert_eq!(unlinked["workItems"][0]["title"], "Item 11");
        assert_eq!(bed.git.config(LINKS).as_deref(), Some("11"));

        assert_eq!(cli(bed.app(), &["unlink", "12"]).code, 2, "it isn't linked any more");
        assert_eq!(cli(bed.app(), &["unlink"]).code, 1);
        assert_eq!(
            cli(bed.app(), &["unlink", "--all"]).stdout,
            "Removed: #11\nBranch: feature/x\nNo work items linked.\n"
        );
        assert_eq!(bed.git.config(LINKS), None);
    }

    #[test]
    fn lists_linked_branches_most_recently_committed_first() {
        let dates = "old\t2026-01-01T00:00:00+00:00\nfeature/x\t2026-02-01T00:00:00+00:00";
        let git = GitOpts::linked()
            .config("branch.old.dova-workitems", "30")
            .answer("for-each-ref --format=%(refname:short)%09%(committerdate:iso-strict) refs/heads/", dates);
        let bed = Bed::new(batch(vec![wi(11, json!({})), wi(12, json!({})), wi(30, json!({}))])).git(git);
        let listed = cli(bed.app(), &["list", "--json"]).json();
        assert_eq!(listed["branches"][0]["branch"], "feature/x");
        assert_eq!(listed["branches"][0]["lastCommit"], "2026-02-01T00:00:00+00:00");
        assert_eq!(listed["branches"][0]["workItems"][1]["title"], "Item 12");
        assert_eq!(listed["branches"][1]["branch"], "old");
        assert!(cli(bed.app(), &["list"]).stdout.contains("│ feature/x │ #11       │ Item 11 │ +1 │"));
    }
}
