//! Pull requests and their review threads.

use clap::{Args, Subcommand};
use serde::Serialize;
use serde_json::json;

use super::work_item_table;
use crate::ado::client::{AdoClient, NewPullRequest};
use crate::ado::types::{PullRequest, Thread, ThreadLocation, WorkItem, WorkItemRef};
use crate::app::{App, ScopeHint};
use crate::cli::Output;
use crate::error::{Error, Result};
use crate::par;
use crate::text::{truncate, Style};
use crate::urls::{parse_id, parse_pull_request_link};

/// A PR from an id or a link, or with neither, the current branch's active PR — and the client for its org.
pub fn find_pull_request<'a>(app: &'a App, id_or_url: Option<&str>) -> Result<(PullRequest, AdoClient<'a>)> {
    let Some(target) = id_or_url else {
        let scope = app.scope()?;
        let (repo, branch) = (scope.need_repo("pr")?, scope.need_branch()?);
        let ado = app.ado(&scope.org_url);
        let pr = ado.active_pull_request(&scope.project, repo, branch)?;
        return Ok((
            pr.ok_or_else(|| Error::not_found(format!("No active pull request for branch \"{branch}\".")))?,
            ado,
        ));
    };
    let link = parse_pull_request_link(target);
    let id = link.as_ref().map(|l| l.id).or_else(|| parse_id(target));
    let id = id.ok_or_else(|| Error::user(format!("\"{target}\" isn't a pull request id or link.")))?;
    // A link names its own organization; a bare id is in the one you're in.
    let hint = link.map(|l| ScopeHint { org: Some(l.org), project: Some(l.project), repo: Some(l.repo) });
    let ado = app.ado(&app.scope_for(&hint.unwrap_or_default())?.org_url);
    Ok((ado.pull_request(id)?, ado))
}

/* ---------------- create ---------------- */

#[derive(Args, Default)]
pub struct Create {
    /// Title (default: the last commit's subject; '-' reads stdin)
    #[arg(long)]
    pub title: Option<String>,
    /// Description ('-' reads stdin)
    #[arg(long, value_name = "TEXT")]
    pub body: Option<String>,
    /// Branch to merge into (default: the repo's default branch)
    #[arg(long, value_name = "BRANCH")]
    pub target: Option<String>,
    /// Open as a draft
    #[arg(long)]
    pub draft: bool,
    /// Work items to link (default: the ones `dova link` recorded for this branch)
    #[arg(long, value_name = "IDS", num_args = 1..)]
    pub work_items: Vec<String>,
    /// Open the new PR in the browser
    #[arg(short, long)]
    pub web: bool,
}

impl Create {
    fn create(&self, app: &App) -> Result<PullRequest> {
        if self.title.as_deref() == Some("-") && self.body.as_deref() == Some("-") {
            return Err(Error::user("Only one of --title and --body can read stdin."));
        }
        let scope = app.scope()?;
        let (repo, branch) = (scope.need_repo("pr create")?, scope.need_branch()?);
        let ado = app.ado(&scope.org_url);

        let title = match &self.title {
            Some(title) => app.text(Some(title), "title")?,
            None => app.git.try_run(&["log", "-1", "--format=%s"])?.unwrap_or_else(|| branch.to_string()),
        };
        let description = self.body.as_deref().map(|body| app.text(Some(body), "body")).transpose()?;
        let work_item_ids = match self.work_items.as_slice() {
            [] => app.git.links(branch)?,
            given => given
                .iter()
                .map(|id| parse_id(id))
                .collect::<Option<Vec<u64>>>()
                .ok_or_else(|| Error::user(format!("Not work item ids: {}", given.join(" "))))?,
        };
        let target_branch = match &self.target {
            Some(target) => target.clone(),
            None => match app.git.origin_head()? {
                Some(head) => head,
                None => ado.default_branch(&scope.project, repo)?.ok_or_else(|| {
                    Error::user("Could not tell which branch to merge into.").hint("Pass --target <branch>.")
                })?,
            },
        };
        ado.create_pull_request(&NewPullRequest {
            project: scope.project.clone(),
            repo: repo.to_string(),
            source_branch: branch.to_string(),
            target_branch,
            title,
            description,
            is_draft: self.draft,
            work_item_ids,
        })
    }

