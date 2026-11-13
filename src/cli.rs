//! The command tree, and what happens around every command: parsing,
//! `--json`/`--jq`/`--web`, printing, exit codes.
//!
//! A command is a struct of its arguments and flags with a `run` that
//! returns an `Output`: the data (what `--json` prints) and that data
//! rendered for a person. This tree is the only list of commands there is:
//! shell completion and `dova rpc` both read it.

use std::io::IsTerminal;

use clap::{Args, CommandFactory, Parser, Subcommand};
use serde::Serialize;
use serde_json::Value;

use crate::app::{App, Env, ScopeHint};
use crate::commands::{link, misc, pipeline, pr, status, summarize, wi};
use crate::error::{Error, Result};
use crate::text::Style;

#[derive(Parser)]
#[command(
    name = "dova",
    version,
    about = "Azure DevOps from the terminal — work items, pull requests and pipelines for the repo you are in."
)]
#[command(arg_required_else_help = true, disable_help_subcommand = true, max_term_width = 100)]
pub struct Cli {
    #[command(flatten)]
    pub global: Global,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Args, Debug, Default, Clone)]
#[command(next_help_heading = "Everywhere")]
pub struct Global {
    /// Organization (default: the git remote's, or $DOVA_ORG)
    #[arg(long, global = true)]
    pub org: Option<String>,
    /// Project (default: the git remote's, or $DOVA_PROJECT)
    #[arg(long, global = true)]
    pub project: Option<String>,
    /// Repository (default: the git remote's)
    #[arg(long, global = true)]
    pub repo: Option<String>,
    /// Print the result as JSON
    #[arg(long, global = true)]
    pub json: bool,
    /// Print the result as JSON, filtered through a jq expression
    #[arg(long, global = true, value_name = "EXPRESSION")]
    pub jq: Option<String>,
    /// No colors (also $NO_COLOR)
    #[arg(long, global = true)]
    pub no_color: bool,
    /// Never prompt (also without a terminal, or with $DOVA_NO_INPUT)
    #[arg(long, global = true)]
    pub no_input: bool,
}

impl Global {
    pub fn scope(&self) -> ScopeHint {
        ScopeHint { org: self.org.clone(), project: self.project.clone(), repo: self.repo.clone() }
    }

    /// Whether dova may ask questions: a terminal, and nobody said not to.
    pub fn interactive(&self, env: &Env) -> bool {
        !self.no_input && !env.is_on("DOVA_NO_INPUT") && std::io::stdin().is_terminal()
    }

    pub fn colors_off(&self, env: &Env) -> bool {
        self.no_color || env.get("NO_COLOR").is_some()
    }
}

#[derive(Subcommand)]
pub enum Command {
    /// The branch you're on: its PR, work items, latest pipeline runs and review threads
    Status(status::Status),
    /// Record that the current branch is for these work items, so `dova pr create` links them
    Link(link::Link),
    /// Remove work items from the current branch
    Unlink(link::Unlink),
    /// Local branches linked to work items, most recently active first
    List(link::List),
    /// Catch up on a branch or PR: its tickets, commits and diff since it diverged
    Summarize(summarize::Summarize),
    /// A work item or pull request, from its id or link
    View(wi::ViewAny),
    /// Work items
    #[command(subcommand)]
    Wi(wi::Wi),
    /// File a Bug: `dova wi create --type Bug`
    Bug(wi::Bug),
    /// Pull requests
    #[command(subcommand)]
    Pr(pr::Pr),
    /// Pipeline runs
    #[command(subcommand)]
    Pipeline(pipeline::Pipeline),
    /// Any Azure DevOps REST call, signed in
    Api(misc::Api),
    /// Your Azure sign-in — `az login`, once
    #[command(subcommand)]
    Auth(misc::Auth),
    /// The background process that holds your token (started on first use)
    #[command(subcommand)]
    Daemon(misc::Daemon),
    /// Teach coding agents (Copilot, Windsurf/Devin, Cursor, Codex) to use dova
    Instructions(misc::Instructions),
    /// Serve every command as JSON-RPC over stdin/stdout, for other tools (method list: rpc.methods)
    Rpc,
    /// Serve dova as an MCP server over stdio, for AI agents
    Mcp,
    /// Shell completion script (e.g. `source <(dova completion bash)`)
    Completion(misc::Completion),
    /// Used by the completion scripts.
    #[command(name = "__complete", hide = true)]
    Complete(misc::Complete),
}

