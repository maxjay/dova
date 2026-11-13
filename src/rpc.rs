//! `dova rpc`: every dova command as a JSON-RPC 2.0 method, one JSON
//! message per line on stdin/stdout — for tools that want Azure DevOps
//! through dova rather than through az.
//!
//!   → {"jsonrpc":"2.0","id":1,"method":"wi.view","params":{"idOrUrl":"4821"}}
//!   ← {"jsonrpc":"2.0","id":1,"result":{"id":4821,"title":…}}
//!
//! A method is a command path joined with dots (`status`, `pr.create`,
//! `pipeline.log`). Params are its arguments and flags by camelCased name,
//! plus `cwd` (which repo to act in) and `org`/`project`/`repo`. Results
//! are exactly what `--json` prints. `rpc.methods` lists them. Requests
//! run concurrently; nothing prompts, and text that the CLI would read
//! from stdin is passed as a param instead.
//!
//! There is no second list of commands here: a call is turned into the
//! command line it stands for and goes through the same parser.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use clap::Parser;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::ado::Transport;
use crate::app::{self, no_stdin, App, Env, ScopeHint};
use crate::cli::{camel, flags_of, tree, Cli, Output};
use crate::daemon;
use crate::error::{Error, Result};
use crate::text::Style;

/// Commands that make no sense as a request (run forever, need a terminal, or are this).
const EXCLUDED: [&str; 5] = ["rpc", "mcp", "daemon.run", "completion", "__complete"];

#[derive(Debug, Serialize, PartialEq)]
pub struct Method {
    pub name: String,
    pub description: String,
    /// Positional arguments, in order; `…` marks a list.
    pub args: Vec<String>,
    pub options: Vec<String>,
}

fn takes_many(arg: &clap::Arg) -> bool {
    arg.get_num_args().is_some_and(|n| n.max_values() > 1) || matches!(arg.get_action(), clap::ArgAction::Append)
}

/// Every leaf command under `command`, with the path of names that leads to it.
fn leaves<'a>(command: &'a clap::Command, path: Vec<&'a str>, found: &mut Vec<(Vec<&'a str>, &'a clap::Command)>) {
    for sub in command.get_subcommands() {
        let path: Vec<&str> = path.iter().copied().chain([sub.get_name()]).collect();
        if sub.has_subcommands() {
            leaves(sub, path, found);
        } else if !EXCLUDED.contains(&path.join(".").as_str()) {
            found.push((path, sub));
        }
    }
}

/// A command's flags as a request can set them. `--web` isn't one: a
/// result carries its url, and opening a browser is the caller's to do.
fn options(command: &clap::Command) -> impl Iterator<Item = &str> {
    flags_of(command).filter_map(|arg| arg.get_long()).filter(|long| *long != "web")
}

pub fn methods() -> Vec<Method> {
    let root = tree();
    let mut found = Vec::new();
    leaves(&root, Vec::new(), &mut found);
    let method = |(path, command): &(Vec<&str>, &clap::Command)| Method {
        name: path.join("."),
        description: command.get_about().map(ToString::to_string).unwrap_or_default(),
        args: command
            .get_positionals()
            .map(|arg| camel(arg.get_id().as_str()) + if takes_many(arg) { "…" } else { "" })
            .collect(),
        options: options(command).map(camel).collect(),
    };
    found.iter().map(method).collect()
}

/// A protocol-level failure, or one of dova's own with its kind attached.
#[derive(Debug)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> RpcError {
        RpcError { code, message: message.into(), data: None }
    }
}

/// dova's error kind, for a client to branch on: exitCode 2 not found, 3 not signed in or no access, …
pub fn error_data(err: &Error) -> Value {
    json!({ "kind": err.kind, "exitCode": err.exit_code(), "hints": err.hints })
}

impl From<Error> for RpcError {
    fn from(err: Error) -> RpcError {
        RpcError { code: -32000, data: Some(error_data(&err)), message: err.message }
    }
}

/// Runs commands by method name, as `dova rpc` and `dova mcp` both do:
/// one App per call, all on one daemon connection.
pub struct Invoker {
    app: MakeApp,
}

/// The App for one call, from the call's params (`cwd`, `org`, `project`, `repo`).
pub type MakeApp = Box<dyn Fn(&Map<String, Value>) -> App + Send + Sync>;

/// A param as command-line words: a list is several, everything else is one.
fn words(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().flat_map(words).collect(),
        Value::String(text) => vec![text.clone()],
        other => vec![other.to_string()],
    }
}

