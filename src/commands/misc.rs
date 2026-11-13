//! The commands around the edges: the REST escape hatch, sign-in and
//! daemon status, shell completion, and instructions for coding agents.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use clap::{Args, Subcommand};
use serde_json::{json, Value};

use crate::ado::auth::Session;
use crate::ado::Method;
use crate::app::App;
use crate::cli::{self, pretty, Output};
use crate::daemon::{self, Client, DaemonStatus};
use crate::error::{Error, Result};
use crate::urls::enc;

/* ---------------- api ---------------- */

#[derive(Args)]
pub struct Api {
    /// REST path: `/…` is org-relative, anything else project-relative; or a full https URL
    pub path: String,
    /// HTTP method
    #[arg(short = 'X', long, default_value = "GET")]
    pub method: String,
    /// Request body: JSON, @file, or '-' for stdin
    #[arg(short = 'f', long)]
    pub body: Option<String>,
    /// Body content type (default: application/json)
    #[arg(long, value_name = "TYPE")]
    pub content_type: Option<String>,
}

impl Api {
    pub fn run(&self, app: &App) -> Result<Output> {
        let scope = app.scope()?;
        let ado = app.ado(&scope.org_url);
        let method =
            Method::parse(&self.method).ok_or_else(|| Error::user(format!("Unknown method {}.", self.method)))?;
        let url = match self.path.as_str() {
            full if full.starts_with("https://") => full.to_string(),
            path => match path.strip_prefix('/') {
                Some(org_relative) => ado.url(org_relative, &[])?,
                None => ado.url(&format!("{}/{path}", enc(&scope.project)), &[])?,
            },
        };
        let body = match self.body.as_deref() {
            Some("-") => Some(app.text(None, "body")?),
            Some(body) => match body.strip_prefix('@') {
                Some(file) => Some(
                    std::fs::read_to_string(file)
                        .map_err(|err| Error::user(format!("Could not read {file}: {err}")))?,
                ),
                None => Some(body.to_string()),
            },
            None => None,
        };
        let res = ado.raw(method, url, body, self.content_type.clone())?;
        if res.body.trim().is_empty() {
            return Ok(Output::new(&Value::Null, "null".to_string()));
        }
        Ok(match serde_json::from_str::<Value>(&res.body) {
            Ok(data) => Output::new(&data, pretty(&data)),
            // Build logs and other plain text.
            Err(_) => Output::new(&res.body, res.body.trim_end().to_string()),
        })
    }
}

/* ---------------- auth ---------------- */

#[derive(Subcommand)]
pub enum Auth {
    /// Who you're signed in as, and whether this repo's organization accepts it
    Status,
}

impl Auth {
    pub fn run(&self, app: &App) -> Result<Output> {
        let status = app.transport.auth_status()?;
        let mut org = Value::Null;
        if let (true, Ok(scope)) = (status.signed_in, app.scope()) {
            org = match app.ado(&scope.org_url).me() {
                Ok(account) => json!({ "url": scope.org_url, "ok": true, "as": account }),
                Err(err) => json!({ "url": scope.org_url, "ok": false, "error": err.message }),
            };
        }
        let s = app.style;
        let text = if status.signed_in {
            let holder = if app.transport.kind() == "daemon" { "by the dova daemon" } else { "by this command" };
            let mut out = vec![
                format!(
                    "Signed in as {} {}",
                    s.bold(status.account.as_deref().unwrap_or("?")),
                    s.dim(&format!("(tenant {})", status.tenant.as_deref().unwrap_or("?")))
                ),
                format!("  Token from az, held {holder} until {}", status.expires_at.as_deref().unwrap_or("?")),
            ];
            match (org["url"].as_str(), org["ok"].as_bool()) {
                (Some(url), Some(true)) => out.push(format!(
                    "  {url}: {}{}",
                    s.green("ok"),
                    s.dim(&format!(" as {}", org["as"].as_str().unwrap_or("?")))
                )),
                (Some(url), _) => {
                    out.push(format!("  {url}: {} — {}", s.red("failed"), org["error"].as_str().unwrap_or("?")))
                }
                _ => {}
            }
            out.join("\n")
        } else {
            format!(
                "{} {}\n  Run: az login — or any dova command, which runs it for you.",
                s.yellow("Not signed in."),
                status.error.as_deref().unwrap_or("")
            )
        };
        let failed = !status.signed_in || org["ok"] == false;
        let mut data = json!(status);
        data["via"] = json!(app.transport.kind());
        data["org"] = org;
        Ok(Output { code: if failed { 3 } else { 0 }, ..Output::new(&data, text) })
    }
}

