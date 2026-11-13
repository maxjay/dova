//! Everything a command touches outside itself, built once per invocation:
//! git, Azure DevOps, the terminal, stdin. Tests build one from fakes.

use std::collections::HashMap;
use std::io::{IsTerminal, Read};
use std::path::PathBuf;
use std::sync::Arc;

use crate::ado::client::AdoClient;
use crate::ado::Transport;
use crate::error::{Error, Result};
use crate::git::{self, Git};
use crate::text::Style;
use crate::urls;

/// Environment variables, as a snapshot: the process's, or a test's.
#[derive(Debug, Clone, Default)]
pub struct Env(pub HashMap<String, String>);

impl Env {
    pub fn process() -> Env {
        Env(std::env::vars().collect())
    }

    /// The variable's value, unless it's unset or empty.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str).filter(|v| !v.is_empty())
    }

    /// Set to anything but `0`: how the on/off switches (`DOVA_NO_DAEMON`) are read.
    pub fn is_on(&self, key: &str) -> bool {
        self.get(key).is_some_and(|v| v != "0")
    }
}

/// Where a command is pointed: an organization and project, often a repo and branch.
#[derive(Debug, Clone, PartialEq)]
pub struct Scope {
    pub org: String,
    /// `https://dev.azure.com/{org}`
    pub org_url: String,
    pub project: String,
    pub repo: Option<String>,
    pub branch: Option<String>,
}

impl Scope {
    pub fn need_repo(&self, command: &str) -> Result<&str> {
        self.repo.as_deref().ok_or_else(|| {
            Error::user(format!("`dova {command}` needs a repo."))
                .hint("Run it inside a repo cloned from Azure Repos, or pass --repo.")
        })
    }

    pub fn need_branch(&self) -> Result<&str> {
        self.branch.as_deref().ok_or_else(|| Error::user("Not on a branch (detached HEAD?)."))
    }
}

/// Part of a scope that is already known: from flags, or from a link a command was given.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScopeHint {
    pub org: Option<String>,
    pub project: Option<String>,
    pub repo: Option<String>,
}

/// Asks the person to pick one of `options`. The last argument is what
/// would have answered it (a flag, usually): without a terminal a prompt
/// would hang forever, so then the question fails saying that instead.
pub type Choose = Box<dyn Fn(&str, &[String], &str) -> Result<String> + Send + Sync>;

/// All of stdin as text, for the thing named (`title`, `body`): used when a command is given `-`.
pub type ReadStdin = Box<dyn Fn(&str) -> Result<String> + Send + Sync>;

pub struct App {
    pub env: Env,
    pub git: Git,
    pub transport: Arc<dyn Transport>,
    /// `--org`, `--project`, `--repo`.
    pub flags: ScopeHint,
    pub style: Style,
    pub choose: Choose,
    pub read_stdin: ReadStdin,
    pub open_url: fn(&str) -> Result<()>,
}

pub struct Options {
    pub env: Env,
    pub interactive: bool,
    pub flags: ScopeHint,
    pub style: Style,
    pub cwd: Option<PathBuf>,
    pub transport: Arc<dyn Transport>,
    pub read_stdin: ReadStdin,
}

impl App {
    pub fn new(opts: Options) -> App {
        let cwd = opts.cwd.or_else(|| std::env::current_dir().ok()).unwrap_or_default();
        let interactive = opts.interactive;
        App {
            env: opts.env,
            git: Git::new(Box::new(git::exec), cwd),
            transport: opts.transport,
            flags: opts.flags,
            style: opts.style,
            choose: Box::new(move |question, options, answered_by| {
                if interactive {
                    choose_in_terminal(question, options)
                } else {
                    Err(cannot_ask(question, options, answered_by))
                }
            }),
            read_stdin: opts.read_stdin,
            open_url: |url| {
                open::that(url).map_err(|err| Error::external(format!("Could not open the browser: {err}")))
            },
        }
    }