impl Command {
    pub fn run(&self, app: &App) -> Result<Output> {
        match self {
            Command::Status(c) => c.run(app),
            Command::Link(c) => c.run(app),
            Command::Unlink(c) => c.run(app),
            Command::List(c) => c.run(app),
            Command::Summarize(c) => c.run(app),
            Command::View(c) => c.run(app),
            Command::Wi(c) => c.run(app),
            Command::Bug(c) => c.run(app),
            Command::Pr(c) => c.run(app),
            Command::Pipeline(c) => c.run(app),
            Command::Api(c) => c.run(app),
            Command::Auth(c) => c.run(app),
            Command::Daemon(c) => c.run(app),
            Command::Instructions(c) => c.run(app),
            Command::Rpc => crate::rpc::serve_stdio(app),
            Command::Mcp => crate::mcp::serve_stdio(app),
            Command::Completion(c) => c.run(),
            Command::Complete(c) => c.run(),
        }
    }
}

/// What a command produced.
#[derive(Debug)]
pub struct Output {
    /// What `--json` prints. None for commands with nothing to report.
    pub data: Option<Value>,
    /// The same thing for a person.
    pub text: String,
    /// A page to open in the browser instead of printing anything: the command was given `--web`.
    pub open: Option<String>,
    /// Usually 0: the command worked, whatever it found.
    pub code: i32,
}

impl Output {
    pub fn new(data: &impl Serialize, text: String) -> Output {
        // Serializing dova's own types cannot fail.
        Output { data: Some(serde_json::to_value(data).unwrap_or(Value::Null)), text, open: None, code: 0 }
    }

    pub fn none() -> Output {
        Output { data: None, text: String::new(), open: None, code: 0 }
    }

    /// With `--web`, the result is this page in the browser.
    pub fn web(mut self, wanted: bool, url: &str) -> Output {
        self.open = wanted.then(|| url.to_string());
        self
    }
}

