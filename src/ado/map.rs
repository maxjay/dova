//! REST response shapes → dova's types. Raw JSON is read only as far as it's used.

use serde_json::Value;

use super::types::{BodySection, Comment, PullRequest, Run, Thread, ThreadLocation, TimelineRecord, WorkItem};
use crate::text::strip_html;
use crate::urls;

pub const WORK_ITEM_FIELDS: [&str; 11] = [
    "System.Title",
    "System.WorkItemType",
    "System.State",
    "System.TeamProject",
    "System.AssignedTo",
    "System.AreaPath",
    "System.IterationPath",
    "System.Parent",
    "System.Description",
    "Microsoft.VSTS.Common.AcceptanceCriteria",
    "Microsoft.VSTS.TCM.ReproSteps",
];

/// A Bug's substance is in its repro steps, a Story's in its acceptance
/// criteria: each one present becomes a section.
const BODY: [(&str, &str); 3] = [
    ("System.Description", "Description"),
    ("Microsoft.VSTS.Common.AcceptanceCriteria", "Acceptance Criteria"),
    ("Microsoft.VSTS.TCM.ReproSteps", "Repro Steps"),
];

/// A field as text: a string as it is, an identity by its display name, nothing for empty.
fn text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(s) => s.clone(),
        Value::Object(identity) => identity.get("displayName")?.as_str()?.to_string(),
        Value::Null => return None,
        other => other.to_string(),
    };
    Some(text).filter(|t| !t.is_empty())
}

fn branch(reference: &Value) -> String {
    let name = reference.as_str().unwrap_or("");
    name.strip_prefix("refs/heads/").unwrap_or(name).to_string()
}

pub fn to_work_item(raw: &Value, org_url: &str) -> WorkItem {
    let fields = &raw["fields"];
    let id = raw["id"].as_u64().unwrap_or(0);
    let project = text(&fields["System.TeamProject"]);
    let section = |(field, label): &(&str, &str)| {
        let text = strip_html(&text(&fields[*field])?);
        (!text.is_empty()).then(|| BodySection { label: label.to_string(), text })
    };
    WorkItem {
        id,
        title: text(&fields["System.Title"]),
        kind: text(&fields["System.WorkItemType"]),
        state: text(&fields["System.State"]),
        assigned_to: text(&fields["System.AssignedTo"]),
        area_path: text(&fields["System.AreaPath"]),
        iteration_path: text(&fields["System.IterationPath"]),
        parent_id: fields["System.Parent"].as_u64(),
        body: BODY.iter().filter_map(section).collect(),
        url: urls::work_item_url(org_url, project.as_deref().unwrap_or(""), id),
        project,
    }
}

/// `project` and `repo` are what was asked for, for the responses that don't name them.
pub fn to_pull_request(raw: &Value, org_url: &str, project: &str, repo: &str) -> PullRequest {
    let id = raw["pullRequestId"].as_u64().unwrap_or(0);
    let project = raw["repository"]["project"]["name"].as_str().unwrap_or(project).to_string();
    let repo = raw["repository"]["name"].as_str().unwrap_or(repo).to_string();
    PullRequest {
        id,
        title: raw["title"].as_str().unwrap_or("").to_string(),
        status: raw["status"].as_str().unwrap_or("unknown").to_string(),
        is_draft: raw["isDraft"].as_bool().unwrap_or(false),
        author: raw["createdBy"]["displayName"].as_str().unwrap_or("unknown").to_string(),
        description: raw["description"].as_str().unwrap_or("").to_string(),
        source_branch: branch(&raw["sourceRefName"]),
        target_branch: branch(&raw["targetRefName"]),
        url: urls::pull_request_url(org_url, &project, &repo, id),
        project,
        repo,
    }
}

fn items(list: &Value) -> &[Value] {
    list.as_array().map_or(&[], Vec::as_slice)
}

/// Threads people wrote in, not the ones made only of system notes ("X pushed 2 commits").
pub fn is_discussion(raw: &Value) -> bool {
    let written = |c: &Value| c["commentType"] != "system" && !c["content"].as_str().unwrap_or("").trim().is_empty();
    raw["isDeleted"] != true && items(&raw["comments"]).iter().any(written)
}

pub fn to_thread(raw: &Value) -> Thread {
    let context = &raw["threadContext"];
    let line = context["rightFileStart"]["line"].as_u64().or_else(|| context["leftFileStart"]["line"].as_u64());
    let status = raw["status"].as_str().unwrap_or("unknown").to_string();
    Thread {
        id: raw["id"].as_u64().unwrap_or(0),
        unresolved: status == "active" || status == "pending",
        status,
        location: line
            .map(|line| ThreadLocation { file: context["filePath"].as_str().unwrap_or("").to_string(), line }),
        comments: items(&raw["comments"])
            .iter()
            .map(|c| Comment {
                id: c["id"].as_u64().unwrap_or(0),
                author: c["author"]["displayName"].as_str().map(str::to_string),
                published_at: c["publishedDate"].as_str().map(str::to_string),
                text: c["content"].as_str().unwrap_or("").to_string(),
                kind: c["commentType"].as_str().unwrap_or("text").to_string(),
            })
            .collect(),
    }
}

pub fn to_run(raw: &Value, org_url: &str, project: &str) -> Run {
    let id = raw["id"].as_u64().unwrap_or(0);
    let numbered = || format!("#{}", raw["buildNumber"].as_str().map_or(id.to_string(), str::to_string));
    Run {
        id,
        name: raw["definition"]["name"].as_str().map_or_else(numbered, str::to_string),
        status: raw["status"].as_str().unwrap_or("unknown").to_string(),
        result: raw["result"].as_str().map(str::to_string),
        queued_at: raw["queueTime"].as_str().map(str::to_string),
        source_branch: raw["sourceBranch"].as_str().map(str::to_string),
        url: raw["_links"]["web"]["href"].as_str().map_or_else(|| urls::run_url(org_url, project, id), str::to_string),
    }
}

pub fn to_timeline_record(raw: &Value) -> TimelineRecord {
    TimelineRecord {
        name: raw["name"].as_str().unwrap_or("").to_string(),
        result: raw["result"].as_str().map(str::to_string),
        start_time: raw["startTime"].as_str().map(str::to_string),
        log_id: raw["log"]["id"].as_u64(),
    }
}
