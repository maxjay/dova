//! Work items: reading them, finding them, filing them.

use clap::{Args, Subcommand};
use serde::Serialize;
use serde_json::{json, Value};
use url::Url;

use super::link::link;
use super::pr::{find_pull_request, pull_request_detail, render_pull_request};
use super::work_item_table;
use crate::ado::client::{AdoClient, NewWorkItem};
use crate::ado::types::{WorkItem, WorkItemRef};
use crate::app::{App, ScopeHint};
use crate::cli::Output;
use crate::error::{Error, Kind, Result};
use crate::par;
use crate::text::{truncate, Style};
use crate::urls::{enc, looks_like_url, parse_id, parse_work_item_link};

/* ---------------- view ---------------- */

#[derive(Debug, Serialize)]
pub struct Detail {
    #[serde(flatten)]
    pub item: WorkItem,
    pub parent: Option<WorkItemRef>,
    pub children: Vec<WorkItemRef>,
}

pub fn work_item_detail(app: &App, id_or_url: &str) -> Result<Detail> {
    let link = parse_work_item_link(id_or_url);
    let id = link.as_ref().map(|l| l.id).or_else(|| parse_id(id_or_url));
    let id = id.ok_or_else(|| Error::user(format!("\"{id_or_url}\" isn't a work item id or link.")))?;
    // A link names its own organization; a bare id is in the one you're in.
    let hint = link.map(|l| ScopeHint { org: Some(l.org), project: Some(l.project), repo: None });
    let ado = app.ado(&app.scope_for(&hint.unwrap_or_default())?.org_url);

    let item = ado.work_item(id)?;
    let (parent, children) = par::join(
        || item.parent_id.map_or(Ok(Vec::new()), |parent| ado.work_items(&[parent])),
        || ado.query(&format!("SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = {id}")),
    );
    Ok(Detail {
        parent: parent?.first().map(WorkItem::to_ref),
        children: children?.iter().map(WorkItem::to_ref).collect(),
        item,
    })
}

fn render_work_item(d: &Detail, s: Style, full: bool) -> String {
    let text = |value: &Option<String>| value.clone().unwrap_or_else(|| "?".into());
    let assigned = d.item.assigned_to.as_ref().map_or("unassigned".to_string(), |who| format!("assigned to {who}"));
    let mut out = vec![
        format!("{} {}", s.bold(&format!("#{}", d.item.id)), text(&d.item.title)),
        s.dim(&format!("{} · {} · {assigned}", text(&d.item.kind), text(&d.item.state))),
        String::new(),
        format!("Area:      {}", text(&d.item.area_path)),
        format!("Iteration: {}", text(&d.item.iteration_path)),
    ];
    if let Some(parent) = &d.parent {
        out.push(format!(
            "Parent:    #{} {} {}",
            parent.id,
            text(&parent.title),
            s.dim(&format!("[{}]", text(&parent.kind)))
        ));
    }
    out.extend([String::new(), s.dim(&d.item.url)]);
    for section in &d.item.body {
        let (shown, cut) = if full { (section.text.clone(), false) } else { truncate(&section.text, 800) };
        out.extend([String::new(), s.bold(&section.label), shown]);
        if cut {
            out.push(s.dim("  … truncated — --full for the rest"));
        }
    }
    if !d.children.is_empty() {
        out.extend([String::new(), s.bold(&format!("Children ({})", d.children.len())), work_item_table(&d.children)]);
    }
    out.join("\n")
}

#[derive(Args)]
pub struct View {
    /// Work item id or link
    pub id_or_url: String,
    /// Show the description in full
    #[arg(long)]
    pub full: bool,
    /// Open it in the browser
    #[arg(short, long)]
    pub web: bool,
}

impl View {
    pub fn run(&self, app: &App) -> Result<Output> {
        let detail = work_item_detail(app, &self.id_or_url)?;
        Ok(Output::new(&detail, render_work_item(&detail, app.style, self.full)).web(self.web, &detail.item.url))
    }
}

/// `dova view`: a work item or a PR, from an id or link. A bare id tries
/// work items first: they're what people look up by number.
#[derive(Args)]
pub struct ViewAny {
    /// Work item or PR id, or a link to either
    pub id_or_url: String,
    /// Nothing truncated
    #[arg(long)]
    pub full: bool,
    /// Open it in the browser
    #[arg(short, long)]
    pub web: bool,
}

