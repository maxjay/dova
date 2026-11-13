//! Fakes for tests: Azure DevOps answering from a route, a git repo in
//! memory, a scripted person — and `cli`, which runs dova end to end on them.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use url::Url;

use crate::ado::{AuthStatus, Request, Response, Transport};
use crate::app::{cannot_ask, no_stdin, App, Env, ScopeHint};
use crate::cli::{self, Finished};
use crate::error::{Error, Result};
use crate::git::{Git, GitOutput};
use crate::rpc::Invoker;
use crate::text::Style;

/* ---------------- Azure DevOps ---------------- */

/// A request as a route sees it: the method, the decoded path without the org, the query, and the parsed body.
#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub body: Value,
    pub raw: Request,
}

impl Recorded {
    pub fn query(&self, key: &str) -> Option<String> {
        Url::parse(&self.raw.url).ok()?.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
    }
}

/// What Azure DevOps answers; None means 404.
pub type Route = Box<dyn Fn(&Recorded) -> Option<Response> + Send + Sync>;

pub struct FakeAdo {
    route: Route,
    requests: Mutex<Vec<Recorded>>,
}

impl FakeAdo {
    /// Every request made so far, in order.
    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
}

pub fn fake_ado(route: Route) -> FakeAdo {
    FakeAdo { route, requests: Mutex::default() }
}

impl Transport for FakeAdo {
    fn kind(&self) -> &'static str {
        "in-process"
    }

    fn send(&self, req: &Request) -> Result<Response> {
        let url = Url::parse(&req.url).map_err(|_| Error::user("not a URL"))?;
        let path = percent_encoding::percent_decode_str(url.path()).decode_utf8_lossy().into_owned();
        let recorded = Recorded {
            method: req.method.as_str().to_string(),
            path: path.splitn(3, '/').nth(2).map_or(String::new(), |rest| format!("/{rest}")),
            body: req.body.as_deref().and_then(|body| serde_json::from_str(body).ok()).unwrap_or(Value::Null),
            raw: req.clone(),
        };
        self.requests.lock().unwrap().push(recorded.clone());
        let unrouted =
            || json_response(404, json!({ "message": format!("no route for {} {}", recorded.method, recorded.path) }));
        Ok((self.route)(&recorded).unwrap_or_else(unrouted))
    }

    fn auth_status(&self) -> Result<AuthStatus> {
        Ok(AuthStatus {
            signed_in: true,
            account: Some("jane@contoso.com".into()),
            tenant: Some("t".into()),
            expires_at: None,
            error: None,
        })
    }
}

pub fn json_response(status: u16, body: Value) -> Response {
    Response { status, content_type: Some("application/json".into()), body: body.to_string() }
}

pub fn ok(body: Value) -> Option<Response> {
    Some(json_response(200, body))
}

/// A work item as the REST API returns it; `fields` are added to the usual ones.
pub fn wi(id: u64, fields: Value) -> Value {
    let mut item = json!({ "id": id, "fields": { "System.Title": format!("Item {id}"), "System.WorkItemType": "Task", "System.State": "Active", "System.TeamProject": "MyProject" } });
    if let (Some(all), Value::Object(extra)) = (item["fields"].as_object_mut(), fields) {
        all.extend(extra);
    }
    item
}

/// Answers the work items batch endpoint from a list: null for the ids it doesn't have.
pub fn batch(items: Vec<Value>) -> Route {
    Box::new(move |req| {
        let found = |id: &Value| items.iter().find(|item| item["id"] == *id).cloned().unwrap_or(Value::Null);
        ok(json!({ "value": req.body["ids"].as_array()?.iter().map(found).collect::<Vec<_>>() }))
    })
}

/// A pull request as the REST API returns it.
pub fn rest_pr(id: u64, extra: Value) -> Value {
    let mut pr = json!({
        "pullRequestId": id,
        "title": format!("PR {id}"),
        "status": "active",
        "createdBy": { "displayName": "Jane" },
        "sourceRefName": "refs/heads/feature/x",
        "targetRefName": "refs/heads/main",
        "repository": { "id": "r", "name": "web", "project": { "id": "p", "name": "MyProject" } },
    });
    if let (Some(all), Value::Object(extra)) = (pr.as_object_mut(), extra) {
        all.extend(extra);
    }
    pr
}

/* ---------------- git ---------------- */

/// A repo in memory: a branch, an origin remote, git config, and canned answers for anything else.
#[derive(Clone)]
pub struct GitOpts {
    pub in_repo: bool,
    /// None for a detached HEAD.
    pub branch: Option<String>,
    pub remote: Option<String>,
    config: HashMap<String, String>,
    /// Keyed by the args joined with spaces.
    answers: HashMap<String, String>,
}

impl Default for GitOpts {
    fn default() -> Self {
        GitOpts {
            in_repo: true,
            branch: Some("feature/x".into()),
            remote: Some("https://dev.azure.com/contoso/MyProject/_git/web".into()),
            config: HashMap::new(),
            answers: HashMap::new(),
        }
    }
}

impl GitOpts {
    /// On `feature/x`, linked to #11 and #12.
    pub fn linked() -> GitOpts {
        GitOpts::default().config("branch.feature/x.dova-workitems", "11,12")
    }