    pub fn run(&self, app: &App) -> Result<Output> {
        let pr = self.create(app)?;
        let s = app.style;
        let draft = if pr.is_draft { " [draft]" } else { "" };
        let text = format!(
            "{} PR {}{draft} — {}\n{}",
            s.green("Created"),
            s.bold(&format!("#{}", pr.id)),
            pr.title,
            s.dim(&format!("  {}", pr.url))
        );
        Ok(Output::new(&pr, text).web(self.web, &pr.url))
    }
}

/* ---------------- view ---------------- */

/// A review thread as a list shows it: where, how many comments, and the last one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: u64,
    pub status: String,
    pub unresolved: bool,
    pub location: Option<ThreadLocation>,
    pub comment_count: usize,
    pub last_author: Option<String>,
    pub last_comment: Option<String>,
}

/// Open threads first.
pub fn summarize_threads(threads: Vec<Thread>) -> Vec<ThreadSummary> {
    let summary = |t: Thread| ThreadSummary {
        id: t.id,
        status: t.status,
        unresolved: t.unresolved,
        location: t.location,
        comment_count: t.comments.len(),
        last_author: t.comments.last().and_then(|c| c.author.clone()),
        last_comment: t.comments.last().map(|c| c.text.clone()),
    };
    let mut threads: Vec<ThreadSummary> = threads.into_iter().map(summary).collect();
    threads.sort_by_key(|t| !t.unresolved);
    threads
}

/// The "Threads" section of a PR: a count, then each thread as an indented
/// block, so long paths and real comment text survive.
pub fn render_threads(s: Style, pr_id: u64, threads: &[ThreadSummary], full: bool) -> Vec<String> {
    let open = threads.iter().filter(|t| t.unresolved).count();
    let mut out = vec![s.bold("Threads") + &s.dim(&format!(" ({open} open, {} resolved)", threads.len() - open))];
    for t in threads {
        let location = t.location.as_ref().map_or_else(|| s.dim("(general)"), |l| format!("{}:{}", l.file, l.line));
        let state = if t.unresolved { s.yellow("open") } else { s.dim("resolved") };
        let author = t.last_author.as_deref().unwrap_or("?").to_string();
        out.push(String::new());
        out.push([s.bold(&format!("#{}", t.id)), state, location, author].join("  "));

        let comment = t.last_comment.as_deref().unwrap_or("").trim();
        let (shown, cut) = if full { (comment.to_string(), false) } else { truncate(comment, 600) };
        out.extend(shown.lines().map(|line| format!("  {line}")));
        let earlier = (t.comment_count > 1).then(|| format!("{} earlier", t.comment_count - 1));
        let more: Vec<String> = cut.then(|| "truncated".to_string()).into_iter().chain(earlier).collect();
        if !more.is_empty() {
            out.push(s.dim(&format!("  … {} — dova pr thread {pr_id} {}", more.join(", "), t.id)));
        }
    }
    out
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    #[serde(flatten)]
    pub pr: PullRequest,
    pub work_items: Vec<WorkItemRef>,
    pub threads: Vec<ThreadSummary>,
}

pub fn pull_request_detail(pr: PullRequest, ado: &AdoClient) -> Result<PullRequestDetail> {
    let (work_items, threads) = par::join(|| ado.pull_request_work_items(&pr), || ado.threads(&pr));
    let work_items = work_items?.iter().map(WorkItem::to_ref).collect();
    Ok(PullRequestDetail { work_items, threads: summarize_threads(threads?), pr })
}