impl Invoker {
    pub fn new(env: Env, transport: Arc<dyn Transport>) -> Invoker {
        let text = |params: &Map<String, Value>, key: &str| params.get(key).and_then(Value::as_str).map(str::to_string);
        Invoker::with(Box::new(move |params| {
            App::new(app::Options {
                env: env.clone(),
                interactive: false,
                flags: ScopeHint {
                    org: text(params, "org"),
                    project: text(params, "project"),
                    repo: text(params, "repo"),
                },
                style: Style::PLAIN,
                cwd: text(params, "cwd").map(PathBuf::from),
                transport: transport.clone(),
                read_stdin: Box::new(no_stdin),
            })
        }))
    }

    /// With the App each call gets made by `app`, from the call's params.
    pub fn with(app: MakeApp) -> Invoker {
        Invoker { app }
    }

    pub fn invoke(&self, method: &str, params: &Map<String, Value>) -> Result<Value, RpcError> {
        if method == "rpc.methods" {
            return Ok(json!(methods()));
        }
        let root = tree();
        let mut found = Vec::new();
        leaves(&root, Vec::new(), &mut found);
        let (path, command) = found
            .into_iter()
            .find(|(path, _)| path.join(".") == method)
            .ok_or_else(|| RpcError::new(-32601, format!("Unknown method \"{method}\".")))?;

        // The command line this call stands for: flags as `--name=value`, then every argument after `--`.
        let mut line: Vec<String> = ["dova"].into_iter().chain(path).map(str::to_string).collect();
        for long in options(command) {
            match params.get(&camel(long)) {
                None | Some(Value::Null | Value::Bool(false)) => {}
                Some(Value::Bool(true)) => line.push(format!("--{long}")),
                Some(value) => line.extend(words(value).into_iter().map(|word| format!("--{long}={word}"))),
            }
        }
        line.push("--".to_string());
        let given = command
            .get_positionals()
            .map_while(|arg| params.get(&camel(arg.get_id().as_str())).filter(|v| !v.is_null()));
        line.extend(given.flat_map(words));

        let cli = Cli::try_parse_from(line).map_err(|err| Error::user(err.render().to_string().trim().to_string()))?;
        let app = (self.app)(params);
        let Output { data, .. } = cli.command.run(&app)?;
        Ok(data.unwrap_or(Value::Null))
    }
}

/// A newline-delimited JSON-RPC 2.0 server, answering until the input
/// ends. Each request runs on its own thread; notifications get no reply.
pub fn serve_lines(
    input: impl BufRead,
    output: impl Write + Send,
    handle: impl Fn(&str, &Map<String, Value>, bool) -> Result<Value, RpcError> + Sync,
) {
    let output = Mutex::new(output);
    let reply = |message: Value| {
        let mut line = message.to_string();
        line.push('\n');
        let mut output = output.lock().unwrap();
        // The client hung up: nobody is left to answer.
        if output.write_all(line.as_bytes()).and_then(|()| output.flush()).is_err() {
            std::process::exit(0);
        }
    };
    std::thread::scope(|requests| {
        for line in input.lines().map_while(|line| line.ok()) {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(Value::Object(request)) = serde_json::from_str::<Value>(&line) else {
                reply(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }));
                continue;
            };
            let (reply, handle) = (&reply, &handle);
            requests.spawn(move || {
                let id = request.get("id");
                let method = request.get("method").and_then(Value::as_str).unwrap_or("");
                let none = Map::new();
                let params = request.get("params").and_then(Value::as_object).unwrap_or(&none);
                let result = handle(method, params, id.is_none());
                let Some(id) = id else { return };
                reply(match result {
                    Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    Err(err) => {
                        let mut error = json!({ "code": err.code, "message": err.message });
                        if let Some(data) = err.data {
                            error["data"] = data;
                        }
                        json!({ "jsonrpc": "2.0", "id": id, "error": error })
                    }
                });
            });
        }
    });
}

/// The process's own stdin and stdout, with what `dova rpc` and `dova mcp` share: no prompts, one daemon connection.
pub fn stdio_invoker(app: &App) -> Invoker {
    Invoker::new(app.env.clone(), daemon::transport(&app.env, false))
}