/// The data with a `kind` in front, so a reader can tell which of the two it got.
fn tagged(kind: &str, data: &impl Serialize) -> Value {
    let mut tagged = json!({ "kind": kind });
    if let (Some(tagged), Ok(Value::Object(fields))) = (tagged.as_object_mut(), serde_json::to_value(data)) {
        tagged.extend(fields);
    }
    tagged
}

impl ViewAny {
    pub fn run(&self, app: &App) -> Result<Output> {
        let target = self.id_or_url.as_str();
        let work_item = || {
            let detail = work_item_detail(app, target)?;
            let text = render_work_item(&detail, app.style, self.full);
            Ok(Output::new(&tagged("work-item", &detail), text).web(self.web, &detail.item.url))
        };
        let pull_request = || {
            let (pr, ado) = find_pull_request(app, Some(target))?;
            let detail = pull_request_detail(pr, &ado)?;
            let text = render_pull_request(&detail, app.style, self.full);
            Ok(Output::new(&tagged("pull-request", &detail), text).web(self.web, &detail.pr.url))
        };
        // A link says which it is. An id could be either.
        if looks_like_url(target) {
            return if parse_work_item_link(target).is_some() { work_item() } else { pull_request() };
        }
        let neither = || Error::not_found(format!("{target} is neither a work item nor a pull request."));
        match work_item() {
            Err(err) if err.kind == Kind::NotFound => {
                pull_request().map_err(|err| if err.kind == Kind::NotFound { neither() } else { err })
            }
            found => found,
        }
    }
}

/* ---------------- search ---------------- */

#[derive(Args)]
pub struct Search {
    /// Words in the title
    pub query: Option<String>,
    /// In this state
    #[arg(long)]
    pub state: Option<String>,
    /// Of this type
    #[arg(long = "type", value_name = "TYPE")]
    pub kind: Option<String>,
    /// Assigned to ("me" for yourself)
    #[arg(long, value_name = "USER")]
    pub assignee: Option<String>,
    /// With this tag
    #[arg(long)]
    pub tag: Option<String>,
}

fn is_me(user: &str) -> bool {
    user.trim_start_matches('@').eq_ignore_ascii_case("me")
}

impl Search {
    pub fn run(&self, app: &App) -> Result<Output> {
        let scope = app.scope()?;
        let quoted = |value: &str| format!("'{}'", value.replace('\'', "''"));
        let clause = |field: &str, op: &str, value: &Option<String>| {
            value.as_ref().map(|value| format!("[System.{field}] {op} {}", quoted(value)))
        };
        let assigned = self.assignee.as_ref().map(|user| if is_me(user) { "@Me".to_string() } else { quoted(user) });
        let filters = [
            Some(format!("[System.TeamProject] = {}", quoted(&scope.project))),
            clause("Title", "CONTAINS", &self.query),
            clause("State", "=", &self.state),
            clause("WorkItemType", "=", &self.kind),
            clause("Tags", "CONTAINS", &self.tag),
            assigned.map(|who| format!("[System.AssignedTo] = {who}")),
        ];
        let filters: Vec<String> = filters.into_iter().flatten().collect();
        let wiql = format!(
            "SELECT [System.Id] FROM WorkItems WHERE {} ORDER BY [System.ChangedDate] DESC",
            filters.join(" AND ")
        );
        let items: Vec<WorkItemRef> = app.ado(&scope.org_url).query(&wiql)?.iter().map(WorkItem::to_ref).collect();

        let text = if items.is_empty() { app.style.dim("Nothing matched.") } else { work_item_table(&items) };
        Ok(Output::new(&json!({ "items": items }), text))
    }
}

/* ---------------- where a new item goes ---------------- */