pub fn render_pull_request(d: &PullRequestDetail, s: Style, full: bool) -> String {
    let draft = if d.pr.is_draft { s.dim(" [draft]") } else { String::new() };
    let mut out = vec![
        format!("{} {}{draft}", s.bold(&format!("#{}", d.pr.id)), d.pr.title),
        s.dim(&format!(
            "{} · opened by {} · {} -> {}",
            d.pr.status, d.pr.author, d.pr.source_branch, d.pr.target_branch
        )),
        s.dim(&d.pr.url),
        String::new(),
        s.bold("Work Items"),
        if d.work_items.is_empty() { s.dim("  (none linked)") } else { work_item_table(&d.work_items) },
        String::new(),
    ];
    out.extend(render_threads(s, d.pr.id, &d.threads, full));
    out.join("\n")
}

#[derive(Args)]
pub struct View {
    /// PR id or link (default: the current branch's active PR)
    pub id_or_url: Option<String>,
    /// Show whole comments
    #[arg(long)]
    pub full: bool,
    /// Open it in the browser
    #[arg(short, long)]
    pub web: bool,
}

impl View {
    pub fn run(&self, app: &App) -> Result<Output> {
        let (pr, ado) = find_pull_request(app, self.id_or_url.as_deref())?;
        let detail = pull_request_detail(pr, &ado)?;
        Ok(Output::new(&detail, render_pull_request(&detail, app.style, self.full)).web(self.web, &detail.pr.url))
    }
}

/* ---------------- threads ---------------- */

/// A status as people say it → as the API names it. The UI's "Resolved" is the API's `fixed`.
pub fn parse_thread_status(input: &str) -> Result<&'static str> {
    Ok(match input.to_ascii_lowercase().as_str() {
        "resolved" | "fixed" => "fixed",
        "active" => "active",
        "wontfix" => "wontFix",
        "closed" => "closed",
        "pending" => "pending",
        _ => {
            return Err(Error::user(format!("Unknown thread status \"{input}\"."))
                .hint("Use one of: resolved, active, wontfix, closed, pending."))
        }
    })
}

fn thread_id(value: &str) -> Result<u64> {
    parse_id(value).ok_or_else(|| Error::user(format!("\"{value}\" isn't a thread id.")))
}

#[derive(Args)]
pub struct Comment {
    /// PR id or link
    pub pr: String,
    /// The comment ('-' or nothing reads stdin)
    pub text: Option<String>,
}

#[derive(Args)]
pub struct ThreadArgs {
    /// PR id or link
    pub pr: String,
    /// Thread id, as `dova status` and `dova pr view` list it
    pub thread: String,
}

#[derive(Args)]
pub struct Reply {
    /// PR id or link
    pub pr: String,
    /// Thread id
    pub thread: String,
    /// The reply ('-' or nothing reads stdin)
    pub text: Option<String>,
    /// Also set the thread's status (default: resolved)
    #[arg(long, value_name = "STATUS", num_args = 0..=1, default_missing_value = "resolved")]
    pub resolve: Option<String>,
}

#[derive(Args)]
pub struct Resolve {
    /// PR id or link
    pub pr: String,
    /// Thread id
    pub thread: String,
    /// resolved, active, wontfix, closed or pending
    #[arg(default_value = "resolved")]
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadOnPr<'a> {
    pr_id: u64,
    #[serde(flatten)]
    thread: &'a Thread,
}

#[derive(Subcommand)]
pub enum Pr {
    /// Open a PR from the current branch, linking its work items
    Create(Create),
    /// A PR with its work items and review threads (default: the current branch's)
    View(View),
    /// Start a review thread
    Comment(Comment),
    /// Every comment in one review thread
    Thread(ThreadArgs),
    /// Reply in a review thread
    Reply(Reply),
    /// Set a review thread's status (default: resolved)
    Resolve(Resolve),
}

