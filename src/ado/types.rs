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
    pub parent_id: Option<u64>,
    /// Plain text, HTML stripped, only the sections the item actually has.
    pub body: Vec<BodySection>,
    pub url: String,
}

impl WorkItem {
    pub fn to_ref(&self) -> WorkItemRef {
        WorkItemRef { id: self.id, title: self.title.clone(), kind: self.kind.clone(), state: self.state.clone() }
    }
}

impl WorkItemRef {
    /// One per id, in that order: what `known` says about it, or for an id it doesn't have, only the id.
    pub fn list(ids: &[u64], known: &[WorkItem]) -> Vec<WorkItemRef> {
        let unknown = |id| WorkItemRef { id, title: None, kind: None, state: None };
        ids.iter().map(|id| known.iter().find(|w| w.id == *id).map_or_else(|| unknown(*id), WorkItem::to_ref)).collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub id: u64,
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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ThreadLocation {
    pub file: String,
    /// 1-based; the PR's version of the file when it has the line, else the base's.
    pub line: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: u64,
    pub author: Option<String>,
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
}

#[derive(Debug, Clone, PartialEq)]
pub struct TeamAreas {
    /// The team's default area path; empty when none is flagged.
    pub default_area: String,
    pub areas: Vec<String>,
}