/* ---------------- daemon ---------------- */

#[derive(Subcommand)]
pub enum Daemon {
    /// Run the daemon in the foreground
    Run,
    /// Start it now
    Start,
    /// Stop it; the next command starts a fresh one
    Stop,
    /// Whether it is running, and what it has done
    Status,
}

impl Daemon {
    pub fn run(&self, app: &App) -> Result<Output> {
        let paths = daemon::paths(&app.env);
        let s = app.style;
        match self {
            Daemon::Run => {
                daemon::serve(paths, Session::from_az(), std::io::stderr().is_terminal())?.wait();
                Ok(Output::none())
            }
            Daemon::Start => {
                let status: DaemonStatus = daemon::connect(&paths)?.call("daemon.status", Value::Null)?;
                Ok(Output::new(&status, format!("{} (pid {})", s.green("Running"), status.pid)))
            }
            Daemon::Stop => {
                let running = Client::open(&paths).map(|(client, _)| client.stop(&paths)).is_some();
                let text = if running { s.green("Stopped.") } else { s.dim("Not running.") };
                Ok(Output::new(&json!({ "stopped": running }), text))
            }
            Daemon::Status => Ok(match Client::open(&paths) {
                Some((_, status)) => {
                    let text = format!(
                        "{} — pid {}, since {}, {} requests\n  Build:  {}\n  Socket: {}\n  Log:    {}",
                        s.green("Running"),
                        status.pid,
                        status.started_at,
                        status.requests,
                        status.build,
                        status.socket,
                        status.log
                    );
                    Output::new(&status, text)
                }
                None => {
                    let log = paths.log.display().to_string();
                    Output::new(
                        &json!({ "running": false, "log": log }),
                        format!("{} — the next command starts it.\n  Log: {log}", s.yellow("Not running")),
                    )
                }
            }),
        }
    }
}

/* ---------------- completion ---------------- */

/// Shims, not generated scripts: the shell asks `dova __complete` what can
/// come next, so completion is always the command tree of the dova that's
/// installed. The same files ship in the Linux package.
const SHELLS: [(&str, &str); 4] = [
    ("bash", include_str!("../../completions/dova.bash")),
    ("zsh", include_str!("../../completions/_dova")),
    ("fish", include_str!("../../completions/dova.fish")),
    ("powershell", include_str!("../../completions/dova.ps1")),
];

#[derive(Args)]
pub struct Completion {
    /// bash, zsh, fish or powershell
    pub shell: String,
}

impl Completion {
    pub fn run(&self) -> Result<Output> {
        let supported: Vec<&str> = SHELLS.iter().map(|(shell, _)| *shell).collect();
        let script = SHELLS.iter().find(|(shell, _)| *shell == self.shell).map(|(_, script)| *script);
        let script = script.ok_or_else(|| {
            Error::user(format!("No completion for \"{}\".", self.shell))
                .hint(format!("Supported: {}", supported.join(", ")))
        })?;
        Ok(Output::new(&script, script.trim_end().to_string()))
    }
}

#[derive(Args)]
pub struct Complete {
    /// The command line so far, without `dova`; the last word is the one being typed.
    #[arg(allow_hyphen_values = true)]
    pub words: Vec<String>,
    /// Nothing of the next word is typed yet.
    #[arg(long)]
    pub new_word: bool,
}

impl Complete {
    pub fn run(&self) -> Result<Output> {
        let mut words = self.words.clone();
        if self.new_word {
            words.push(String::new());
        }
        let candidates = cli::complete(&words);
        Ok(Output::new(&candidates, candidates.join("\n")))
    }
}

/* ---------------- agent instructions ---------------- */

const BLOCK: &str = include_str!("../instructions.md");
const START: &str = "<!-- dova:start -->";
const END: &str = "<!-- dova:end -->";

