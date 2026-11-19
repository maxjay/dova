//! REST response shapes → dova's types. Raw JSON is read only as far as it's used.

use serde_json::Value;

use super::types::{BodySection, Change, Comment, PullRequest, Run, Thread, ThreadLocation, TimelineRecord, WorkItem};
use crate::text::strip_html;
use crate::urls;

pub const WORK_ITEM_FIELDS: [&str; 14] = [
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
    "Microsoft.VSTS.Scheduling.StoryPoints",
    "Microsoft.VSTS.Scheduling.Effort",
    "Microsoft.VSTS.Scheduling.Size",
];

/// The estimate, under the name each process gives it: a type has at most one of these.
pub const POINTS: [&str; 3] =
    ["Microsoft.VSTS.Scheduling.StoryPoints", "Microsoft.VSTS.Scheduling.Effort", "Microsoft.VSTS.Scheduling.Size"];

/// The field a type's main text lives in, and what its form calls it. A
/// Bug's form shows Repro Steps where every other type shows a Description.
pub fn body_field(kind: &str) -> (&'static str, &'static str) {
    BODY[if kind.eq_ignore_ascii_case("bug") { 2 } else { 0 }]
}

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

/// A work item's estimate. After a change of type it can still carry the
/// old type's, so the standard types are read from their own field only;
/// a Bug, or a type of your own making, from whichever it has.
fn points(fields: &Value) -> Option<f64> {
    let own = match fields["System.WorkItemType"].as_str().unwrap_or("").to_ascii_lowercase().as_str() {
        "user story" => Some(POINTS[0]),
        "feature" | "epic" | "product backlog item" | "issue" => Some(POINTS[1]),
        "requirement" => Some(POINTS[2]),
        _ => None,
    };
    match own {
        Some(field) => fields[field].as_f64(),
        None => POINTS.iter().find_map(|field| fields[*field].as_f64()),
    }
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
        points: points(fields),
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

/// Azure DevOps writes one id in either case.
pub fn same_identity(a: &Value, b: &str) -> bool {
    a.as_str().is_some_and(|a| a.eq_ignore_ascii_case(b))
}

/// What `who` voted on a pull request, in the words Azure DevOps' own pages use.
pub fn vote_of(raw: &Value, who: &str) -> String {
    let theirs = items(&raw["reviewers"]).iter().find(|r| same_identity(&r["id"], who));
    match theirs.and_then(|r| r["vote"].as_i64()).unwrap_or(0) {
        10 => "approved",
        5 => "approved with suggestions",
        -5 => "waiting for author",
        -10 => "rejected",
        _ => "none",
    }
    .to_string()
}

fn items(list: &Value) -> &[Value] {
    list.as_array().map_or(&[], Vec::as_slice)
}

/// Threads people wrote in, not the ones made only of system notes ("X pushed 2 commits").
pub fn is_discussion(raw: &Value) -> bool {
    let written = |c: &Value| c["commentType"] != "system" && !c["content"].as_str().unwrap_or("").trim().is_empty();
    raw["isDeleted"] != true && items(&raw["comments"]).iter().any(written)
}

/// One file of a pull request's changes; None for anything that isn't a file.
pub fn to_change(raw: &Value) -> Option<Change> {
    let item = &raw["item"];
    if item["isFolder"] == true || item["gitObjectType"] == "tree" {
        return None;
    }
    let text = |value: &Value| value.as_str().map(str::to_string);
    let kinds = raw["changeType"].as_str().unwrap_or("");
    let (path, blob) = (text(&item["path"]), text(&item["objectId"]));
    // Only a file that moved, or went, has its old path spelled out.
    let moved = text(&raw["originalPath"]);
    Some(if kinds.contains("delete") {
        let old_path = moved.or(path);
        Change { kind: "deleted", path: None, old_path, blob: None, old_blob: text(&item["originalObjectId"]).or(blob) }
    } else if kinds.contains("add") {
        Change { kind: "added", path, old_path: None, blob, old_blob: None }
    } else {
        let kind = if kinds.contains("rename") { "renamed" } else { "edited" };
        Change { kind, old_path: moved.or_else(|| path.clone()), path, blob, old_blob: text(&item["originalObjectId"]) }
    })
}

pub fn to_thread(raw: &Value) -> Thread {
    let context = &raw["threadContext"];
    // On the pull request's side of the file when it is on both; on neither when it is about the whole file.
    let side = ["right", "left"].into_iter().find(|side| context[format!("{side}FileStart")]["line"].is_u64());
    // Line 0 is where Azure DevOps puts a thread whose lines a later push removed.
    let line = |end: &str| context[format!("{}File{end}", side?)]["line"].as_u64().filter(|line| *line > 0);
    let first = line("Start");
    let status = raw["status"].as_str().unwrap_or("unknown").to_string();
    Thread {
        id: raw["id"].as_u64().unwrap_or(0),
        unresolved: status == "active" || status == "pending",
        status,
        location: context["filePath"].as_str().map(|file| ThreadLocation {
            file: file.to_string(),
            line: first,
            end_line: first.map(|first| line("End").filter(|last| *last >= first).unwrap_or(first)),
            side: side.map(|side| if side == "right" { "new" } else { "old" }),
            outdated: side.is_some() && first.is_none(),
        }),
        comments: items(&raw["comments"])
            .iter()
            .map(|c| Comment {
                id: c["id"].as_u64().unwrap_or(0),
                author: c["author"]["displayName"].as_str().map(str::to_string),
                author_id: c["author"]["id"].as_str().map(str::to_string),
                published_at: c["publishedDate"].as_str().map(to_the_second),
                text: c["content"].as_str().unwrap_or("").to_string(),
                kind: c["commentType"].as_str().unwrap_or("text").to_string(),
            })
            .collect(),
    }
}

/// A comment in a work item's discussion.
pub fn to_work_item_comment(raw: &Value) -> Comment {
    Comment {
        id: raw["id"].as_u64().unwrap_or(0),
        author: raw["createdBy"]["displayName"].as_str().map(str::to_string),
        author_id: raw["createdBy"]["id"].as_str().map(str::to_string),
        published_at: raw["createdDate"].as_str().map(to_the_second),
        text: strip_html(raw["text"].as_str().unwrap_or("")),
        kind: "text".to_string(),
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
        queued_at: raw["queueTime"].as_str().map(to_the_second),
        source_branch: raw["sourceBranch"].as_str().map(str::to_string),
        url: urls::run_url(org_url, project, id),
    }
}

/// `2026-11-14T19:48:07.7530236Z` → `2026-11-14T19:48:07Z`: nobody reads the fraction.
fn to_the_second(time: &str) -> String {
    match (time.find('.'), time.strip_suffix('Z')) {
        (Some(dot), Some(_)) => format!("{}Z", &time[..dot]),
        _ => time.to_string(),
    }
}

pub fn to_timeline_record(raw: &Value) -> TimelineRecord {
    let errors = items(&raw["issues"]).iter().filter(|issue| issue["type"] == "error");
    TimelineRecord {
        name: raw["name"].as_str().unwrap_or("").to_string(),
        result: raw["result"].as_str().map(str::to_string),
        start_time: raw["startTime"].as_str().map(str::to_string),
        log_id: raw["log"]["id"].as_u64(),
        errors: errors.filter_map(|issue| issue["message"].as_str().map(str::to_string)).collect(),
    }
}