pub struct Finished {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs dova: parses `args`, builds the App, runs the command. Returns what to print; never exits.
pub fn run(args: &[String], env: &Env, app: impl FnOnce(&Global) -> App) -> Finished {
    let cli = match Cli::try_parse_from(std::iter::once("dova").chain(args.iter().map(String::as_str))) {
        Ok(cli) => cli,
        // Help and version are answers; anything else is bad input.
        Err(err) if err.use_stderr() => {
            return Finished { code: 1, stdout: String::new(), stderr: err.render().to_string() }
        }
        Err(err) => return Finished { code: 0, stdout: err.render().to_string(), stderr: String::new() },
    };
    let global = cli.global.clone();
    match execute(cli, app) {
        Ok((code, text)) => {
            Finished { code, stdout: if text.is_empty() { text } else { text + "\n" }, stderr: String::new() }
        }
        Err(err) => {
            let style = Style::detect_stderr(global.colors_off(env));
            let hints: String = err.hints.iter().map(|hint| style.dim(&format!("  {hint}")) + "\n").collect();
            Finished {
                code: err.exit_code(),
                stdout: String::new(),
                stderr: format!("{} {}\n{hints}", style.red("Error:"), err.message),
            }
        }
    }
}

fn execute(cli: Cli, app: impl FnOnce(&Global) -> App) -> Result<(i32, String)> {
    let global = cli.global;
    // Before the command runs: a typo in the filter shouldn't surface after a PR was created.
    let filter = global.jq.as_deref().map(jq).transpose()?;
    let app = app(&global);
    let output = cli.command.run(&app)?;

    if let Some(url) = &output.open {
        (app.open_url)(url)?;
        return Ok((output.code, String::new()));
    }
    let text = match (output.data, filter) {
        (None, _) => String::new(),
        (Some(data), Some(filter)) => filter(data)?,
        (Some(data), None) if global.json => pretty(&data),
        (Some(_), None) => output.text,
    };
    Ok((output.code, text))
}

pub fn pretty(data: &Value) -> String {
    serde_json::to_string_pretty(data).unwrap_or_default()
}

/// A jq expression, compiled: give it data, get its results one per line, strings unquoted.
fn jq(expression: &str) -> Result<impl Fn(Value) -> Result<String>> {
    use jaq_core::load::{Arena, File, Loader};
    use jaq_core::{Compiler, Ctx, RcIter};

    let invalid = || Error::user(format!("Invalid --jq expression: {expression}"));
    let loader = Loader::new(jaq_std::defs().chain(jaq_json::defs()));
    let arena = Arena::default();
    let modules = loader.load(&arena, File { code: expression, path: () }).map_err(|_| invalid())?;
    let funs = jaq_std::funs().chain(jaq_json::funs());
    let filter = Compiler::default().with_funs(funs).compile(modules).map_err(|_| invalid())?;

    Ok(move |data: Value| {
        let inputs = RcIter::new(core::iter::empty());
        let mut results = Vec::new();
        for result in filter.run((Ctx::new([], &inputs), jaq_json::Val::from(data))) {
            let value = Value::from(result.map_err(|err| Error::user(format!("--jq failed: {err}")))?);
            results.push(match value {
                Value::String(text) => text,
                other => pretty(&other),
            });
        }
        Ok(results.join("\n"))
    })
}

/* ---------------- the tree, as data ---------------- */

/// `id-or-url` and `id_or_url` → `idOrUrl`: how `dova rpc` names arguments and flags.
pub fn camel(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper = false;
    for c in name.chars() {
        if c == '-' || c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

pub fn tree() -> clap::Command {
    Cli::command()
}

/// A command's own flags, as `--long`; the global ones are not among them.
pub fn flags_of(command: &clap::Command) -> impl Iterator<Item = &clap::Arg> {
    command.get_arguments().filter(|arg| !arg.is_positional() && !arg.is_global_set() && arg.get_long().is_some())
}

/// What can come next after `words`: a subcommand, or with a `-` prefix, a flag.
pub fn complete(words: &[String]) -> Vec<String> {
    let root = tree();
    let (current, before) = words.split_last().map_or(("", words), |(last, before)| (last.as_str(), before));
    let mut node = &root;
    let mut past_commands = false;
    for word in before.iter().filter(|w| !w.starts_with('-')) {
        match node.get_subcommands().find(|sub| sub.get_name() == word) {
            Some(sub) if !past_commands => node = sub,
            _ => past_commands = true,
        }
    }
    let candidates: Vec<String> = if current.starts_with('-') {
        let global = root.get_arguments().filter(|arg| arg.is_global_set());
        flags_of(node)
            .chain(global)
            .filter_map(|arg| arg.get_long())
            .map(|long| format!("--{long}"))
            .chain(["--help".to_string()])
            .collect()
    } else if past_commands {
        Vec::new()
    } else {
        node.get_subcommands().filter(|sub| !sub.is_hide_set()).map(|sub| sub.get_name().to_string()).collect()
    };
    candidates.into_iter().filter(|c| c.starts_with(current)).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::testing::{batch, cli, ok, Bed};

    #[test]
    fn the_command_tree_is_consistent() {
        super::tree().debug_assert();
    }

    #[test]
    fn json_prints_the_data_and_jq_filters_it() {
        let bed = Bed::new(Box::new(|r| {
            if r.path.ends_with("/pullrequests") || r.path.ends_with("/builds") {
                ok(json!({ "value": [] }))
            } else {
                batch(vec![])(r)
            }
        }));
        assert_eq!(cli(bed.app(), &["status", "--json"]).json()["branch"], "feature/x");
        assert_eq!(cli(bed.app(), &["status", "--jq", ".branch"]).stdout, "feature/x\n");
        assert_eq!(
            cli(bed.app(), &["status", "--jq", "{branch, runs: (.runs | length)}"]).json(),
            json!({ "branch": "feature/x", "runs": 0 })
        );
        let bad = cli(bed.app(), &["status", "--jq", ".["]);
        assert_eq!((bad.code, bad.stderr.contains("Invalid --jq expression")), (1, true));
        assert_eq!(bed.ado.requests().len(), 6, "the bad filter was caught before anything was asked");
    }

    #[test]
    fn usage_errors_exit_1_and_help_exits_0() {
        let bed = Bed::new(Box::new(|_| None));
        let unknown = cli(bed.app(), &["nope"]);
        assert_eq!((unknown.code, unknown.stdout.as_str()), (1, ""));
        let help = cli(bed.app(), &["pr", "--help"]);
        assert_eq!(help.code, 0);
        assert!(help.stdout.contains("reply") && !help.stdout.contains("__complete"));
        assert_eq!(cli(bed.app(), &["--version"]).stdout, format!("dova {}\n", env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn completes_commands_and_flags() {
        let bed = Bed::new(Box::new(|_| None));
        assert_eq!(cli(bed.app(), &["__complete", "--", "pi"]).stdout, "pipeline\n");
        assert_eq!(cli(bed.app(), &["__complete", "--", "pr", "create", "--dr"]).stdout, "--draft\n");
        assert_eq!(cli(bed.app(), &["__complete", "--", "pr", "reply", "7", "3", "--res"]).stdout, "--resolve\n");
        assert_eq!(cli(bed.app(), &["__complete", "--", "status", "--j"]).stdout, "--json\n--jq\n");
        assert_eq!(cli(bed.app(), &["__complete", "--", "__"]).stdout, "");
    }
}