/// Replaces dova's block in place, or appends it; the rest of the file is left exactly as it was.
pub fn splice_block(existing: Option<&str>, body: &str) -> String {
    let block = format!(
        "{START}\n<!-- Written by `dova instructions`; edits inside this block are overwritten. -->\n\n{}\n{END}\n",
        body.trim()
    );
    let Some(existing) = existing else { return block };
    match (existing.find(START), existing.find(END)) {
        (Some(start), Some(end)) if end > start => {
            let after = &existing[end + END.len()..];
            format!("{}{block}{}", &existing[..start], after.strip_prefix('\n').unwrap_or(after))
        }
        _ if existing.trim_end_matches('\n').is_empty() => block,
        _ => format!("{}\n\n{block}", existing.trim_end_matches('\n')),
    }
}

#[derive(Args)]
pub struct Instructions {
    /// Write AGENTS.md and .github/copilot-instructions.md into this repo instead, to commit for your team
    #[arg(long)]
    pub in_repo: bool,
}

/// Where each agent reads its always-on instructions, and what the file must start with when dova creates it.
fn instruction_files(app: &App, in_repo: bool) -> Result<Vec<(PathBuf, &'static str)>> {
    if in_repo {
        let root = app
            .git
            .try_run(&["rev-parse", "--show-toplevel"])?
            .map(PathBuf::from)
            .ok_or_else(|| Error::user("--in-repo needs to run inside a git repo."))?;
        return Ok(vec![(root.join("AGENTS.md"), ""), (root.join(".github").join("copilot-instructions.md"), "")]);
    }
    let home = PathBuf::from(
        app.env
            .get(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .ok_or_else(|| Error::prereq("Could not tell where your home directory is."))?,
    );
    let config = if cfg!(windows) {
        app.env.get("APPDATA").map_or_else(|| home.join("AppData").join("Roaming"), PathBuf::from)
    } else if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else {
        home.join(".config")
    };
    // Every VS Code that's installed; the plain one if none is, so it's there when it arrives.
    let mut editors: Vec<PathBuf> = ["Code", "Code - Insiders", "VSCodium"]
        .iter()
        .map(|name| config.join(name).join("User"))
        .filter(|dir| dir.exists())
        .collect();
    if editors.is_empty() {
        editors.push(config.join("Code").join("User"));
    }
    let mut files = vec![(home.join(".codeium").join("windsurf").join("memories").join("global_rules.md"), "")];
    // `applyTo: '**'` is what makes a user-level instructions file apply in every workspace.
    files.extend(
        editors.into_iter().map(|dir| (dir.join("prompts").join("dova.instructions.md"), "---\napplyTo: '**'\n---\n")),
    );
    Ok(files)
}

fn write_instructions(file: &Path, preamble: &str) -> Result<bool> {
    let existing = std::fs::read_to_string(file).ok();
    let spliced = splice_block(existing.as_deref(), BLOCK);
    let content = if existing.is_none() { format!("{preamble}{spliced}") } else { spliced };
    if existing.as_deref() == Some(content.as_str()) {
        return Ok(false);
    }
    let could_not = |err: std::io::Error| Error::external(format!("Could not write {}: {err}", file.display()));
    std::fs::create_dir_all(file.parent().unwrap_or(Path::new("."))).map_err(could_not)?;
    std::fs::write(file, content).map_err(could_not)?;
    Ok(true)
}

impl Instructions {
    pub fn run(&self, app: &App) -> Result<Output> {
        let s = app.style;
        let (mut files, mut out) = (Vec::new(), Vec::new());
        for (file, preamble) in instruction_files(app, self.in_repo)? {
            let changed = write_instructions(&file, preamble)?;
            out.push(format!("{} {}", if changed { s.green("✓ wrote") } else { s.dim("= unchanged") }, file.display()));
            files.push(json!({ "file": file.display().to_string(), "changed": changed }));
        }
        out.push(s.dim("Re-run after upgrading dova."));
        Ok(Output::new(&json!({ "files": files }), out.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::ado::Response;
    use crate::testing::{cli, ok, Bed, Recorded};

    #[test]
    fn api_paths_are_project_relative_unless_they_start_with_a_slash() {
        let bed = Bed::new(Box::new(|r: &Recorded| {
            if r.path.contains("/logs/") {
                Some(Response { status: 200, content_type: None, body: "plain\n".into() })
            } else {
                ok(json!({ "count": 1 }))
            }
        }));
        assert_eq!(cli(bed.app(), &["api", "_apis/git/repositories"]).stdout, "{\n  \"count\": 1\n}\n");
        assert_eq!(cli(bed.app(), &["api", "/_apis/projects", "-X", "post", "-f", "{\"a\":1}"]).code, 0);
        assert_eq!(cli(bed.app(), &["api", "_apis/build/builds/1/logs/2"]).stdout, "plain\n");
        assert_eq!(cli(bed.app(), &["api", "x", "-X", "TRACE"]).code, 1);
        let requests = bed.ado.requests();
        assert_eq!(
            (requests[0].path.as_str(), requests[0].query("api-version").as_deref()),
            ("/MyProject/_apis/git/repositories", Some("7.1"))
        );
        assert_eq!(
            (requests[1].method.as_str(), requests[1].path.as_str(), &requests[1].body),
            ("POST", "/_apis/projects", &json!({ "a": 1 }))
        );
        assert_eq!(requests[1].raw.content_type.as_deref(), Some("application/json"));
    }

    #[test]
    fn auth_status_says_who_and_whether_the_org_takes_it() {
        let bed = Bed::new(Box::new(|_| ok(json!({ "authenticatedUser": { "providerDisplayName": "Jane Doe" } }))));
        let res = cli(bed.app(), &["auth", "status", "--json"]);
        let status = res.json();
        assert_eq!(
            (res.code, status["account"].as_str(), status["via"].as_str()),
            (0, Some("jane@contoso.com"), Some("in-process"))
        );
        assert_eq!(status["org"], json!({ "url": "https://dev.azure.com/contoso", "ok": true, "as": "Jane Doe" }));

        let refused = cli(
            Bed::new(Box::new(|_| Some(crate::testing::json_response(401, json!({ "message": "no" }))))).app(),
            &["auth", "status"],
        );
        assert_eq!(
            (refused.code, refused.stdout.contains("failed — Azure DevOps refused the request: no")),
            (3, true),
            "{}",
            refused.stdout
        );
    }

    #[test]
    fn completion_scripts_exist_for_four_shells() {
        let bed = Bed::new(Box::new(|_| None));
        assert!(cli(bed.app(), &["completion", "bash"]).stdout.contains("complete -F _dova dova"));
        assert!(cli(bed.app(), &["completion", "powershell"]).stdout.contains("Register-ArgumentCompleter"));
        let unknown = cli(bed.app(), &["completion", "tcsh"]);
        assert_eq!((unknown.code, unknown.stderr.contains("Supported: bash, zsh, fish, powershell")), (1, true));
    }

    #[test]
    fn splices_its_block_in_place_and_leaves_the_rest_alone() {
        let first = splice_block(None, "v1");
        assert!(first.starts_with(START) && first.ends_with(&format!("\nv1\n{END}\n")));
        let around = format!("# Mine\n\n{first}\nAfter\n");
        assert_eq!(splice_block(Some("# Mine\n"), "v1") + "\nAfter\n", around);
        let updated = splice_block(Some(&around), "v2");
        assert!(
            updated.starts_with("# Mine\n\n<!-- dova:start -->")
                && updated.ends_with("\nv2\n<!-- dova:end -->\n\nAfter\n"),
            "{updated}"
        );
        assert_eq!(splice_block(Some(&updated), "v2"), updated);
    }

    #[test]
    fn instructions_in_repo_writes_both_files_once() {
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path().to_string_lossy().into_owned();
        let bed = Bed::new(Box::new(|_| None))
            .git(crate::testing::GitOpts::default().answer("rev-parse --show-toplevel", &root));
        let first = cli(bed.app(), &["instructions", "--in-repo", "--json"]).json();
        assert_eq!(
            first["files"].as_array().unwrap().iter().map(|f| f["changed"].as_bool().unwrap()).collect::<Vec<_>>(),
            [true, true]
        );
        let agents = std::fs::read_to_string(repo.path().join("AGENTS.md")).unwrap();
        assert!(
            agents.contains("## Azure DevOps: use `dova`")
                && repo.path().join(".github/copilot-instructions.md").exists()
        );
        let again = cli(bed.app(), &["instructions", "--in-repo", "--json"]).json();
        assert_eq!(again["files"][0]["changed"], false);
    }
}