impl Pr {
    pub fn run(&self, app: &App) -> Result<Output> {
        let s = app.style;
        match self {
            Pr::Create(c) => c.run(app),
            Pr::View(c) => c.run(app),
            Pr::Comment(c) => {
                let (pr, ado) = find_pull_request(app, Some(&c.pr))?;
                let thread = ado.add_comment(&pr, &app.text(c.text.as_deref(), "comment")?)?;
                let text = format!("{} thread #{} on PR #{}.", s.green("Posted"), thread.id, pr.id);
                Ok(Output::new(&json!({ "prId": pr.id, "threadId": thread.id }), text))
            }
            Pr::Thread(c) => {
                let (pr, ado) = find_pull_request(app, Some(&c.pr))?;
                let thread = ado.thread(&pr, thread_id(&c.thread)?)?;
                Ok(Output::new(&ThreadOnPr { pr_id: pr.id, thread: &thread }, render_thread(&thread, pr.id, s)))
            }
            Pr::Reply(c) => {
                // Everything that can be wrong with the request is found before anything is posted.
                let id = thread_id(&c.thread)?;
                let status = c.resolve.as_deref().map(parse_thread_status).transpose()?;
                let (pr, ado) = find_pull_request(app, Some(&c.pr))?;
                ado.reply(&pr, id, &app.text(c.text.as_deref(), "reply")?)?;
                if let Some(status) = status {
                    ado.set_thread_status(&pr, id, status)?;
                }
                let now = status.map_or(String::new(), |status| format!(", now {status}"));
                let text = format!("{} in thread #{id} on PR #{}{now}.", s.green("Replied"), pr.id);
                Ok(Output::new(&json!({ "prId": pr.id, "threadId": id, "status": status }), text))
            }
            Pr::Resolve(c) => {
                let (id, status) = (thread_id(&c.thread)?, parse_thread_status(&c.status)?);
                let (pr, ado) = find_pull_request(app, Some(&c.pr))?;
                ado.set_thread_status(&pr, id, status)?;
                let text = format!("{} thread #{id} on PR #{} to {status}.", s.green("Set"), pr.id);
                Ok(Output::new(&json!({ "prId": pr.id, "threadId": id, "status": status }), text))
            }
        }
    }
}