pub fn serve_stdio(app: &App) -> Result<Output> {
    let invoker = stdio_invoker(app);
    serve_lines(std::io::stdin().lock(), std::io::stdout(), |method, params, _| invoker.invoke(method, params));
    Ok(Output::none())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testing::{batch, ok, wi, Bed, Recorded, Route};

    /// Sends lines to `dova rpc` and collects every reply.
    fn rpc(lines: &[Value], route: Route) -> Vec<Value> {
        let bed = Bed::new(route);
        let invoker = bed.invoker();
        let input: String =
            lines.iter().map(|line| line.as_str().map_or(line.to_string(), str::to_string) + "\n").collect();
        let mut output = Vec::new();
        serve_lines(input.as_bytes(), &mut output, |method, params, _| invoker.invoke(method, params));
        String::from_utf8(output).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn item_4821() -> Route {
        Box::new(|r: &Recorded| {
            if r.path.ends_with("/wiql") {
                ok(json!({ "workItems": [] }))
            } else {
                batch(vec![wi(4821, json!({}))])(r)
            }
        })
    }

    #[test]
    fn runs_a_command_as_a_method_and_returns_what_json_would() {
        let replies = rpc(
            &[json!({ "jsonrpc": "2.0", "id": 1, "method": "wi.view", "params": { "idOrUrl": "4821" } })],
            item_4821(),
        );
        assert_eq!((&replies[0]["jsonrpc"], &replies[0]["id"]), (&json!("2.0"), &json!(1)));
        let result = &replies[0]["result"];
        assert_eq!(
            (result["id"].as_u64(), result["title"].as_str(), &result["children"]),
            (Some(4821), Some("Item 4821"), &json!([]))
        );
    }

    #[test]
    fn lists_its_methods_with_their_arguments_and_options() {
        let replies = rpc(&[json!({ "id": "m", "method": "rpc.methods" })], item_4821());
        let all = replies[0]["result"].as_array().unwrap();
        let named = |name: &str| all.iter().find(|m| m["name"] == name).cloned();
        let reply = named("pr.reply").unwrap();
        assert_eq!((&reply["args"], &reply["options"]), (&json!(["pr", "thread", "text"]), &json!(["resolve"])));
        assert_eq!(named("link").unwrap()["args"], json!(["ids…"]));
        assert_eq!(
            named("wi.create").unwrap()["options"],
            json!(["type", "body", "parent", "assignee", "at", "link", "team", "area", "iteration", "like"])
        );
        assert!(named("daemon.run").is_none() && named("__complete").is_none() && named("daemon.status").is_some());
    }

    #[test]
    fn reports_dovas_errors_with_their_kind_and_protocol_errors_as_json_rpc_ones() {
        let replies = rpc(
            &[
                json!({ "id": 1, "method": "wi.view", "params": { "idOrUrl": "9" } }),
                json!({ "id": 2, "method": "nope" }),
                json!("not json"),
                json!({ "id": 3, "method": "bug", "params": {} }),
                json!({ "method": "status" }),
            ],
            Box::new(|r| if r.path.ends_with("workitemsbatch") { ok(json!({ "value": [null] })) } else { None }),
        );
        assert_eq!(replies.len(), 4, "a notification gets no reply");
        let error = |id: Value| replies.iter().find(|r| r["id"] == id).map(|r| r["error"].clone()).unwrap();
        assert_eq!(
            (&error(json!(1))["code"], &error(json!(1))["data"]["kind"], &error(json!(1))["data"]["exitCode"]),
            (&json!(-32000), &json!("not_found"), &json!(2))
        );
        assert_eq!(error(json!(2))["code"], -32601);
        assert_eq!(error(json!(null))["code"], -32700);
        assert_eq!(
            (error(json!(3))["message"].as_str(), &error(json!(3))["data"]["exitCode"]),
            (Some("No title given — pass it as a param."), &json!(1))
        );
    }

    #[test]
    fn text_goes_through_exactly_as_given_whatever_it_looks_like() {
        let bed = Bed::new(Box::new(|r: &Recorded| {
            if r.method == "POST" {
                ok(json!({ "id": 3 }))
            } else {
                ok(crate::testing::rest_pr(7, json!({})))
            }
        }));
        let params = json!({ "pr": 7, "text": "--resolve `$x` \"quoted\"\n-- second line" });
        let result = bed.invoker().invoke("pr.comment", params.as_object().unwrap()).unwrap();
        assert_eq!(result, json!({ "prId": 7, "threadId": 3 }));
        let posted = bed.ado.requests().into_iter().find(|r| r.method == "POST").unwrap().body;
        assert_eq!(posted["comments"][0]["content"], "--resolve `$x` \"quoted\"\n-- second line");
    }

    #[test]
    fn flags_take_lists_booleans_and_text_starting_with_a_dash() {
        let bed = Bed::new(Box::new(|r: &Recorded| {
            if r.method == "POST" {
                ok(crate::testing::rest_pr(9, json!({})))
            } else {
                ok(json!({ "defaultBranch": "refs/heads/main" }))
            }
        }));
        let params = json!({ "title": "-x", "body": "- a list\n- of things", "draft": true, "workItems": [41, "42"] });
        bed.invoker().invoke("pr.create", params.as_object().unwrap()).unwrap();
        let body = bed.ado.requests().into_iter().find(|r| r.method == "POST").unwrap().body;
        assert_eq!(
            (&body["title"], &body["description"], &body["isDraft"]),
            (&json!("-x"), &json!("- a list\n- of things"), &json!(true))
        );
        assert_eq!(body["workItemRefs"], json!([{ "id": "41" }, { "id": "42" }]));
    }
}