#[derive(Args, Default)]
pub struct PlaceArgs {
    /// The team whose area and current sprint it goes in (default: remembered for this repo)
    #[arg(long)]
    pub team: Option<String>,
    /// Area path, instead of the team's
    #[arg(long, value_name = "PATH")]
    pub area: Option<String>,
    /// Iteration path, instead of the team's current sprint
    #[arg(long, value_name = "PATH")]
    pub iteration: Option<String>,
    /// Copy area and iteration from this work item instead
    #[arg(long, value_name = "ID", conflicts_with_all = ["team", "area", "iteration"])]
    pub like: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct Place {
    pub area: String,
    pub iteration: String,
    /// The team they came from, when one was looked up.
    pub team: Option<String>,
    pub warnings: Vec<String>,
}

/// The area and iteration for a new work item: copied from another item
/// (--like), given outright, or the team's default area and current
/// sprint. The sprint is looked up every time, so it is never last month's.
pub fn resolve_place(app: &App, ado: &AdoClient, project: &str, flags: &PlaceArgs) -> Result<Place> {
    let place = |area: &str, iteration: &str| Place {
        area: area.into(),
        iteration: iteration.into(),
        team: None,
        warnings: vec![],
    };
    if let Some(like) = &flags.like {
        let id = parse_id(like).ok_or_else(|| Error::user(format!("--like \"{like}\" isn't a work item id.")))?;
        let example = ado.work_item(id)?;
        return match (&example.area_path, &example.iteration_path) {
            (Some(area), Some(iteration)) => Ok(place(area, iteration)),
            _ => Err(Error::not_found(format!("#{id} has no area or iteration to copy."))),
        };
    }
    if let (Some(area), Some(iteration)) = (&flags.area, &flags.iteration) {
        return Ok(place(area, iteration));
    }

    let team = match &flags.team {
        Some(team) => team.clone(),
        None => repo_team(app, ado, project)?,
    };
    let (areas, sprint) = par::join(
        || if flags.area.is_none() { ado.team_areas(project, &team).map(Some) } else { Ok(None) },
        || if flags.iteration.is_none() { ado.current_iteration(project, &team) } else { Ok(None) },
    );
    let area = match (&flags.area, areas?) {
        (Some(area), _) => area.clone(),
        (None, Some(areas)) if !areas.default_area.is_empty() => areas.default_area,
        (None, Some(mut areas)) if areas.areas.len() == 1 => areas.areas.remove(0),
        (None, Some(areas)) if !areas.areas.is_empty() => (app.choose)(
            &format!("Team \"{team}\" has no default area. Which one?"),
            &areas.areas,
            "Pass --area <path>.",
        )?,
        _ => return Err(Error::not_found(format!("Team \"{team}\" has no area paths.")).hint("Pass --area <path>.")),
    };
    let mut warnings = Vec::new();
    let iteration = flags.iteration.clone().or(sprint?).unwrap_or_else(|| {
        // The root iteration is always named after the project.
        warnings.push(format!("Team \"{team}\" has no current sprint; using the project's root iteration."));
        project.to_string()
    });
    Ok(Place { area, iteration, team: Some(team), warnings })
}

/// The team this repo's work items go to: remembered in git config
/// (`dova.team`), or the project's only team, or the one you pick — which
/// is then remembered.
fn repo_team(app: &App, ado: &AdoClient, project: &str) -> Result<String> {
    if let Some(team) = app.git.config_get("dova.team")? {
        return Ok(team);
    }
    let mut teams = ado.teams(project)?;
    match teams.len() {
        0 => Err(Error::not_found(format!("Project \"{project}\" has no teams."))),
        1 => Ok(teams.remove(0)),
        _ => {
            let team = (app.choose)(&format!("Which team in \"{project}\"?"), &teams, "Pass --team <name>.")?;
            app.git.config_set("dova.team", &team)?;
            Ok(team)
        }
    }
}

/* ---------------- create ---------------- */

#[derive(Args, Default)]
pub struct CreateArgs {
    /// The title ('-' or nothing reads stdin)
    pub title: Option<String>,
    /// Description ('-' reads stdin)
    #[arg(long, value_name = "TEXT")]
    pub body: Option<String>,
    /// Make it a child of this work item
    #[arg(long, value_name = "ID")]
    pub parent: Option<String>,
    /// Assign it ("me" for yourself)
    #[arg(long, value_name = "USER")]
    pub assignee: Option<String>,
    /// Add a "Found in:" link to this line at HEAD
    #[arg(long, value_name = "FILE:LINE")]
    pub at: Option<String>,
    /// Also link it to the current branch
    #[arg(long)]
    pub link: bool,
    /// Open the new work item in the browser
    #[arg(short, long)]
    pub web: bool,
    #[command(flatten)]
    pub place: PlaceArgs,
}

#[derive(Debug, Serialize)]
pub struct Created {
    #[serde(flatten)]
    pub item: WorkItem,
    pub team: Option<String>,
    pub warnings: Vec<String>,
    /// The branch it was linked to, with --link.
    pub linked: Option<String>,
}

/// A link to `file[:line]` in the repo, at the commit that's checked out.
fn permalink(app: &App, at: &str) -> Result<String> {
    let scope = app.scope()?;
    let repo = scope.need_repo("wi create --at")?;
    let (file, line) = match at.rsplit_once(':') {
        Some((file, line)) if line.parse::<u64>().is_ok() => (file, line.parse::<u64>().ok()),
        _ => (at, None),
    };
    let repo_url = format!("{}/{}/_git/{}", scope.org_url, enc(&scope.project), enc(repo));
    let mut url = Url::parse(&repo_url).map_err(|_| Error::user("Could not build a link to that file."))?;
    let commit = app.git.run(&["rev-parse", "HEAD"])?;
    url.query_pairs_mut()
        .append_pair("path", &format!("/{}", file.trim_start_matches('/')))
        .append_pair("version", &format!("GC{commit}"));
    if let Some(line) = line {
        let (start, end) = (line.to_string(), (line + 1).to_string());
        let on_line =
            [("line", start.as_str()), ("lineEnd", end.as_str()), ("lineStartColumn", "1"), ("lineEndColumn", "1")];
        url.query_pairs_mut().extend_pairs(on_line);
    }
    Ok(url.into())
}

pub fn create_work_item(app: &App, kind: &str, args: &CreateArgs) -> Result<Created> {
    let title = app.text(args.title.as_deref(), "title")?;
    let mut description = args.body.as_deref().map(|body| app.text(Some(body), "body")).transpose()?;
    if let Some(at) = &args.at {
        let found = format!("Found in: {}", permalink(app, at)?);
        description = Some(description.map_or(found.clone(), |body| format!("{body}\n\n{found}")));
    }
    let parent_id = match &args.parent {
        Some(parent) => {
            Some(parse_id(parent).ok_or_else(|| Error::user(format!("--parent \"{parent}\" isn't a work item id.")))?)
        }
        None => None,
    };
    let scope = app.scope()?;
    let ado = app.ado(&scope.org_url);
    let place = resolve_place(app, &ado, &scope.project, &args.place)?;
    let assigned_to = match &args.assignee {
        Some(user) if is_me(user) => ado.me()?,
        other => other.clone(),
    };
    let item = ado.create_work_item(&NewWorkItem {
        project: scope.project.clone(),
        kind: kind.to_string(),
        title,
        area_path: Some(place.area),
        iteration_path: Some(place.iteration),
        description,
        assigned_to,
        parent_id,
    })?;
    let linked = if args.link { Some(link(app, &[item.id.to_string()])?.branch) } else { None };
    Ok(Created { item, team: place.team, warnings: place.warnings, linked })
}

fn create(app: &App, kind: &str, args: &CreateArgs) -> Result<Output> {
    let made = create_work_item(app, kind, args)?;
    let s = app.style;
    let text = |value: &Option<String>| value.clone().unwrap_or_else(|| "?".into());
    let (item, id) = (&made.item, s.bold(&format!("#{}", made.item.id)));
    let mut out = vec![
        format!("{} {} {id} {}", s.green("Created"), text(&item.kind), text(&item.title)),
        s.dim(&format!("  {}", item.url)),
        format!("  {} · {}", text(&item.area_path), text(&item.iteration_path)),
    ];
    out.extend(made.linked.as_ref().map(|branch| format!("  Linked to {branch}")));
    out.extend(made.warnings.iter().map(|warning| s.yellow(&format!("  Warning: {warning}"))));
    Ok(Output::new(&made, out.join("\n")).web(args.web, &item.url))
}

#[derive(Args)]
pub struct Create {
    /// Work item type
    #[arg(long = "type", value_name = "TYPE", default_value = "Task")]
    pub kind: String,
    #[command(flatten)]
    pub args: CreateArgs,
}

#[derive(Args)]
pub struct Bug {
    #[command(flatten)]
    pub args: CreateArgs,
}

impl Bug {
    pub fn run(&self, app: &App) -> Result<Output> {
        create(app, "Bug", &self.args)
    }
}

#[derive(Subcommand)]
pub enum Wi {
    /// A work item with its parent and children
    View(View),
    /// Work items in this project by title, state, type, assignee or tag
    Search(Search),
    /// File a work item
    Create(Create),
}

impl Wi {
    pub fn run(&self, app: &App) -> Result<Output> {
        match self {
            Wi::View(c) => c.run(app),
            Wi::Search(c) => c.run(app),
            Wi::Create(c) => create(app, &c.kind, &c.args),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use crate::testing::{batch, cli, ok, rest_pr, wi, Bed, GitOpts, Recorded, Route};

    /// A project whose teams have an area and a sprint each; creating answers with item 51.
    fn project_with(teams: &'static [&'static str]) -> Route {
        Box::new(move |r: &Recorded| {
            let team = r.path.split('/').nth(2).unwrap_or("");
            if r.path.ends_with("/teams") {
                ok(json!({ "value": teams.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>() }))
            } else if r.path.ends_with("/teamfieldvalues") {
                ok(json!({ "defaultValue": format!("P\\{team}"), "values": [] }))
            } else if r.path.ends_with("/iterations") {
                ok(json!({ "value": [{ "path": format!("P\\{team}\\Sprint 2") }] }))
            } else {
                ok(wi(51, json!({})))
            }
        })
    }

    /// The field values a new work item was created with, in the order sent.
    fn created_with(bed: &Bed) -> Vec<Value> {
        let requests = bed.ado.requests();
        let create = requests.iter().find(|r| r.path.contains("/workitems/$")).expect("a work item was created");
        create.body.as_array().unwrap().iter().map(|patch| patch["value"].clone()).collect()
    }

    #[test]
    fn files_into_the_only_teams_area_and_current_sprint() {
        let bed = Bed::new(project_with(&["Web"]));
        assert_eq!(cli(bed.app(), &["bug", "Broken", "--jq", ".id"]).stdout, "51\n");
        assert_eq!(created_with(&bed), [json!("Broken"), json!("P\\Web"), json!("P\\Web\\Sprint 2")]);
        assert!(bed.ado.requests().iter().any(|r| r.path == "/MyProject/_apis/wit/workitems/$Bug"));
        assert_eq!(bed.git.config("dova.team"), None, "there was nothing to choose, so nothing to remember");
    }

    #[test]
    fn asks_which_team_once_and_remembers_it() {
        let bed = Bed::new(project_with(&["Web", "Api"])).choosing("Api");
        assert_eq!(cli(bed.app(), &["wi", "create", "Task one"]).code, 0);
        assert_eq!(created_with(&bed)[1..], [json!("P\\Api"), json!("P\\Api\\Sprint 2")]);
        assert_eq!(bed.git.config("dova.team").as_deref(), Some("Api"));

        // Next time nobody is asked, and the sprint is looked up afresh.
        let bed = Bed::new(project_with(&["Web", "Api"])).git(GitOpts::default().config("dova.team", "Api"));
        assert_eq!(cli(bed.app(), &["wi", "create", "Task two"]).code, 0);
        assert!(!bed.ado.requests().iter().any(|r| r.path.ends_with("/teams")));
        assert_eq!(created_with(&bed)[2], json!("P\\Api\\Sprint 2"));
    }

    #[test]
    fn without_a_terminal_names_the_flag_that_picks_a_team() {
        let res = cli(Bed::new(project_with(&["Web", "Api"])).app(), &["bug", "x"]);
        assert_eq!(res.code, 1);
        assert!(res.stderr.contains("--team") && res.stderr.contains("Available: Web, Api"), "{}", res.stderr);
    }

    #[test]
    fn flags_override_the_team_piece_by_piece_or_altogether() {
        let bed = Bed::new(project_with(&["Web", "Api"]));
        assert_eq!(cli(bed.app(), &["bug", "x", "--team", "Web", "--iteration", "P\\Backlog"]).code, 0);
        assert_eq!(created_with(&bed)[1..], [json!("P\\Web"), json!("P\\Backlog")]);
        assert_eq!(bed.git.config("dova.team"), None, "a one-off --team is not remembered");

        let bed = Bed::new(project_with(&["Web", "Api"]));
        assert_eq!(cli(bed.app(), &["bug", "x", "--area", "A", "--iteration", "I"]).code, 0);
        assert_eq!(bed.ado.requests().len(), 1, "nothing to look up");

        let like = |r: &Recorded| {
            let example = wi(7, json!({ "System.AreaPath": "P\\Elsewhere", "System.IterationPath": "P\\S9" }));
            if r.path.ends_with("workitemsbatch") {
                batch(vec![example])(r)
            } else {
                ok(wi(52, json!({})))
            }
        };
        let bed = Bed::new(Box::new(like));
        assert_eq!(cli(bed.app(), &["bug", "x", "--like", "7"]).code, 0);
        assert_eq!(created_with(&bed)[1..], [json!("P\\Elsewhere"), json!("P\\S9")]);
        assert_eq!(cli(bed.app(), &["bug", "x", "--like", "7", "--team", "Web"]).code, 1);
    }

    #[test]
    fn at_adds_a_permalink_to_the_line_at_head_and_link_links_it() {
        let git = GitOpts::default().answer("rev-parse HEAD", "abc123");
        let bed = Bed::new(Box::new(|r: &Recorded| {
            if r.path.contains("/$Bug") {
                ok(wi(60, json!({})))
            } else {
                batch(vec![wi(60, json!({}))])(r)
            }
        }))
        .git(git);
        let args = [
            "bug",
            "Null check",
            "--body",
            "Details",
            "--at",
            "src/auth.ts:88",
            "--link",
            "--area",
            "A",
            "--iteration",
            "I",
            "--json",
        ];
        assert_eq!(cli(bed.app(), &args).json()["linked"], "feature/x");
        let link = "https://dev.azure.com/contoso/MyProject/_git/web?path=%2Fsrc%2Fauth.ts&version=GCabc123&line=88&lineEnd=89&lineStartColumn=1&lineEndColumn=1";
        assert_eq!(created_with(&bed)[3], json!(format!("Details\n\nFound in: {link}")));
        assert_eq!(bed.git.config("branch.feature/x.dova-workitems").as_deref(), Some("60"));
    }

    #[test]
    fn search_builds_a_query_from_its_flags() {
        let bed = Bed::new(Box::new(|r: &Recorded| {
            if r.path.ends_with("/wiql") {
                ok(json!({ "workItems": [{ "id": 7 }] }))
            } else {
                batch(vec![wi(7, json!({}))])(r)
            }
        }));
        let found = cli(bed.app(), &["wi", "search", "it's", "--assignee", "@me", "--type", "Bug", "--json"]).json();
        assert_eq!(found, json!({ "items": [{ "id": 7, "title": "Item 7", "type": "Task", "state": "Active" }] }));
        let wiql = bed.ado.requests()[0].body["query"].as_str().unwrap().to_string();
        assert_eq!(
            wiql,
            "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'MyProject' AND [System.Title] CONTAINS 'it''s' \
             AND [System.WorkItemType] = 'Bug' AND [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC"
        );
    }

    fn only_pr_7() -> Route {
        Box::new(|r: &Recorded| {
            if r.path.ends_with("workitemsbatch") {
                ok(json!({ "value": [null] }))
            } else if r.path.ends_with("/pullrequests/7") {
                ok(rest_pr(7, json!({})))
            } else if r.path.ends_with("/threads") || r.path.ends_with("/workitems") {
                ok(json!({ "value": [] }))
            } else {
                None
            }
        })
    }

    #[test]
    fn view_falls_back_from_a_work_item_to_a_pr_for_a_bare_id() {
        let bed = Bed::new(only_pr_7());
        assert_eq!(cli(bed.app(), &["view", "7", "--jq", "[.kind, .id]"]).json(), json!(["pull-request", 7]));
        let neither = cli(bed.app(), &["view", "8"]);
        assert_eq!(neither.code, 2);
        assert!(neither.stderr.contains("8 is neither a work item nor a pull request."), "{}", neither.stderr);
    }

    #[test]
    fn view_shows_a_work_item_with_its_parent_and_children() {
        let bed = Bed::new(Box::new(|r: &Recorded| {
            if r.path.ends_with("/wiql") {
                return ok(json!({ "workItems": [{ "id": 6 }] }));
            }
            let item = wi(5, json!({ "System.Parent": 2, "System.Description": "<div>Why</div>" }));
            batch(vec![item, wi(2, json!({ "System.WorkItemType": "Feature" })), wi(6, json!({}))])(r)
        }));
        let link = "https://dev.azure.com/contoso/MyProject/_workitems/edit/5";
        let res = cli(bed.app(), &["wi", "view", link, "--json"]).json();
        assert_eq!((&res["id"], &res["parent"]["id"], &res["children"][0]["id"]), (&json!(5), &json!(2), &json!(6)));
        let text = cli(bed.app(), &["view", "5"]).stdout;
        assert!(text.contains("Parent:    #2 Item 2 [Feature]"), "{text}");
        assert!(text.contains("Description\nWhy") && text.contains("Children (1)"), "{text}");
    }
}
