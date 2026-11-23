//! What dova works with. Azure DevOps' REST shapes are mapped into these
//! once, in `map.rs`; nothing else sees a raw REST object. They serialize
//! as `--json` prints them.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkItemRef {
    pub id: u64,
    pub title: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub state: Option<String>,
}

/// One labelled section of a work item's content: description, acceptance criteria, repro steps.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BodySection {
    pub label: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: u64,
    pub title: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub state: Option<String>,
    pub project: Option<String>,
    pub assigned_to: Option<String>,
    pub area_path: Option<String>,
    pub iteration_path: Option<String>,
    /// Story points, effort or size: whichever of the three the type has.
    pub points: Option<f64>,
    pub parent_id: Option<u64>,
    /// Plain text, HTML stripped, only the sections the item actually has.
    pub body: Vec<BodySection>,
    pub url: String,
}

impl WorkItem {
    pub fn into_ref(self) -> WorkItemRef {
        WorkItemRef { id: self.id, title: self.title, kind: self.kind, state: self.state }
    }
}

impl WorkItemRef {
    /// One per id, in that order: what `known` says about it, or for an id it doesn't have, only the id.
    pub fn list(ids: &[u64], known: &[WorkItemRef]) -> Vec<WorkItemRef> {
        let unknown = |id| WorkItemRef { id, title: None, kind: None, state: None };
        ids.iter().map(|id| known.iter().find(|w| w.id == *id).cloned().unwrap_or_else(|| unknown(*id))).collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub id: u64,
    /// Routing for Azure's project-scoped review provider, from the PR lookup.
    #[serde(skip)]
    pub project_id: Option<String>,
    #[serde(skip)]
    pub repo_id: Option<String>,
    pub title: String,
    /// active | completed | abandoned
    pub status: String,
    pub is_draft: bool,
    pub author: String,
    pub description: String,
    pub source_branch: String,
    pub target_branch: String,
    pub project: String,
    pub repo: String,
    pub url: String,
}

/// A pull request as a list shows it: with its check, and how many review threads are still open.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedPullRequest {
    #[serde(flatten)]
    pub pr: PullRequest,
    /// Its latest validation run, or without one, its branch's latest run.
    pub check: Option<Run>,
    pub open_threads: u64,
    /// Where you stand on it, in a list of the ones you were asked to review.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<Review>,
}

/// Where the signed-in user stands on a pull request that asks them for a review.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    /// none | approved | approved with suggestions | waiting for author | rejected
    pub vote: String,
    /// The team of theirs that was asked, when they were not asked by name.
    pub team: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLocation {
    /// As Azure DevOps writes a path in a repo: from its root, with a leading
    /// slash. For a renamed file this is its new path, on either side.
    pub file: String,
    /// 1-based, the first line it is on, in the version of the file `side`
    /// names. None when it is on no line: it is about the whole file, or it
    /// is `outdated`.
    pub line: Option<u64>,
    /// The last line it is on: `line` again when it is on one.
    pub end_line: Option<u64>,
    /// new: the pull request's version of the file. old: what it is compared
    /// with. None for a thread about the whole file.
    pub side: Option<&'static str>,
    /// It is on no line any more: a later push removed every line it was on,
    /// or the pull request no longer changes the file.
    pub outdated: bool,
}

impl ThreadLocation {
    /// `/src/a.ts:3`, or `/src/a.ts:3-5`; marked when the lines are the old file's, or are gone.
    pub fn place(&self) -> String {
        let old = if self.side == Some("old") { " (old)" } else { "" };
        match (self.line, self.end_line) {
            (Some(line), Some(end)) if end > line => format!("{}:{line}-{end}{old}", self.file),
            (Some(line), _) => format!("{}:{line}{old}", self.file),
            (None, _) if self.outdated => format!("{} (its lines have since gone)", self.file),
            (None, _) => self.file.clone(),
        }
    }
}

/// Where a new review thread goes: whole lines of one side of a file.
#[derive(Debug, Clone, PartialEq)]
pub struct Anchor {
    pub file: String,
    pub line: u64,
    pub end_line: u64,
    /// How long the last line is, in the UTF-16 units Azure DevOps counts a line in.
    pub end_width: u64,
    /// The side the pull request is compared with, not its own.
    pub old: bool,
}

/// One push to a pull request, and the two commits a diff of it is between.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Iteration {
    /// Counted from 1.
    pub id: u64,
    /// Where the pull request's branch left its target.
    pub base: String,
    pub head: String,
}

/// One file a pull request changes. Paths and contents are None on the side
/// where the file doesn't exist: before an addition, after a deletion.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    /// added | edited | deleted | renamed
    pub kind: &'static str,
    pub path: Option<String>,
    pub old_path: Option<String>,
    /// The id of the file's contents, to ask Azure DevOps for them by.
    pub blob: Option<String>,
    pub old_blob: Option<String>,
}

impl Change {
    /// Where the file is now, or where it was if it is gone.
    pub fn at(&self) -> &str {
        self.path.as_deref().or(self.old_path.as_deref()).unwrap_or("")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: u64,
    pub author: Option<String>,
    /// Who that is to Azure DevOps: how dova tells your comments from everyone else's.
    #[serde(skip)]
    pub author_id: Option<String>,
    pub published_at: Option<String>,
    pub text: String,
    /// text | codeChange | system
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Thread {
    pub id: u64,
    /// active | fixed | wontFix | closed | pending | unknown
    pub status: String,
    pub unresolved: bool,
    /// None for a general comment not anchored to a file.
    pub location: Option<ThreadLocation>,
    pub comments: Vec<Comment>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: u64,
    pub name: String,
    /// notStarted | inProgress | completed | cancelling | postponed
    pub status: String,
    /// succeeded | partiallySucceeded | failed | canceled; None while running
    pub result: Option<String>,
    pub queued_at: Option<String>,
    pub source_branch: Option<String>,
    pub url: String,
}

impl Run {
    /// How it ended, or while it hasn't, where it is.
    pub fn outcome(&self) -> &str {
        self.result.as_deref().unwrap_or(&self.status)
    }
}

/// One node of a run's timeline: a Stage, Phase, Job, Task or Checkpoint.
#[derive(Debug, Clone, PartialEq)]
pub struct TimelineRecord {
    pub name: String,
    pub result: Option<String>,
    pub start_time: Option<String>,
    pub log_id: Option<u64>,
    /// What Azure Pipelines says went wrong here, which a log doesn't always show.
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TeamAreas {
    /// The team's default area path; empty when none is flagged.
    pub default_area: String,
    pub areas: Vec<String>,
}
