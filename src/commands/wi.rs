//! Work items: reading them, finding them, filing them, changing them.

use clap::{Args, Subcommand};
use serde::Serialize;
use serde_json::{json, Value};
use url::Url;

use super::link::link;
use super::pr::{find_pull_request, pull_request_detail, render_pull_request};
use super::work_item_table;
use crate::ado::client::{AdoClient, NewWorkItem};
use crate::ado::map::{body_field, to_work_item, to_work_item_comment};
use crate::ado::types::{Comment, WorkItem, WorkItemRef};
use crate::app::App;
use crate::cli::Output;
use crate::error::{Error, Kind, Result};
use crate::par;
use crate::text::{to_html, truncate, Style};
use crate::urls::{enc, looks_like_url, parse_id, parse_work_item_link};

/* ---------------- view ---------------- */

#[derive(Debug, Serialize)]
pub struct Detail {
    #[serde(flatten)]
    pub item: WorkItem,
    pub parent: Option<WorkItemRef>,
    pub children: Vec<WorkItemRef>,
    /// Its discussion, oldest first.
    pub comments: Vec<Comment>,
}

/// A work item's id, from an id or a link, and the client for its organization.
fn locate<'a>(app: &'a App, id_or_url: &str) -> Result<(u64, AdoClient<'a>)> {
    let link = parse_work_item_link(id_or_url);
    let id = link.as_ref().map(|l| l.id).or_else(|| parse_id(id_or_url));
    let id = id.ok_or_else(|| Error::user(format!("\"{id_or_url}\" isn't a work item id or link.")))?;
    // A link names its own organization; a bare id is in the one you're in.
    Ok((id, app.ado(&app.org_url(link.as_ref().map(|l| l.org.as_str()))?)))
}

pub fn work_item_detail(app: &App, id_or_url: &str) -> Result<Detail> {
    let (id, ado) = locate(app, id_or_url)?;
    let read = ado.read_ticket(id, &crate::ado::sections::Resource::Wi.sections(), &mut None)?;
    let item = to_work_item(&read.item, &ado.org_url);
    let parent = item.parent_id.and_then(|id| read.linked.get(&id)).cloned();
    let children = read
        .relations
        .iter()
        .filter(|link| link["rel"] == "System.LinkTypes.Hierarchy-Forward")
        .filter_map(|link| read.linked.get(&link["workItemId"].as_u64()?))
        .cloned()
        .collect();
    let comments = read.comments.iter().map(to_work_item_comment).collect();
    Ok(Detail { item, parent, children, comments })
}

/// 5 for 5.0, 2.5 for 2.5.
fn points(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

/// How many comments a work item shows before `--full`.
const LATEST: usize = 5;

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
    out.extend(d.item.points.map(|value| format!("Points:    {}", points(value))));
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
    if !d.comments.is_empty() {
        let earlier = if full { 0 } else { d.comments.len().saturating_sub(LATEST) };
        out.extend([String::new(), s.bold(&format!("Comments ({})", d.comments.len()))]);
        if earlier > 0 {
            out.push(s.dim(&format!("  … {earlier} earlier — --full for all")));
        }
        for comment in &d.comments[earlier..] {
            let by = [comment.author.as_deref().or(Some("unknown")), comment.published_at.as_deref()];
            let (shown, cut) = if full { (comment.text.clone(), false) } else { truncate(&comment.text, 600) };
            out.push(String::new());
            out.push(s.bold(&by.into_iter().flatten().collect::<Vec<_>>().join(" · ")));
            out.extend(shown.lines().map(|line| format!("  {line}")));
            if cut {
                out.push(s.dim("  … truncated — --full for the rest"));
            }
        }
    }
    out.join("\n")
}