fn render_thread(t: &Thread, pr_id: u64, s: Style) -> String {
    let status = if t.unresolved { s.yellow(&t.status) } else { s.dim(&t.status) };
    let mut out = vec![
        format!("{} on PR #{pr_id} · {status}", s.bold(&format!("Thread #{}", t.id))),
        t.location.as_ref().map_or_else(|| s.dim("(general comment)"), |l| format!("{}:{}", l.file, l.line)),
    ];
    for comment in &t.comments {
        let by = [comment.author.as_deref().or(Some("unknown")), comment.published_at.as_deref()];
        out.push(String::new());
        out.push(s.bold(&by.into_iter().flatten().collect::<Vec<_>>().join(" · ")));
        out.extend(comment.text.lines().map(|line| format!("  {line}")));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::error::Kind;
    use crate::testing::{cli, ok, rest_pr, Bed, GitOpts, Recorded, Route};

    fn route() -> Route {
        Box::new(|r: &Recorded| {
            if r.method == "POST" {
                ok(rest_pr(9, json!({ "title": r.body["title"] })))
            } else if r.path.contains("/repositories/") {
                ok(json!({ "defaultBranch": "refs/heads/develop" }))
            } else {
                None
            }
        })
    }

    fn posted(bed: &Bed) -> Value {
        bed.ado.requests().into_iter().find(|r| r.method == "POST").expect("something was posted").body
    }

    #[test]
    fn links_the_branchs_work_items_and_targets_the_repo_default_branch() {
        let bed = Bed::new(route()).git(GitOpts::linked());
        assert_eq!(cli(bed.app(), &["pr", "create", "--title", "Add it", "--jq", ".id"]).stdout, "9\n");
        let body = posted(&bed);
        assert_eq!(body["sourceRefName"], "refs/heads/feature/x");
        assert_eq!(body["targetRefName"], "refs/heads/develop");
        assert_eq!(body["title"], "Add it");
        assert_eq!(body["workItemRefs"], json!([{ "id": "11" }, { "id": "12" }]));
        assert!(body.get("description").is_none());
    }

    #[test]
    fn titles_itself_after_the_last_commit_and_links_nothing_nobody_linked() {
        let bed = Bed::new(route()).git(GitOpts::default().answer("log -1 --format=%s", "Fix #41"));
        assert_eq!(cli(bed.app(), &["pr", "create", "--work-items", "7", "#8"]).code, 0);
        assert_eq!(
            (&posted(&bed)["title"], &posted(&bed)["workItemRefs"]),
            (&json!("Fix #41"), &json!([{ "id": "7" }, { "id": "8" }]))
        );

        let bed = Bed::new(route()).git(GitOpts::default().answer("log -1 --format=%s", "Fix #41"));
        assert_eq!(cli(bed.app(), &["pr", "create"]).code, 0);
        assert_eq!(posted(&bed)["workItemRefs"], json!([]));
    }

    #[test]
    fn reads_the_body_from_stdin_only_when_told_to() {
        let bed = Bed::new(route()).stdin("Uses `npm test` and $total");
        assert_eq!(cli(bed.app(), &["pr", "create", "--title", "x", "--body", "-"]).code, 0);
        assert_eq!(posted(&bed)["description"], "Uses `npm test` and $total");

        let bed = Bed::new(route()).stdin("left alone");
        assert_eq!(cli(bed.app(), &["pr", "create", "--title", "x"]).code, 0);
        assert!(posted(&bed).get("description").is_none());
    }

    #[test]
    fn reads_thread_statuses_the_way_people_say_them() {
        assert_eq!(parse_thread_status("Resolved").unwrap(), "fixed");
        assert_eq!(parse_thread_status("wontfix").unwrap(), "wontFix");
        assert_eq!(parse_thread_status("nope").unwrap_err().kind, Kind::User);
    }

    fn thread_3_on_pr_7() -> Route {
        Box::new(|r: &Recorded| match (r.method.as_str(), r.path.as_str()) {
            ("GET", p) if p.ends_with("/pullrequests/7") => ok(rest_pr(7, json!({}))),
            ("GET", p) if p.ends_with("/threads/3") => {
                ok(json!({ "id": 3, "comments": [{ "id": 4, "content": "a" }, { "id": 5, "content": "b" }] }))
            }
            ("POST", _) => ok(json!({ "id": 6 })),
            ("PATCH", _) => ok(json!({})),
            _ => None,
        })
    }

    #[test]
    fn replies_under_the_last_comment_and_resolves_in_one_go() {
        let bed = Bed::new(thread_3_on_pr_7());
        let res = cli(bed.app(), &["pr", "reply", "7", "3", "Fixed in 9f2c", "--resolve", "--json"]);
        assert_eq!(res.json(), json!({ "prId": 7, "threadId": 3, "status": "fixed" }));
        assert_eq!(posted(&bed), json!({ "content": "Fixed in 9f2c", "commentType": "text", "parentCommentId": 5 }));
        let requests = bed.ado.requests();
        let patch = requests.iter().find(|r| r.method == "PATCH").unwrap();
        assert_eq!(patch.body, json!({ "status": "fixed" }));
        assert!(patch.path.ends_with("/pullRequests/7/threads/3"));
    }

    #[test]
    fn a_reply_with_a_bad_status_posts_nothing() {
        let bed = Bed::new(thread_3_on_pr_7());
        assert_eq!(cli(bed.app(), &["pr", "reply", "7", "3", "text", "--resolve", "done"]).code, 1);
        assert!(bed.ado.requests().is_empty());
    }
}