    /// On this branch instead of `feature/x`.
    pub fn branch(mut self, name: &str) -> GitOpts {
        self.branch = Some(name.to_string());
        self
    }

    pub fn config(mut self, key: &str, value: &str) -> GitOpts {
        self.config.insert(key.to_string(), value.to_string());
        self
    }

    pub fn answer(mut self, args: &str, stdout: &str) -> GitOpts {
        self.answers.insert(args.to_string(), stdout.to_string());
        self
    }
}

pub struct FakeGit {
    opts: GitOpts,
    config: Mutex<Vec<(String, String)>>,
}

impl FakeGit {
    pub fn config(&self, key: &str) -> Option<String> {
        self.config.lock().unwrap().iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    }

    fn run(&self, args: &[&str]) -> GitOutput {
        let said = |stdout: &str| GitOutput { stdout: stdout.to_string(), stderr: String::new(), ok: true };
        let no = || GitOutput { stdout: String::new(), stderr: "nope".to_string(), ok: false };
        let mut config = self.config.lock().unwrap();
        if let Some(answer) = self.opts.answers.get(&args.join(" ")) {
            return said(answer);
        }
        match args {
            ["rev-parse", "--is-inside-work-tree"] if self.opts.in_repo => said("true"),
            ["rev-parse", "--abbrev-ref", "HEAD"] => said(self.opts.branch.as_deref().unwrap_or("HEAD")),
            ["remote", "get-url", "origin"] => self.opts.remote.as_deref().map_or_else(no, said),
            ["config", "--get", key] => config.iter().find(|(k, _)| k == key).map_or_else(no, |(_, v)| said(v)),
            ["config", "--unset", key] => {
                let before = config.len();
                config.retain(|(k, _)| k != key);
                if config.len() < before {
                    said("")
                } else {
                    no()
                }
            }
            ["config", "--get-regexp", _] => {
                // The one pattern dova asks for.
                let ours: Vec<String> = config
                    .iter()
                    .filter(|(k, _)| k.starts_with("branch.") && k.ends_with(".dova-workitems"))
                    .map(|(k, v)| format!("{k} {v}"))
                    .collect();
                if ours.is_empty() {
                    no()
                } else {
                    said(&ours.join("\n"))
                }
            }
            ["config", key, value] => {
                config.retain(|(k, _)| k != key);
                config.push((key.to_string(), value.to_string()));
                said("")
            }
            _ => no(),
        }
    }
}

/* ---------------- the whole thing ---------------- */

/// A test's world. `app()` can be called as often as needed; every App shares the same fakes.
pub struct Bed {
    pub ado: Arc<FakeAdo>,
    pub git: Arc<FakeGit>,
    /// What the person picks when asked to choose. None: there is no terminal to ask in.
    choice: Option<String>,
    /// What is piped in on stdin. None: nothing is.
    stdin: Option<String>,
}

impl Bed {
    pub fn new(route: Route) -> Bed {
        Bed { ado: Arc::new(fake_ado(route)), git: Arc::new(fake_git(GitOpts::default())), choice: None, stdin: None }
    }

    pub fn git(mut self, opts: GitOpts) -> Bed {
        self.git = Arc::new(fake_git(opts));
        self
    }

    /// Someone is at the terminal, and picks this whenever asked to choose.
    pub fn choosing(mut self, answer: &str) -> Bed {
        self.choice = Some(answer.to_string());
        self
    }

    /// Text piped in on stdin.
    pub fn stdin(mut self, text: &str) -> Bed {
        self.stdin = Some(text.to_string());
        self
    }

    pub fn app(&self) -> App {
        let (choice, stdin, git) = (self.choice.clone(), self.stdin.clone(), self.git.clone());
        App {
            env: Env::default(),
            git: Git::new(Box::new(move |args, _| Ok(git.run(args))), PathBuf::from("/repo")),
            transport: self.ado.clone(),
            flags: ScopeHint::default(),
            style: Style::PLAIN,
            choose: Box::new(move |question, options, answered_by| {
                choice.clone().ok_or_else(|| cannot_ask(question, options, answered_by))
            }),
            read_stdin: Box::new(move |what| stdin.clone().ok_or_else(|| Error::user(format!("No {what} given.")))),
            open_url: |_| Ok(()),
        }
    }

    /// `dova rpc`'s way in, on this bed: nobody to ask, and params are the only stdin.
    pub fn invoker(&self) -> Invoker {
        let bed = Bed { ado: self.ado.clone(), git: self.git.clone(), choice: None, stdin: None };
        Invoker::with(Box::new(move |_: &Map<String, Value>| App { read_stdin: Box::new(no_stdin), ..bed.app() }))
    }
}

fn fake_git(opts: GitOpts) -> FakeGit {
    FakeGit { config: Mutex::new(opts.config.clone().into_iter().collect()), opts }
}

impl Finished {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.stdout)
            .unwrap_or_else(|_| panic!("not JSON on stdout: {:?} (stderr: {:?})", self.stdout, self.stderr))
    }
}

/// Runs dova end to end against a test app; returns the exit code and what it printed.
pub fn cli(app: App, args: &[&str]) -> Finished {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    cli::run(&args, &Env([("NO_COLOR".to_string(), "1".to_string())].into()), |_| app)
}