    pub fn ado(&self, org_url: &str) -> AdoClient<'_> {
        AdoClient::new(self.transport.as_ref(), org_url)
    }

    pub fn scope(&self) -> Result<Scope> {
        self.scope_for(&ScopeHint::default())
    }

    /// What a command is about. Per field, first answer wins: a link the
    /// command was given (`hint`), then --org/--project/--repo, then
    /// $DOVA_ORG/$DOVA_PROJECT, then the `origin` remote of the repo you're
    /// in. The branch is whatever is checked out.
    pub fn scope_for(&self, hint: &ScopeHint) -> Result<Scope> {
        let in_repo = self.git.is_repo()?;
        let remote = if in_repo { self.git.remote_url()?.and_then(|url| urls::parse_remote(&url)) } else { None };
        let pick = |hint: &Option<String>, flag: &Option<String>, env: &str, remote: Option<&String>| {
            hint.clone().or_else(|| flag.clone()).or_else(|| self.env.get(env).map(str::to_string)).or(remote.cloned())
        };
        let org = pick(&hint.org, &self.flags.org, "DOVA_ORG", remote.as_ref().map(|r| &r.org));
        let project = pick(&hint.project, &self.flags.project, "DOVA_PROJECT", remote.as_ref().map(|r| &r.project));
        let (Some(org), Some(project)) = (org, project) else {
            return Err(Error::user("Could not tell which Azure DevOps organization and project this is about.").hint(
                "Run it inside a repo cloned from Azure Repos, or pass --org and --project (or set DOVA_ORG and DOVA_PROJECT).",
            ));
        };
        // The remote's repo only counts when the remote is what the scope came from.
        let remote_repo = remote.filter(|r| r.org == org && r.project == project).map(|r| r.repo);
        Ok(Scope {
            org_url: urls::org_url(&org),
            org,
            project,
            repo: hint.repo.clone().or_else(|| self.flags.repo.clone()).or(remote_repo),
            branch: if in_repo { self.git.current_branch()? } else { None },
        })
    }

    /// Free text a command takes: `value` as given, or all of stdin when it's omitted or `-`.
    pub fn text(&self, value: Option<&str>, what: &str) -> Result<String> {
        match value {
            Some(value) if value != "-" => Ok(value.to_string()),
            _ => (self.read_stdin)(what),
        }
    }

    /// Progress and asides go to stderr; stdout is the result.
    pub fn note(&self, text: &str) {
        eprintln!("{text}");
    }
}

pub fn cannot_ask(question: &str, options: &[String], answered_by: &str) -> Error {
    Error::user(question)
        .hint(answered_by)
        .hint(format!("Available: {}", options.join(", ")))
        .hint("(No terminal, so dova cannot ask.)")
}

fn choose_in_terminal(question: &str, options: &[String]) -> Result<String> {
    let picked = dialoguer::Select::new().with_prompt(question).items(options).default(0).interact();
    picked.map(|at| options[at].clone()).map_err(|_| Error::user("Cancelled."))
}

/// The process's own stdin. In a terminal there is nothing to read, and waiting for typing helps nobody.
pub fn process_stdin(what: &str) -> Result<String> {
    let hint = "Pipe it in, e.g. … - <<'EOF'";
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Err(Error::user(format!("No {what} given.")).hint(hint));
    }
    let mut bytes = Vec::new();
    stdin.lock().read_to_end(&mut bytes).map_err(|err| Error::user(format!("Could not read the {what}: {err}")))?;
    let text = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
    match text.trim_end_matches('\n') {
        "" => Err(Error::user(format!("No {what} given — stdin was empty.")).hint(hint)),
        text => Ok(text.to_string()),
    }
}

/// stdin for a `dova rpc` or `dova mcp` request: the text is a param, or it isn't there.
pub fn no_stdin(what: &str) -> Result<String> {
    Err(Error::user(format!("No {what} given — pass it as a param.")))
}
