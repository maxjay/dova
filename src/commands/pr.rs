//! Pull requests and their review threads.

use clap::{Args, Subcommand};
use serde::Serialize;
use serde_json::json;

use super::diff::{anchor, Diff};
use super::work_item_table;
use crate::ado::client::{AdoClient, NewPullRequest, MOST};
use crate::ado::types::{ListedPullRequest, PullRequest, Thread, ThreadLocation, WorkItemRef};
use crate::app::App;
use crate::cli::Output;
use crate::error::{Error, Result};
use crate::images::Illustrated;
use crate::text::{table, truncate, Style};
use crate::urls::{my_pull_requests_url, parse_id, parse_pull_request_link};

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
    let ado = app.ado(&app.org_url(link.as_ref().map(|l| l.org.as_str()))?);
    Ok((ado.pull_request(id)?, ado))
}

/* ---------------- create ---------------- */

#[derive(Args, Default)]
pub struct Create {
    /// Title (default: the last commit's subject; '-' reads stdin)
    #[arg(long)]
    pub title: Option<String>,
    /// Description ('-' reads stdin; `![alt](shot.png)` uploads that file)
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
        let description = match &self.body {
            Some(body) => Some(Illustrated::read(app.text(Some(body), "body")?, app.git.cwd())?),
            None => None,
        };
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
        let created = ado.create_pull_request(&NewPullRequest {
            project: scope.project.clone(),
            repo: repo.to_string(),
            source_branch: branch.to_string(),
            target_branch,
            title,
            description: description.as_ref().map(|body| body.as_written().to_string()),
            is_draft: self.draft,
            work_item_ids,
        });
        // Azure DevOps allows one active PR per pair of branches (TF401179): say which one is in the way.
        let pr = match created {
            Err(refused) if refused.message.contains("TF401179") => {
                let Some(open) = ado.active_pull_request(&scope.project, repo, branch)? else { return Err(refused) };
                return Err(Error::user(format!(
                    "\"{branch}\" already has an active pull request: #{} {}",
                    open.id, open.title
                ))
                .hint(open.url));
            }
            other => other?,
        };
        // A picture can only be uploaded to a pull request that exists, so the description is finished afterwards.
        match description.filter(Illustrated::has_images) {
            Some(body) => ado.update_pull_request(&pr, None, Some(&body.upload(&ado, &pr)?), None),
            None => Ok(pr),
        }
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

/* ---------------- list ---------------- */

#[derive(Args)]
pub struct List {
    /// The ones you or a team of yours were asked to review, instead of the ones you opened
    #[arg(long)]
    pub review: bool,
    /// Which ones
    #[arg(long, default_value = "active", value_parser = ["active", "completed", "abandoned", "all"])]
    pub state: String,
    /// Open your pull requests in the browser (every project's)
    #[arg(short, long)]
    pub web: bool,
}

/// A reviewer's vote, colored by which way it went.
fn voted(s: Style, vote: &str) -> String {
    match vote {
        "none" => s.dim(vote),
        "approved" | "approved with suggestions" => s.green(vote),
        "rejected" => s.red(vote),
        _ => s.yellow(vote),
    }
}

impl List {
    pub fn run(&self, app: &App) -> Result<Output> {
        let scope = app.scope()?;
        if self.web {
            return Ok(Output::none().web(true, &my_pull_requests_url(&scope.org_url)));
        }
        let ado = app.ado(&scope.org_url);
        let prs = ado.list_pull_requests(&scope.project, &self.state, self.review)?;
        let s = app.style;
        let text = if prs.is_empty() {
            let which = if self.state == "all" { String::new() } else { format!("{} ", self.state) };
            s.dim(&if self.review {
                format!("No {which}pull requests in {} ask you for a review.", scope.project)
            } else {
                format!("You have no {which}pull requests in {}.", scope.project)
            })
        } else {
            let row = |l: &ListedPullRequest| {
                let open = l.open_threads.to_string();
                // Whose it is says more to a reviewer than its branch does; to its author, the other way round.
                let (about, vote) = match &l.review {
                    Some(review) => (l.pr.author.clone(), Some(voted(s, &review.vote))),
                    None => (format!("{} -> {}", l.pr.source_branch, l.pr.target_branch), None),
                };
                let mut row = vec![
                    format!("#{}", l.pr.id),
                    l.pr.title.clone(),
                    l.pr.repo.clone(),
                    about,
                    if l.pr.is_draft { s.dim("draft") } else { l.pr.status.clone() },
                    l.check.as_ref().map_or_else(|| s.dim("none"), |run| s.outcome(run.outcome())),
                    if l.open_threads == 0 { s.dim(&open) } else { s.yellow(&open) },
                ];
                row.extend(vote);
                row
            };
            let rows: Vec<Vec<String>> = prs.iter().map(row).collect();
            let more = (prs.len() == MOST).then(|| s.dim(&format!("\nThe newest {MOST}; there may be more.")));
            let headers: &[&str] = if self.review {
                &["ID", "Title", "Repo", "Author", "State", "Check", "Open threads", "Your vote"]
            } else {
                &["ID", "Title", "Repo", "Branch", "State", "Check", "Open threads"]
            };
            table(headers, &rows) + &more.unwrap_or_default()
        };
        Ok(Output::new(&prs, text))
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
        let location = t.location.as_ref().map_or_else(|| s.dim("(general)"), ThreadLocation::place);
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
    use crate::ado::sections::Section::{Discussion, WorkItems};
    let read = ado.read_pr(&pr, &[Discussion, WorkItems].into())?;
    Ok(PullRequestDetail { work_items: read.work_items, threads: summarize_threads(read.threads), pr })
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

/* ---------------- edit ---------------- */

#[derive(Args)]
pub struct Edit {
    /// PR id or link (default: the current branch's active PR)
    pub id_or_url: Option<String>,
    /// New title ('-' reads stdin)
    #[arg(long)]
    pub title: Option<String>,
    /// New description ('-' reads stdin; `![alt](shot.png)` uploads that file)
    #[arg(long, value_name = "TEXT")]
    pub body: Option<String>,
    /// Put it back into draft
    #[arg(long, conflicts_with = "ready")]
    pub draft: bool,
    /// Take it out of draft: ready for review
    #[arg(long)]
    pub ready: bool,
}

impl Edit {
    pub fn run(&self, app: &App) -> Result<Output> {
        let draft = if self.draft { Some(true) } else { self.ready.then_some(false) };
        match (self.title.as_deref(), self.body.as_deref()) {
            (None, None) if draft.is_none() => {
                return Err(Error::user("Nothing to change.").hint("Pass --title, --body, --draft or --ready."))
            }
            (Some("-"), Some("-")) => return Err(Error::user("Only one of --title and --body can read stdin.")),
            _ => {}
        }
        let (pr, ado) = find_pull_request(app, self.id_or_url.as_deref())?;
        let title = self.title.as_deref().map(|title| app.text(Some(title), "title")).transpose()?;
        let body = match &self.body {
            Some(body) => Some(illustrated(app, &ado, &pr, app.text(Some(body), "body")?)?),
            None => None,
        };
        let pr = ado.update_pull_request(&pr, title.as_deref(), body.as_deref(), draft)?;
        let s = app.style;
        let text = format!(
            "{} PR {}{} — {}\n{}",
            s.green("Updated"),
            s.bold(&format!("#{}", pr.id)),
            if pr.is_draft { " [draft]" } else { "" },
            pr.title,
            s.dim(&format!("  {}", pr.url))
        );
        Ok(Output::new(&pr, text))
    }
}

/// Text for a pull request, once the files its images point at are uploaded there.
fn illustrated(app: &App, ado: &AdoClient, pr: &PullRequest, text: String) -> Result<String> {
    Illustrated::read(text, app.git.cwd())?.upload(ado, pr)
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
    /// On lines of a file the PR changes: path:line, or path:first-last
    #[arg(long, value_name = "PLACE")]
    pub at: Option<String>,
    /// With --at: the lines are the old file's, as it was before the PR
    #[arg(long, requires = "at")]
    pub old: bool,
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
pub struct Amend {
    /// PR id or link
    pub pr: String,
    /// Thread id
    pub thread: String,
    /// The comment as it should now read ('-' or nothing reads stdin)
    pub text: Option<String>,
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
    /// The pull requests you opened in this project, or were asked to review, each with its check and open threads
    List(List),
    /// A PR with its work items and review threads (default: the current branch's)
    View(View),
    /// Change a PR's title or description, or move it in or out of draft (default: the current branch's)
    Edit(Edit),
    /// What a PR changes, file by file, without a clone (default: the current branch's)
    Diff(Diff),
    /// Start a review thread: about the whole PR, or on lines of a file it changes
    Comment(Comment),
    /// Every comment in one review thread
    Thread(ThreadArgs),
    /// Reply in a review thread
    Reply(Reply),
    /// Rewrite your last comment in a review thread
    Amend(Amend),
    /// Set a review thread's status (default: resolved)
    Resolve(Resolve),
}

impl Pr {
    pub fn run(&self, app: &App) -> Result<Output> {
        let s = app.style;
        match self {
            Pr::Create(c) => c.run(app),
            Pr::List(c) => c.run(app),
            Pr::View(c) => c.run(app),
            Pr::Edit(c) => c.run(app),
            Pr::Diff(c) => c.run(app),
            Pr::Comment(c) => {
                let (pr, ado) = find_pull_request(app, Some(&c.pr))?;
                // A place that isn't in the pull request is found out before anything is read or posted.
                let at = c.at.as_deref().map(|at| anchor(&ado, &pr, at, c.old)).transpose()?;
                let comment = illustrated(app, &ado, &pr, app.text(c.text.as_deref(), "comment")?)?;
                let thread = ado.add_comment(&pr, &comment, at.as_ref())?;
                let place = thread.location.as_ref().map_or(String::new(), |l| format!(", at {}", l.place()));
                let text = format!("{} thread #{} on PR #{}{place}.", s.green("Posted"), thread.id, pr.id);
                let mut posted = json!({ "prId": pr.id, "threadId": thread.id });
                if let Some(location) = &thread.location {
                    posted["location"] = json!(location);
                }
                Ok(Output::new(&posted, text))
            }
            Pr::Thread(c) => {
                let (pr, ado) = find_pull_request(app, Some(&c.pr))?;
                let thread = ado.placed_thread(&pr, thread_id(&c.thread)?)?;
                Ok(Output::new(&ThreadOnPr { pr_id: pr.id, thread: &thread }, render_thread(&thread, pr.id, s)))
            }
            Pr::Reply(c) => {
                // Everything that can be wrong with the request is found before anything is posted.
                let id = thread_id(&c.thread)?;
                let status = c.resolve.as_deref().map(parse_thread_status).transpose()?;
                let (pr, ado) = find_pull_request(app, Some(&c.pr))?;
                ado.reply(&pr, id, &illustrated(app, &ado, &pr, app.text(c.text.as_deref(), "reply")?)?)?;
                if let Some(status) = status {
                    ado.set_thread_status(&pr, id, status)?;
                }
                let now = status.map_or(String::new(), |status| format!(", now {status}"));
                let text = format!("{} in thread #{id} on PR #{}{now}.", s.green("Replied"), pr.id);
                Ok(Output::new(&json!({ "prId": pr.id, "threadId": id, "status": status }), text))
            }
            Pr::Amend(c) => {
                let id = thread_id(&c.thread)?;
                let (pr, ado) = find_pull_request(app, Some(&c.pr))?;
                let comment = illustrated(app, &ado, &pr, app.text(c.text.as_deref(), "comment")?)?;
                let amended = ado.amend_comment(&pr, id, &comment)?;
                let text = format!("{} your comment in thread #{id} on PR #{}.", s.green("Amended"), pr.id);
                Ok(Output::new(&json!({ "prId": pr.id, "threadId": id, "commentId": amended }), text))
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
        t.location.as_ref().map_or_else(|| s.dim("(general comment)"), ThreadLocation::place),
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
    fn a_second_pull_request_for_the_branch_names_the_one_already_open() {
        let bed = Bed::new(Box::new(|r: &Recorded| {
            if r.method == "POST" {
                let refused = json!({ "message": "TF401179: An active pull request for the source and target branch already exists." });
                Some(crate::testing::json_response(409, refused))
            } else {
                ok(json!({ "value": [rest_pr(7, json!({}))] }))
            }
        }));
        let res = cli(bed.app(), &["pr", "create", "--title", "Again", "--target", "main"]);
        assert_eq!(res.code, 1, "{}", res.stderr);
        assert!(res.stderr.contains("\"feature/x\" already has an active pull request: #7 PR 7"), "{}", res.stderr);
        assert!(res.stderr.contains("https://dev.azure.com/contoso/MyProject/_git/web/pullrequest/7"));
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

    fn run_on(id: u64, repo: &str, branch: &str, result: u64) -> Value {
        json!({"run": {"id":id, "repository":{"id":repo}, "sourceBranch":branch, "status":2, "result":result,
                       "queueTime":format!("2026-01-01T00:00:{id:02}Z")}})
    }

    fn list_page(req: &Recorded, runs: Value) -> Value {
        let props = &req.body["dataProviderContext"]["properties"];
        let mut providers = json!({"ms.vss-build-web.runs-data-provider":{"runs":runs}});
        if let Some(artifacts) = props["artifactIds"].as_array() {
            let counts: Vec<_> = artifacts
                .iter()
                .rev()
                .map(|a| {
                    let id = &a["artifactId"];
                    let count = u64::from(id == "vstfs:///Git/PullRequestId/p%2Fr%2F9");
                    json!({"pullRequestArtifactId":id, "activeCommentsCount":count})
                })
                .collect();
            providers["ms.vss-code-web.pullrequests-artifact-stats-data-provider"] =
                json!({"TFS.VersionControl.PullRequestListArtifactStatsProvider.artifactStats":counts});
        }
        json!({"dataProviders": providers})
    }

    fn mine(prs: Value) -> Route {
        Box::new(move |r| {
            if r.path.ends_with("/connectionData") {
                ok(json!({ "authenticatedUser": { "id": "me-1" } }))
            } else if r.path.ends_with("/pullrequests") {
                ok(json!({ "value": prs }))
            } else if r.path.ends_with("/HierarchyQuery/project/p") {
                ok(list_page(r, json!([run_on(2, "r", "refs/pull/9/merge", 8)])))
            } else {
                None
            }
        })
    }

    fn asked_for_the_list(bed: &Bed) -> Recorded {
        bed.ado.requests().into_iter().find(|r| r.path.ends_with("/pullrequests")).unwrap()
    }

    #[test]
    fn lists_only_the_pull_requests_you_opened_each_with_its_check_and_open_threads() {
        let draft = rest_pr(
            8,
            json!({ "isDraft": true, "repository": { "id":"api-id", "name":"api", "project":{"id":"p","name":"MyProject"} } }),
        );
        let bed = Bed::new(mine(json!([rest_pr(9, json!({})), draft])));
        let listed = cli(bed.app(), &["pr", "list", "--json"]).json();
        let seen = |at: usize| (&listed[at]["id"], &listed[at]["check"]["result"], &listed[at]["openThreads"]);
        assert_eq!(seen(0), (&json!(9), &json!("failed"), &json!(1)));
        assert_eq!(seen(1), (&json!(8), &Value::Null, &json!(0)));

        let asked = asked_for_the_list(&bed);
        assert_eq!(asked.path, "/MyProject/_apis/git/pullrequests");
        assert_eq!(asked.query("searchCriteria.creatorId").as_deref(), Some("me-1"));
        assert_eq!(asked.query("searchCriteria.status").as_deref(), Some("active"));

        let screen = cli(bed.app(), &["pr", "list"]).stdout;
        let row = |id: &str| screen.lines().find(|line| line.contains(id)).unwrap().to_string();
        assert_eq!(row("#9"), "│ #9 │ PR 9  │ web  │ feature/x -> main │ active │ failed │ 1            │");
        assert_eq!(row("#8"), "│ #8 │ PR 8  │ api  │ feature/x -> main │ draft  │ none   │ 0            │");
    }

    #[test]
    fn uses_the_first_validation_run_for_each_requested_ref() {
        let search =
            mine(json!([rest_pr(9, json!({"supportsIterations":true, "codeReviewId":45})), rest_pr(8, json!({}))]));
        let bed = Bed::new(Box::new(move |r| {
            if !r.path.ends_with("/HierarchyQuery/project/p") {
                return search(r);
            }
            let props = &r.body["dataProviderContext"]["properties"];
            assert_eq!(props["keywordFilter"], "refs/pull/9/merge,refs/pull/8/merge");
            assert!(props["continuationToken"].is_null());
            assert_eq!(props["artifactIds"][0]["discussionArtifactId"], "vstfs:///CodeReview/ReviewId/p%2F45");
            assert_eq!(props["artifactIds"][1]["discussionArtifactId"], "vstfs:///CodeReview/CodeReviewId/p%2F8");
            ok(list_page(
                r,
                json!([
                    run_on(2, "r", "refs/pull/9/merge", 8),
                    run_on(1, "r", "refs/pull/9/merge", 2),
                    run_on(5, "r", "refs/pull/8/merge", 2),
                    run_on(7, "other", "refs/pull/8/merge", 8)
                ]),
            ))
        }));
        let rows = cli(bed.app(), &["pr", "list", "--json"]).json();
        assert_eq!((&rows[0]["check"]["id"], &rows[1]["check"]["id"]), (&json!(2), &json!(5)));
        assert_eq!(bed.ado.requests().len(), 3); // Identity, search and one enrichment request.
    }

    #[test]
    fn a_pull_request_nothing_ran_for_has_no_check() {
        let bed = Bed::new(mine(json!([rest_pr(7, json!({ "sourceRefName": "refs/heads/docs" }))])));
        assert_eq!(cli(bed.app(), &["pr", "list", "--jq", ".[0].check"]).stdout, "null\n");
        assert!(cli(bed.app(), &["pr", "list"]).stdout.contains("│ active │ none  │ 0 "));
    }

    #[test]
    fn lists_other_states_and_says_when_there_is_nothing() {
        let bed = Bed::new(mine(json!([])));
        let res = cli(bed.app(), &["pr", "list", "--state", "completed"]);
        assert_eq!((res.code, res.stdout.as_str()), (0, "You have no completed pull requests in MyProject.\n"));
        assert_eq!(asked_for_the_list(&bed).query("searchCriteria.status").as_deref(), Some("completed"));
        assert_eq!(cli(bed.app(), &["pr", "list", "--json"]).json(), json!([]));

        let bed = Bed::new(mine(json!([])));
        assert_eq!(cli(bed.app(), &["pr", "list", "--state", "open"]).code, 1);
        assert!(bed.ado.requests().is_empty());
    }

    /// Signed in as `me-1`, who is in the team Payments.
    fn asked(by_name: Value, through_the_team: Value) -> Route {
        let other = mine(json!([]));
        Box::new(move |r: &Recorded| {
            if r.path.ends_with("/HierarchyQuery/project/MyProject") {
                assert_eq!(r.method, "POST");
                let props = &r.body["dataProviderContext"]["properties"];
                assert_eq!(props["queryIds"], json!(["AssignedToMe", "AssignedToMyTeams"]));
                assert_eq!(props["sourcePage"]["routeValues"]["project"], "MyProject");
                assert_eq!(props["top"], 100);
                let mut prs = json!({});
                let mut query_results = json!({});
                for (section, list) in [("AssignedToMe", &by_name), ("AssignedToMyTeams", &through_the_team)] {
                    let mut ids = Vec::new();
                    for pr in list.as_array()? {
                        let id = pr["pullRequestId"].as_u64()?;
                        ids.push(id);
                        prs[id.to_string()] = pr.clone();
                    }
                    query_results[section] = json!({"ids":ids});
                }
                ok(json!({"dataProviders": {
                    "ms.vss-code-web.prs-list-data-provider": {
                        "queries": [{"id":"AssignedToMe", "readonly":true, "status":1, "reviewerIds":["me-1"]},
                                    {"id":"AssignedToMyTeams", "status":1, "myTeamsAsReviewer":true}],
                        "queryResults":query_results, "pullRequests": prs
                    },
                    "ms.vss-dashboards-web.my-team-list-data-provider": [{"value":{"id":"TEAM-1","name":"Payments"}}]
                }}))
            } else {
                other(r)
            }
        })
    }

    #[test]
    fn lists_what_you_were_asked_to_review_by_name_or_through_a_team_but_not_your_own() {
        let team = json!({ "id": "team-1", "vote": 0, "isContainer": true });
        // Azure DevOps writes the same id in either case.
        let approved = rest_pr(9, json!({ "reviewers": [team, { "id": "ME-1", "vote": 10 }] }));
        let theirs = rest_pr(
            12,
            json!({ "createdBy": { "id": "jo-2", "displayName": "Jo" }, "reviewers": [{"id":"other-team","isContainer":true},team] }),
        );
        let own = rest_pr(11, json!({ "createdBy": { "id": "me-1", "displayName": "Me" }, "reviewers": [team] }));
        let bed = Bed::new(asked(json!([approved]), json!([theirs, own, approved])));

        let listed = cli(bed.app(), &["pr", "list", "--review", "--json"]).json();
        let seen: Vec<_> = listed.as_array().unwrap().iter().map(|l| (&l["id"], &l["review"])).collect();
        let stands = |vote: &str, team: Value| json!({ "vote": vote, "team": team });
        // Newest first, each once, and the one you opened yourself left out.
        assert_eq!(
            seen,
            [(&json!(12), &stands("none", json!("Payments"))), (&json!(9), &stands("approved", json!(null)))]
        );

        let calls = bed.ado.requests();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].path, "/_apis/Contribution/HierarchyQuery/project/MyProject");
        assert_eq!(calls[1].body["contributionIds"].as_array().unwrap().len(), 2);

        let screen = cli(bed.app(), &["pr", "list", "--review"]).stdout;
        let row = |id: &str| screen.lines().find(|line| line.contains(id)).unwrap().to_string();
        assert!(screen.contains("│ Author │ State  │ Check  │ Open threads │ Your vote │"), "{screen}");
        assert_eq!(row("#12"), "│ #12 │ PR 12 │ web  │ Jo     │ active │ none   │ 0            │ none      │");
        assert_eq!(row("#9"), "│ #9  │ PR 9  │ web  │ Jane   │ active │ failed │ 1            │ approved  │");
    }

    #[test]
    fn an_active_review_list_with_validation_takes_two_requests() {
        let pr = rest_pr(9, json!({"createdBy":{"id":"me-1"}, "reviewers":[{"id":"ME-1","vote":10}]}));
        // The portal can put a PR shared by both sections in just one of them.
        let bed = Bed::new(asked(json!([]), json!([pr])));
        let rows = cli(bed.app(), &["pr", "list", "--review", "--json"]).json();
        assert_eq!(rows[0]["review"], json!({"vote":"approved","team":null}));
        assert_eq!(bed.ado.requests().len(), 2);
    }

    #[test]
    fn says_when_nothing_asks_you_for_a_review_and_leaves_the_plain_list_as_it_was() {
        let bed = Bed::new(asked(json!([]), json!([])));
        let res = cli(bed.app(), &["pr", "list", "--review"]);
        assert_eq!(
            (res.code, res.stdout.as_str()),
            (0, "No active pull requests in MyProject ask you for a review.\n")
        );

        // Without the flag nothing about a review is asked for or printed.
        let bed = Bed::new(mine(json!([rest_pr(9, json!({}))])));
        assert!(cli(bed.app(), &["pr", "list", "--json"]).json()[0].get("review").is_none());
        assert!(bed.ado.requests().iter().all(|r| !r.path.ends_with("/_apis/teams")));
        assert_eq!(bed.ado.requests().len(), 3); // Identity, PR search and one enrichment request.
    }

    /// PR 9, pushed to twice. Thread 4 was written on lines 16-17 of the first push, which the second moved
    /// down by two; thread 5 is on a line of the old file.
    fn commented() -> Route {
        Box::new(move |r: &Recorded| {
            let on = |side: &str, first: u64, last: u64| json!({ "filePath": "/src/a.ts", format!("{side}FileStart"): { "line": first, "offset": 1 }, format!("{side}FileEnd"): { "line": last, "offset": 4 } });
            let thread = |id: u64, at: Value| json!({ "id": id, "status": "active", "threadContext": at, "comments": [{ "id": 1, "content": "why" }] });
            let written_first = thread(4, on("right", 18, 19));
            if r.path.ends_with("/threads/4") {
                assert_eq!(r.query("$iteration").as_deref(), Some("2"));
                ok(written_first)
            } else if r.path.contains("/HierarchyQuery/") {
                // Thread 6's lines are gone, which Azure DevOps says as line 0; thread 7 is about a whole file.
                let gone = thread(6, on("right", 0, 0));
                let whole = thread(7, json!({ "filePath": "/src/a.ts" }));
                // Thread 8 is on a file the second push deleted again, which Azure DevOps leaves where it was.
                let mut left = thread(8, on("right", 2, 2));
                left["threadContext"]["filePath"] = json!("/src/dropped.ts");
                crate::testing::review_page(
                    2,
                    "head",
                    json!([{"changeType":"edit","item":{"path":"/src/a.ts","objectId":"b","originalObjectId":"a"}}]),
                    json!([written_first, thread(5, on("left", 3, 3)), gone, whole, left]),
                )
            } else if r.path.ends_with("/workitems") {
                ok(json!({ "value": [] }))
            } else {
                ok(rest_pr(9, json!({})))
            }
        })
    }

    #[test]
    fn a_thread_is_placed_where_it_is_after_the_latest_push_on_the_side_it_is_on() {
        let bed = Bed::new(commented());
        let view = cli(bed.app(), &["pr", "view", "9", "--json"]).json();
        let place = |line: u64, end: u64, side: &str| json!({ "file": "/src/a.ts", "line": line, "endLine": end, "side": side, "outdated": false });
        assert_eq!(view["threads"][0]["location"], place(18, 19, "new"));
        assert_eq!(view["threads"][1]["location"], place(3, 3, "old"));
        // On no line: because its lines went, or because it never was on one.
        let nowhere = |side: Value, outdated: bool| json!({ "file": "/src/a.ts", "line": null, "endLine": null, "side": side, "outdated": outdated });
        assert_eq!(view["threads"][2]["location"], nowhere(json!("new"), true));
        assert_eq!(view["threads"][3]["location"], nowhere(json!(null), false));
        let dropped =
            json!({ "file": "/src/dropped.ts", "line": null, "endLine": null, "side": "new", "outdated": true });
        assert_eq!(view["threads"][4]["location"], dropped);

        let screen = cli(bed.app(), &["pr", "view", "9"]).stdout;
        assert!(screen.contains("/src/a.ts:18-19 ") && screen.contains("/src/a.ts:3 (old) "), "{screen}");
        assert!(
            screen.contains("#6  open  /src/a.ts (its lines have since gone) ")
                && screen.contains("#7  open  /src/a.ts  "),
            "{screen}"
        );
        assert_eq!(cli(bed.app(), &["pr", "thread", "9", "4", "--json"]).json()["location"], place(18, 19, "new"));

        let bed = Bed::new(Box::new(|r| {
            if r.path.contains("/HierarchyQuery/") {
                return Some(crate::testing::json_response(403, json!({"message":"denied"})));
            }
            commented()(r)
        }));
        let failed = cli(bed.app(), &["pr", "view", "9"]);
        assert!(failed.stderr.contains("denied"), "{}", failed.stderr);
        assert!(bed.ado.requests().iter().all(|r| !r.path.ends_with("/threads") && !r.path.ends_with("/iterations")));
    }

    #[test]
    fn a_picture_in_the_description_is_uploaded_once_the_pull_request_exists() {
        use base64::Engine;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shot.png");
        std::fs::write(&file, b"\x89PNG bytes").unwrap();
        let bed = Bed::new(Box::new(|r: &Recorded| match r.method.as_str() {
            "POST" if r.path.contains("/attachments/") => {
                ok(json!({ "url": "https://dev.azure.com/contoso/up/shot.png" }))
            }
            "POST" | "PATCH" => ok(rest_pr(9, json!({ "description": r.body["description"] }))),
            _ => None,
        }));
        let body = format!("See ![the screen](<{}>) and ![web](https://example.com/x.png)", file.display());
        let made = cli(bed.app(), &["pr", "create", "--title", "T", "--target", "main", "--body", &body, "--json"]);
        let shown =
            "See ![the screen](<https://dev.azure.com/contoso/up/shot.png>) and ![web](https://example.com/x.png)";
        assert_eq!(made.json()["description"], shown, "{}", made.stderr);

        let requests = bed.ado.requests();
        let [create, upload, finish] = requests.as_slice() else { panic!("{} requests", requests.len()) };
        assert_eq!(create.body["description"], json!(body), "created with the text as written");
        assert!(upload.path.contains("/pullRequests/9/attachments/shot-") && upload.path.ends_with(".png"));
        assert_eq!(upload.raw.content_type.as_deref(), Some("application/octet-stream"));
        let sent = base64::engine::general_purpose::STANDARD.decode(upload.raw.body.as_deref().unwrap()).unwrap();
        assert_eq!((upload.raw.base64, sent.as_slice()), (true, b"\x89PNG bytes".as_slice()));
        assert_eq!((finish.method.as_str(), &finish.body), ("PATCH", &json!({ "description": shown })));

        // A picture that isn't there stops the command before anything is created.
        let bed = Bed::new(route());
        assert_eq!(cli(bed.app(), &["pr", "create", "--title", "T", "--body", "![x](/no/such/file.png)"]).code, 1);
        assert!(bed.ado.requests().is_empty());
    }

    #[test]
    fn edit_changes_only_what_it_is_given() {
        let bed = Bed::new(Box::new(|r: &Recorded| ok(rest_pr(7, json!({ "title": r.body["title"] })))));
        assert_eq!(cli(bed.app(), &["pr", "edit", "7", "--title", "Better", "--jq", ".title"]).stdout, "Better\n");
        let patch = bed.ado.requests().pop().unwrap();
        assert_eq!(
            (patch.method.as_str(), patch.path.as_str(), &patch.body),
            ("PATCH", "/MyProject/_apis/git/repositories/web/pullrequests/7", &json!({ "title": "Better" }))
        );

        // In and out of draft.
        assert_eq!(cli(bed.app(), &["pr", "edit", "7", "--draft"]).code, 0);
        assert_eq!(bed.ado.requests().pop().unwrap().body, json!({ "isDraft": true }));
        assert_eq!(cli(bed.app(), &["pr", "edit", "7", "--ready", "--title", "Done"]).code, 0);
        assert_eq!(bed.ado.requests().pop().unwrap().body, json!({ "isDraft": false, "title": "Done" }));

        let bed = Bed::new(route());
        assert_eq!(cli(bed.app(), &["pr", "edit", "7"]).code, 1);
        assert_eq!(cli(bed.app(), &["pr", "edit", "7", "--draft", "--ready"]).code, 1);
        assert!(bed.ado.requests().is_empty());
    }

    #[test]
    fn amend_rewrites_your_last_comment_and_nobody_elses() {
        let bed = Bed::new(Box::new(|r: &Recorded| {
            let by = |id: u64, who: &str| json!({ "id": id, "content": "x", "author": { "id": who } });
            match (r.method.as_str(), r.path.as_str()) {
                ("GET", p) if p.ends_with("/connectionData") => ok(json!({ "authenticatedUser": { "id": "me" } })),
                ("GET", p) if p.ends_with("/pullrequests/7") => ok(rest_pr(7, json!({}))),
                ("GET", p) if p.ends_with("/threads/3") => {
                    ok(json!({ "id": 3, "comments": [by(1, "me"), by(2, "me"), by(3, "someone-else")] }))
                }
                ("GET", p) if p.ends_with("/threads/4") => ok(json!({ "id": 4, "comments": [by(1, "someone-else")] })),
                ("PATCH", _) => ok(json!({})),
                _ => None,
            }
        }));
        let amended = cli(bed.app(), &["pr", "amend", "7", "3", "What I meant", "--json"]);
        assert_eq!(amended.json(), json!({ "prId": 7, "threadId": 3, "commentId": 2 }), "{}", amended.stderr);
        let patch = bed.ado.requests().pop().unwrap();
        assert!(patch.path.ends_with("/pullRequests/7/threads/3/comments/2"), "{}", patch.path);
        assert_eq!(patch.body, json!({ "content": "What I meant" }));

        let none = cli(bed.app(), &["pr", "amend", "7", "4", "x"]);
        assert_eq!((none.code, none.stderr.contains("You have no comment in thread #4 on PR #7.")), (2, true));
        assert!(!bed.ado.requests().iter().any(|r| r.method == "PATCH" && r.path.contains("/threads/4/")));
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