#[derive(Args)]
pub struct View {
    /// Work item id or link
    pub id_or_url: String,
    /// Show the description and every comment in full
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
        let items = app.ado(&scope.org_url).query(&wiql)?;

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
        None => project_team(app, ado, project, true)?,
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

/// The team work items in a project go to: for the repo's own project
/// (`ours`), the one remembered in git config (`dova.team`); otherwise the
/// project's only team, or the one you pick — which, for the repo's own
/// project, is then remembered.
fn project_team(app: &App, ado: &AdoClient, project: &str, ours: bool) -> Result<String> {
    if let Some(team) = app.git.config_get("dova.team")?.filter(|_| ours) {
        return Ok(team);
    }
    let mut teams = ado.teams(project)?;
    match teams.len() {
        0 => Err(Error::not_found(format!("Project \"{project}\" has no teams."))),
        1 => Ok(teams.remove(0)),
        _ => {
            let team = (app.choose)(&format!("Which team in \"{project}\"?"), &teams, "Pass --team <name>.")?;
            if ours {
                app.git.config_set("dova.team", &team)?;
            }
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
    // The field is HTML: the body goes in as typed, and the permalink as a link.
    let mut description =
        args.body.as_deref().map(|body| app.text(Some(body), "body")).transpose()?.map(|body| to_html(&body));
    if let Some(at) = &args.at {
        let url = to_html(&permalink(app, at)?);
        let found = format!("Found in: <a href=\"{url}\">{url}</a>");
        description = Some(description.map_or(found.clone(), |body| format!("{body}<br><br>{found}")));
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

/* ---------------- edit and comment ---------------- */

#[derive(Args, Default)]
pub struct Edit {
    /// Work item id or link
    pub id_or_url: String,
    /// New title
    #[arg(long)]
    pub title: Option<String>,
    /// New description ('-' reads stdin)
    #[arg(long, value_name = "TEXT")]
    pub body: Option<String>,
    /// Turn it into this type (Bug, Feature, User Story, …)
    #[arg(long = "type", value_name = "TYPE")]
    pub kind: Option<String>,
    /// Story points (effort or size, where the type calls it that)
    #[arg(long, value_name = "N")]
    pub points: Option<f64>,
    /// Assign it ("me" for yourself, "none" for nobody)
    #[arg(long, value_name = "USER")]
    pub assignee: Option<String>,
    /// Move it to this iteration; with no path, to the team's current sprint
    #[arg(long, value_name = "PATH", num_args = 0..=1, default_missing_value = "current")]
    pub iteration: Option<String>,
    /// Move it to this area
    #[arg(long, value_name = "PATH")]
    pub area: Option<String>,
    /// Move it to this state (New, Active, Closed, … as the type names them)
    #[arg(long)]
    pub state: Option<String>,
    /// The team whose current sprint that is (default: remembered for this repo)
    #[arg(long)]
    pub team: Option<String>,
    /// Also say this in its discussion ('-' reads stdin)
    #[arg(long, value_name = "TEXT")]
    pub comment: Option<String>,
}

impl Edit {
    pub fn run(&self, app: &App) -> Result<Output> {
        let fields_given =
            [&self.title, &self.body, &self.kind, &self.assignee, &self.iteration, &self.area, &self.state];
        if fields_given.iter().all(|given| given.is_none()) && self.points.is_none() && self.comment.is_none() {
            return Err(Error::user("Nothing to change.").hint(
                "Pass any of --title, --body, --type, --points, --assignee, --iteration, --area, --state, --comment.",
            ));
        }
        if self.body.as_deref() == Some("-") && self.comment.as_deref() == Some("-") {
            return Err(Error::user("Only one of --body and --comment can read stdin."));
        }
        let (id, ado) = locate(app, &self.id_or_url)?;
        let item = ado.work_item(id)?;
        let project = item.project.clone().unwrap_or_default();
        // What it is once this is done: that decides which fields the rest goes to.
        let was = item.kind.clone().unwrap_or_default();
        let kind = self.kind.clone().unwrap_or_else(|| was.clone());
        let ((body, shown_as), (old_body, _)) = (body_field(&kind), body_field(&was));

        let mut fields: Vec<(&str, Value)> = Vec::new();
        fields.extend(self.kind.as_ref().map(|kind| ("System.WorkItemType", json!(kind))));
        fields.extend(self.title.as_ref().map(|title| ("System.Title", json!(title))));
        match &self.body {
            Some(text) => fields.push((body, json!(to_html(&app.text(Some(text), "body")?)))),
            // Its text would otherwise stay behind in a field the new type's form doesn't show.
            None if body != old_body && !item.body.iter().any(|section| section.label == shown_as) => {
                fields.extend(ado.work_item_field(id, old_body)?.map(|html| (body, json!(html))));
            }
            None => {}
        }
        if let Some(value) = self.points {
            let field = ado.points_field(&project, &kind)?;
            fields.push((field.ok_or_else(|| Error::user(format!("A {kind} has no story points.")))?, json!(value)));
        }
        match self.assignee.as_deref() {
            Some(user) if is_me(user) => fields.extend(ado.me()?.map(|me| ("System.AssignedTo", json!(me)))),
            Some(user) if user.eq_ignore_ascii_case("none") => fields.push(("System.AssignedTo", json!(""))),
            Some(user) => fields.push(("System.AssignedTo", json!(user))),
            None => {}
        }
        fields.extend(self.area.as_ref().map(|area| ("System.AreaPath", json!(area))));
        if let Some(wanted) = &self.state {
            // Each type has its own states, so a wrong one is answered with the right ones.
            let states = ado.work_item_states(&project, &kind)?;
            let state = states.iter().find(|state| state.eq_ignore_ascii_case(wanted)).ok_or_else(|| {
                Error::user(format!("A {kind} has no state \"{wanted}\"."))
                    .hint(format!("Use one of: {}", states.join(", ")))
            })?;
            fields.push(("System.State", json!(state)));
        }
        match self.iteration.as_deref() {
            Some("current") => {
                let ours = app.scope().is_ok_and(|scope| scope.project.eq_ignore_ascii_case(&project));
                let team = match &self.team {
                    Some(team) => team.clone(),
                    None => project_team(app, &ado, &project, ours)?,
                };
                let sprint = ado.current_iteration(&project, &team)?.ok_or_else(|| {
                    Error::not_found(format!("Team \"{team}\" has no current sprint.")).hint("Pass --iteration <path>.")
                })?;
                fields.push(("System.IterationPath", json!(sprint)));
            }
            Some(path) => fields.push(("System.IterationPath", json!(path))),
            None => {}
        }
        let comment = self.comment.as_deref().map(|text| app.text(Some(text), "comment")).transpose()?;

        let item = if fields.is_empty() { item } else { ado.update_work_item(id, &fields)? };
        if let Some(comment) = &comment {
            ado.add_work_item_comment(&project, id, &to_html(comment))?;
        }
        let s = app.style;
        let text = |value: &Option<String>| value.clone().unwrap_or_else(|| "?".into());
        let who = item.assigned_to.as_ref().map_or("unassigned".to_string(), |who| format!("assigned to {who}"));
        let estimate = item.points.map_or(String::new(), |value| format!(" · {} points", points(value)));
        let mut out = vec![
            format!(
                "{} {} {} {}",
                s.green(if fields.is_empty() { "Commented on" } else { "Updated" }),
                text(&item.kind),
                s.bold(&format!("#{id}")),
                text(&item.title)
            ),
            s.dim(&format!("  {}", item.url)),
            format!(
                "  {} · {} · {} · {who}{estimate}",
                text(&item.state),
                text(&item.area_path),
                text(&item.iteration_path)
            ),
        ];
        out.extend(comment.filter(|_| !fields.is_empty()).map(|_| "  Commented.".to_string()));
        Ok(Output::new(&item, out.join("\n")))
    }
}

#[derive(Args)]
pub struct CommentOn {
    /// Work item id or link
    pub id_or_url: String,
    /// What to say ('-' or nothing reads stdin)
    pub text: Option<String>,
}

#[derive(Subcommand)]
pub enum Wi {
    /// A work item with its parent, children and discussion
    View(View),
    /// Work items in this project by title, state, type, assignee or tag
    Search(Search),
    /// File a work item
    Create(Create),
    /// Change a work item: its text, type, points, iteration, area or assignee
    Edit(Edit),
    /// Add to a work item's discussion
    Comment(CommentOn),
}

impl Wi {
    pub fn run(&self, app: &App) -> Result<Output> {
        match self {
            Wi::View(c) => c.run(app),
            Wi::Search(c) => c.run(app),
            Wi::Create(c) => create(app, &c.kind, &c.args),
            Wi::Edit(c) => c.run(app),
            Wi::Comment(c) => {
                let text = app.text(c.text.as_deref(), "comment")?;
                Edit { id_or_url: c.id_or_url.clone(), comment: Some(text), ..Default::default() }.run(app)
            }
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
            "Use Vec<u8>\nnot String",
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
        // The field is HTML: the body shows as typed, and the permalink is a link that reads back as its address.
        let link = "https://dev.azure.com/contoso/MyProject/_git/web?path=%2Fsrc%2Fauth.ts&amp;version=GCabc123&amp;line=88&amp;lineEnd=89&amp;lineStartColumn=1&amp;lineEndColumn=1";
        let html = format!("Use Vec&lt;u8&gt;<br>not String<br><br>Found in: <a href=\"{link}\">{link}</a>");
        assert_eq!(created_with(&bed)[3], json!(html));
        assert_eq!(
            crate::text::strip_html(&html),
            format!("Use Vec<u8>\nnot String\n\nFound in: {}", link.replace("&amp;", "&"))
        );
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
            } else if r.path.contains("/HierarchyQuery/") {
                crate::testing::review_page(1, "head", json!([]), json!([]))
            } else if r.path.ends_with("/workitems") {
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
    fn view_shows_a_work_item_with_its_parent_children_points_and_discussion() {
        let bed = Bed::new(Box::new(|r: &Recorded| {
            if r.path.ends_with("/workItems/5/comments") {
                let said = |id: u64, text: &str| json!({ "id": id, "text": text, "createdBy": { "displayName": "Ann" }, "createdDate": "2026-11-17T13:59:44.59Z" });
                let all: Vec<Value> = (1..=7).map(|n| said(n, &format!("<div>Comment {n}<br>more</div>"))).collect();
                return ok(json!({ "comments": all }));
            }
            // A Feature keeps the story points it had as a User Story; its own estimate is its effort.
            let estimates =
                json!({ "Microsoft.VSTS.Scheduling.StoryPoints": 5.0, "Microsoft.VSTS.Scheduling.Effort": 8.0 });
            let fields =
                json!({ "System.Parent": 2, "System.Description": "<div>Why</div>", "System.WorkItemType": "Feature" });
            let mut item = wi(5, fields);
            item["relations"] = json!([{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/contoso/_apis/wit/workitems/6"}]);
            item["fields"].as_object_mut().unwrap().extend(estimates.as_object().unwrap().clone());
            batch(vec![item, wi(2, json!({ "System.WorkItemType": "Feature" })), wi(6, json!({}))])(r)
        }));
        let link = "https://dev.azure.com/contoso/MyProject/_workitems/edit/5";
        let res = cli(bed.app(), &["wi", "view", link, "--json"]).json();
        assert_eq!((&res["id"], &res["parent"]["id"], &res["children"][0]["id"]), (&json!(5), &json!(2), &json!(6)));
        assert_eq!((&res["points"], res["comments"].as_array().unwrap().len()), (&json!(8.0), 7));
        assert_eq!(
            res["comments"][0],
            json!({ "id": 1, "author": "Ann", "publishedAt": "2026-11-17T13:59:44Z", "text": "Comment 1\nmore", "kind": "text" })
        );
        let text = cli(bed.app(), &["view", "5"]).stdout;
        assert!(text.contains("Parent:    #2 Item 2 [Feature]") && text.contains("Points:    8\n"), "{text}");
        assert!(text.contains("Description\nWhy") && text.contains("Children (1)"), "{text}");
        // The latest five, the rest behind --full.
        assert!(
            text.contains(
                "Comments (7)\n  … 2 earlier — --full for all\n\nAnn · 2026-11-17T13:59:44Z\n  Comment 3\n  more"
            ),
            "{text}"
        );
        assert!(cli(bed.app(), &["view", "5", "--full"]).stdout.contains("  Comment 1\n"));
    }

    /// Item 5, a User Story in MyProject with a description; every change answers with the item as asked for.
    fn editable() -> Route {
        Box::new(|r: &Recorded| match (r.method.as_str(), r.path.as_str()) {
            ("PATCH", _) => ok(wi(5, json!({}))),
            ("POST", p) if p.ends_with("/comments") => ok(json!({ "id": 9 })),
            ("GET", p) if p.ends_with("/connectionData") => {
                ok(json!({ "authenticatedUser": { "properties": { "Account": { "$value": "jane@contoso.com" } } } }))
            }
            ("GET", p) if p.ends_with("/workitemtypes/Feature/fields") => {
                ok(json!({ "value": [{ "referenceName": "Microsoft.VSTS.Scheduling.Effort" }] }))
            }
            ("GET", p) if p.ends_with("/fields") => ok(json!({ "value": [{ "referenceName": "System.Title" }] })),
            ("GET", p) if p.ends_with("/states") => {
                ok(json!({ "value": [{ "name": "New" }, { "name": "Active" }, { "name": "Closed" }] }))
            }
            ("GET", p) if p.ends_with("/workitems/5") => {
                ok(json!({ "fields": { "System.Description": "<div>Why</div>" } }))
            }
            ("GET", p) if p.ends_with("/teams") => ok(json!({ "value": [{ "name": "Web" }] })),
            ("GET", p) if p.ends_with("/teamsettings/iterations") => {
                ok(json!({ "value": [{ "path": "MyProject\\Sprint 9" }] }))
            }
            _ => {
                let fields = json!({ "System.WorkItemType": "User Story", "System.Description": "<div>Why</div>" });
                batch(vec![wi(5, fields)])(r)
            }
        })
    }

    fn patched(bed: &Bed) -> Value {
        bed.ado.requests().into_iter().rev().find(|r| r.method == "PATCH").expect("something was changed").body
    }

    fn set(field: &str, value: Value) -> Value {
        json!({ "op": "add", "path": format!("/fields/{field}"), "value": value })
    }

    #[test]
    fn edit_sets_just_what_it_is_given_in_the_fields_the_type_uses() {
        let bed = Bed::new(editable());
        let args = ["wi", "edit", "5", "--type", "Feature", "--points", "8", "--assignee", "me", "--iteration"];
        assert_eq!(cli(bed.app(), &args).code, 0);
        assert_eq!(
            patched(&bed),
            json!([
                set("System.WorkItemType", json!("Feature")),
                set("Microsoft.VSTS.Scheduling.Effort", json!(8.0)),
                set("System.AssignedTo", json!("jane@contoso.com")),
                set("System.IterationPath", json!("MyProject\\Sprint 9")),
            ])
        );
        let patch = bed.ado.requests().into_iter().find(|r| r.method == "PATCH").unwrap();
        assert_eq!(
            (patch.path.as_str(), patch.raw.content_type.as_deref()),
            ("/_apis/wit/workitems/5", Some("application/json-patch+json"))
        );

        let bed = Bed::new(editable());
        let args =
            ["wi", "edit", "5", "--body", "Use Vec<u8>\nhere", "--assignee", "none", "--iteration", "MyProject\\Later"];
        assert_eq!(cli(bed.app(), &args).code, 0);
        assert_eq!(
            patched(&bed),
            json!([
                set("System.Description", json!("Use Vec&lt;u8&gt;<br>here")),
                set("System.AssignedTo", json!("")),
                set("System.IterationPath", json!("MyProject\\Later")),
            ])
        );
    }

    #[test]
    fn edit_moves_it_to_a_state_the_type_has_and_names_them_otherwise() {
        let bed = Bed::new(editable());
        assert_eq!(cli(bed.app(), &["wi", "edit", "5", "--state", "active"]).code, 0);
        assert_eq!(patched(&bed), json!([set("System.State", json!("Active"))]));
        assert!(bed.ado.requests().iter().any(|r| r.path == "/MyProject/_apis/wit/workitemtypes/User Story/states"));

        let bed = Bed::new(editable());
        let wrong = cli(bed.app(), &["wi", "edit", "5", "--state", "Done"]);
        assert_eq!(wrong.code, 1);
        assert!(wrong.stderr.contains("A User Story has no state \"Done\"."), "{}", wrong.stderr);
        assert!(wrong.stderr.contains("Use one of: New, Active, Closed"), "{}", wrong.stderr);
        assert!(!bed.ado.requests().iter().any(|r| r.method == "PATCH"));
    }

    #[test]
    fn turning_a_story_into_a_bug_takes_its_description_along() {
        let bed = Bed::new(editable());
        assert_eq!(cli(bed.app(), &["wi", "edit", "5", "--type", "Bug"]).code, 0);
        let moved = set("Microsoft.VSTS.TCM.ReproSteps", json!("<div>Why</div>"));
        assert_eq!(patched(&bed), json!([set("System.WorkItemType", json!("Bug")), moved]));
    }

    #[test]
    fn edit_refuses_what_it_cannot_do_before_changing_anything() {
        let bed = Bed::new(editable());
        let no_points = cli(bed.app(), &["wi", "edit", "5", "--points", "3"]);
        assert_eq!((no_points.code, no_points.stderr.contains("A User Story has no story points.")), (1, true));
        assert_eq!(cli(bed.app(), &["wi", "edit", "5"]).code, 1);
        assert_eq!(cli(bed.app(), &["wi", "edit", "5", "--body", "-", "--comment", "-"]).code, 1);
        assert!(!bed.ado.requests().iter().any(|r| r.method != "GET" && !r.path.ends_with("/workitemsbatch")));
    }

    #[test]
    fn comment_adds_to_the_discussion_and_changes_nothing_else() {
        let bed = Bed::new(editable());
        let res = cli(bed.app(), &["wi", "comment", "5", "Sized: 3 <points>\nwith the team"]);
        assert!(res.stdout.starts_with("Commented on User Story #5"), "{}{}", res.stdout, res.stderr);
        let requests = bed.ado.requests();
        let post = requests.iter().find(|r| r.method == "POST" && r.path.ends_with("/comments")).unwrap();
        assert_eq!(post.path, "/MyProject/_apis/wit/workItems/5/comments");
        assert_eq!(post.body, json!({ "text": "Sized: 3 &lt;points&gt;<br>with the team" }));
        assert!(!requests.iter().any(|r| r.method == "PATCH"));

        let bed = Bed::new(editable());
        assert_eq!(cli(bed.app(), &["wi", "edit", "5", "--title", "New", "--comment", "Renamed"]).code, 0);
        assert_eq!(patched(&bed), json!([set("System.Title", json!("New"))]));
        assert!(bed.ado.requests().iter().any(|r| r.method == "POST" && r.body == json!({ "text": "Renamed" })));
    }
}
