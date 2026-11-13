//! `dova mcp`: dova as an MCP server (stdio). Not one tool per command —
//! ten tools shaped around what an agent actually does, each mapped onto
//! the commands underneath. Free text travels as JSON, so the shell
//! quoting rules the CLI instructions are full of don't exist here.

use serde_json::{json, Map, Value};

use crate::app::App;
use crate::cli::Output;
use crate::error::{Error, Result};
use crate::rpc::{serve_lines, stdio_invoker, Invoker, RpcError};

type Params = Map<String, Value>;

struct Tool {
    name: &'static str,
    description: &'static str,
    /// The JSON Schema `properties` of its input.
    properties: Value,
    required: &'static [&'static str],
    /// The command that does it, and that command's params, from the tool's arguments.
    command: fn(&Params) -> Result<(&'static str, Value)>,
}

fn text(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn flag(description: &str) -> Value {
    json!({ "type": "boolean", "description": description })
}

/// An id: agents send them as numbers and as strings, so both are taken.
fn id(description: &str) -> Value {
    json!({ "type": ["string", "number"], "description": description })
}

fn ids(description: &str) -> Value {
    json!({ "type": "array", "items": { "type": ["string", "number"] }, "description": description })
}

/// The tool's arguments are the command's params, name for name.
fn same(arguments: &Params) -> Value {
    Value::Object(arguments.clone())
}

fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "status",
            description: "Start here. The checked-out branch: its pull request, linked work items, latest pipeline runs, and review threads (open first, with each thread's last comment).",
            properties: json!({}),
            required: &[],
            command: |_| Ok(("status", json!({}))),
        },
        Tool {
            name: "view",
            description: "A work item (with parent, children and its full description / acceptance criteria / repro steps) or a pull request (with work items and review threads), by id or link. A bare id is tried as a work item first.",
            properties: json!({ "id": id("work item or PR id, or a link to either") }),
            required: &["id"],
            command: |a| Ok(("view", json!({ "idOrUrl": a.get("id") }))),
        },
        Tool {
            name: "summarize",
            description: "Catch up on a branch or PR: its work items' content, commits, and diff stat since it diverged from its base. Pass `files` to get the actual diff for those paths.",
            properties: json!({
                "target": text("branch name, PR id or PR link (default: the checked-out branch)"),
                "base": text("compare against this branch (default: the PR target, else the repo default branch)"),
                "files": { "type": "array", "items": { "type": "string" }, "description": "paths to include the full diff for" },
                "full": flag("full commit messages and the whole diff"),
            }),
            required: &[],
            command: |a| Ok(("summarize", same(a))),
        },
        Tool {
            name: "search_work_items",
            description: "Work items in the project, newest change first. Use assignee \"me\" for the signed-in user's.",
            properties: json!({ "query": text("words in the title"), "state": text("state"), "type": text("work item type"), "assignee": text("assignee, or \"me\""), "tag": text("tag") }),
            required: &[],
            command: |a| Ok(("wi.search", same(a))),
        },
        Tool {
            name: "create_work_item",
            description: "File a work item, in the team's default area and current sprint. If the project has several teams and none is remembered for the repo, the error lists them — pass `team`.",
            properties: json!({
                "title": text("title"),
                "type": text("work item type (default: Task; e.g. Bug, User Story)"),
                "body": text("description: what and why, repro steps for a bug"),
                "parent": id("parent work item id"),
                "assignee": text("assignee, or \"me\""),
                "at": text("file:line to link as \"Found in\" at the current commit"),
                "link": flag("also link it to the checked-out branch"),
                "team": text("team to take area and sprint from"),
                "area": text("area path"),
                "iteration": text("iteration path"),
            }),
            required: &["title"],
            command: |a| Ok(("wi.create", same(a))),
        },
        Tool {
            name: "link_work_items",
            description: "Record which work items the checked-out branch is for — do this before create_pull_request, or the PR opens with no work item attached. Create and switch branches with git yourself; this never does. `remove: true` unlinks instead.",
            properties: json!({ "ids": ids("work item ids"), "remove": flag("unlink these instead") }),
            required: &["ids"],
            command: |a| Ok((if a.get("remove") == Some(&json!(true)) { "unlink" } else { "link" }, same(a))),
        },
        Tool {
            name: "create_pull_request",
            description: "Open a PR from the checked-out branch (push it first). Links the branch's work items; targets the repo's default branch. Completing the PR moves those work items on — don't change their state yourself.",
            properties: json!({
                "title": text("title (default: the last commit's subject)"),
                "body": text("description, markdown; any length"),
                "target": text("branch to merge into"),
                "draft": flag("open as a draft"),
                "workItems": ids("work item ids, instead of the linked ones"),
            }),
            required: &[],
            command: |a| Ok(("pr.create", same(a))),
        },
        Tool {
            name: "review_thread",
            description: "Act on PR review threads. thread + nothing else: read every comment in it. thread + text: reply (add status \"resolved\" to resolve it in the same step). thread + status: just set the status. text without thread: start a new thread.",
            properties: json!({
                "pr": id("PR id or link"),
                "thread": id("thread id, as listed by status or view"),
                "text": text("comment text, markdown"),
                "status": { "type": "string", "enum": ["resolved", "active", "wontfix", "closed", "pending"], "description": "set the thread to this" },
            }),
            required: &["pr"],
            command: |a| {
                let has = |key: &str| a.get(key).is_some_and(|v| !v.is_null() && v != "");
                let params = json!({ "pr": a.get("pr"), "thread": a.get("thread"), "text": a.get("text") });
                Ok(match (has("thread"), has("text"), has("status")) {
                    (false, false, _) => return Err(Error::user("Pass text to start a thread, or a thread to act on.")),
                    (false, true, _) => ("pr.comment", params),
                    (true, true, _) => ("pr.reply", json!({ "pr": a.get("pr"), "thread": a.get("thread"), "text": a.get("text"), "resolve": a.get("status") })),
                    (true, false, true) => ("pr.resolve", json!({ "pr": a.get("pr"), "thread": a.get("thread"), "status": a.get("status") })),
                    (true, false, false) => ("pr.thread", params),
                })
            },
        },
        Tool {
            name: "pipeline_log",
            description: "Why a pipeline run failed: the log of its first failed task (or all of them). Default: the checked-out branch's latest run.",
            properties: json!({ "run": id("run id"), "branch": text("latest run of this branch instead"), "task": text("this failed task"), "all": flag("every failed task") }),
            required: &[],
            command: |a| Ok(("pipeline.log", same(a))),
        },
        Tool {
            name: "azure_devops_api",
            description: "Any Azure DevOps REST call, signed in, for what the other tools don't cover. A path starting with \"/\" is org-relative (/_apis/projects); otherwise project-relative (_apis/git/repositories). api-version 7.1 is added.",
            properties: json!({ "path": text("REST path, or a full https://dev.azure.com URL"), "method": text("GET (default), POST, PATCH, PUT, DELETE"), "body": text("request body (JSON text)"), "contentType": text("default application/json") }),
            required: &["path"],
            command: |a| Ok(("api", same(a))),
        },
    ]
}

/// Every tool can be pointed at a repo or an org/project; the server's own cwd isn't necessarily the agent's.
const SCOPE: [(&str, &str); 3] = [
    ("cwd", "the git repo to act in (default: the server's working directory)"),
    ("org", "organization, outside an Azure Repos clone"),
    ("project", "project, outside an Azure Repos clone"),
];

fn tool_list() -> Value {
    let listed = |tool: &Tool| {
        let mut properties = tool.properties.clone();
        for (name, description) in SCOPE {
            properties[name] = text(description);
        }
        let mut schema = json!({ "type": "object", "properties": properties });
        if !tool.required.is_empty() {
            schema["required"] = json!(tool.required);
        }
        json!({ "name": tool.name, "description": tool.description, "inputSchema": schema })
    };
    Value::Array(tools().iter().map(listed).collect())
}

const INSTRUCTIONS: &str =
    "dova is Azure DevOps for the repo you are in: work items, pull requests, pipelines. Start with `status`. \
Before create_pull_request, run link_work_items for the branch. Never change a work item's state or assignee yourself. \
If a tool reports exitCode 3, the user needs to sign in (`az login`) — tell them; never sign in for them.";

const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

fn call_tool(invoker: &Invoker, params: &Params) -> Result<Value, RpcError> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let tool = tools()
        .into_iter()
        .find(|t| t.name == name)
        .ok_or_else(|| RpcError::new(-32602, format!("Unknown tool \"{name}\".")))?;
    let none = Map::new();
    let arguments = params.get("arguments").and_then(Value::as_object).unwrap_or(&none);
    let run = || -> Result<Value, RpcError> {
        let (command, mut params) = (tool.command)(arguments)?;
        // Where to act travels with every call, whatever the tool passes on.
        for (key, _) in SCOPE {
            if let Some(value) = arguments.get(key) {
                params[key] = value.clone();
            }
        }
        invoker.invoke(command, params.as_object().unwrap_or(&none))
    };
    Ok(match run() {
        Ok(Value::String(text)) => json!({ "content": [{ "type": "text", "text": text }] }),
        Ok(result) => json!({ "content": [{ "type": "text", "text": result.to_string() }] }),
        // A failed call is a result the agent reads, not a protocol error.
        Err(err) => {
            let mut failure = json!({ "error": err.message });
            if let (Some(failure), Some(Value::Object(data))) = (failure.as_object_mut(), err.data) {
                failure.extend(data);
            }
            json!({ "isError": true, "content": [{ "type": "text", "text": failure.to_string() }] })
        }
    })
}

/// One MCP message: `notification` is true for the ones that want no answer.
pub fn handle(invoker: &Invoker, method: &str, params: &Params, notification: bool) -> Result<Value, RpcError> {
    match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).filter(|v| VERSIONS.contains(v));
            Ok(json!({
                "protocolVersion": asked.unwrap_or(VERSIONS[0]),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "dova", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_list() })),
        "tools/call" => call_tool(invoker, params),
        // notifications/initialized and friends
        _ if notification => Ok(Value::Null),
        other => Err(RpcError::new(-32601, format!("Method not found: {other}"))),
    }
}

pub fn serve_stdio(app: &App) -> Result<Output> {
    let invoker = stdio_invoker(app);
    serve_lines(std::io::stdin().lock(), std::io::stdout(), |method, params, notification| {
        handle(&invoker, method, params, notification)
    });
    Ok(Output::none())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::testing::{batch, ok, rest_pr, wi, Bed, Recorded, Route};

    fn mcp(messages: &[Value], route: Route) -> (Vec<Value>, Bed) {
        let bed = Bed::new(route);
        let invoker = bed.invoker();
        let input: String = messages.iter().map(|m| m.to_string() + "\n").collect();
        let mut output = Vec::new();
        serve_lines(input.as_bytes(), &mut output, |method, params, notification| {
            handle(&invoker, method, params, notification)
        });
        (String::from_utf8(output).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect(), bed)
    }

    fn call(id: u64, name: &str, arguments: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": arguments } })
    }

    fn result_of(reply: &Value) -> Value {
        serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn handshakes_and_lists_ten_tools_with_schemas() {
        let (replies, _) = mcp(
            &[
                json!({ "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } }),
                json!({ "method": "notifications/initialized" }),
                json!({ "id": 2, "method": "tools/list" }),
            ],
            Box::new(|_| None),
        );
        assert_eq!(replies.len(), 2, "the notification gets no reply");
        let by_id = |id: u64| replies.iter().find(|r| r["id"] == id).unwrap()["result"].clone();
        assert_eq!(
            (&by_id(1)["protocolVersion"], &by_id(1)["capabilities"], &by_id(1)["serverInfo"]["name"]),
            (&json!("2025-03-26"), &json!({ "tools": {} }), &json!("dova"))
        );
        let tools = by_id(2)["tools"].as_array().unwrap().clone();
        assert_eq!(tools.len(), 10);
        let view = tools.iter().find(|t| t["name"] == "view").unwrap()["inputSchema"].clone();
        assert_eq!((&view["type"], &view["required"]), (&json!("object"), &json!(["id"])));
        assert!(view["properties"]["id"].is_object() && view["properties"]["cwd"].is_object());
    }

    #[test]
    fn every_tool_maps_onto_a_real_command_with_real_params() {
        let methods = crate::rpc::methods();
        for tool in tools() {
            let mut arguments = Map::new();
            for key in tool.properties.as_object().unwrap().keys() {
                arguments.insert(key.clone(), json!("x"));
            }
            let (command, params) = (tool.command)(&arguments).unwrap();
            let method = methods
                .iter()
                .find(|m| m.name == command)
                .unwrap_or_else(|| panic!("{} maps to unknown command {command}", tool.name));
            for key in params.as_object().unwrap().keys().filter(|key| *key != "remove") {
                let known =
                    method.options.contains(key) || method.args.iter().any(|arg| arg.trim_end_matches('…') == key);
                assert!(known, "{}: {command} has no param {key}", tool.name);
            }
        }
    }

    #[test]
    fn returns_a_tool_result_as_json_text() {
        let route: Route = Box::new(|r: &Recorded| {
            if r.path.ends_with("/wiql") {
                ok(json!({ "workItems": [] }))
            } else {
                batch(vec![wi(4821, json!({}))])(r)
            }
        });
        let (replies, _) = mcp(&[call(1, "view", json!({ "id": 4821 }))], route);
        let result = result_of(&replies[0]);
        assert_eq!((&result["kind"], &result["id"]), (&json!("work-item"), &json!(4821)));
    }

    #[test]
    fn review_thread_replies_and_resolves_in_one_call() {
        let route: Route = Box::new(|r: &Recorded| match r.method.as_str() {
            "GET" if r.path.ends_with("/pullrequests/7") => ok(rest_pr(7, json!({}))),
            "GET" if r.path.ends_with("/threads/3") => {
                ok(json!({ "id": 3, "comments": [{ "id": 5, "content": "x" }] }))
            }
            "POST" => ok(json!({ "id": 6 })),
            "PATCH" => ok(json!({})),
            _ => None,
        });
        let (replies, bed) = mcp(
            &[call(
                1,
                "review_thread",
                json!({ "pr": 7, "thread": 3, "text": "Fixed `$x` in 9f2c", "status": "resolved" }),
            )],
            route,
        );
        assert_eq!(result_of(&replies[0]), json!({ "prId": 7, "threadId": 3, "status": "fixed" }));
        let requests = bed.ado.requests();
        let posted = &requests.iter().find(|r| r.method == "POST").unwrap().body;
        assert_eq!((&posted["content"], &posted["parentCommentId"]), (&json!("Fixed `$x` in 9f2c"), &json!(5)));
        assert_eq!(requests.iter().find(|r| r.method == "PATCH").unwrap().body, json!({ "status": "fixed" }));
    }

    #[test]
    fn reports_a_failed_call_as_a_result_the_agent_can_read_with_dovas_error_kind() {
        let route: Route =
            Box::new(|r| if r.path.ends_with("workitemsbatch") { ok(json!({ "value": [null] })) } else { None });
        let (replies, _) = mcp(
            &[
                call(1, "view", json!({ "id": 9 })),
                call(2, "nope", json!({})),
                call(3, "review_thread", json!({ "pr": 1 })),
            ],
            route,
        );
        let reply = |id: u64| replies.iter().find(|r| r["id"] == id).unwrap().clone();
        assert_eq!(reply(1)["result"]["isError"], true);
        let failure = result_of(&reply(1));
        assert_eq!((&failure["kind"], &failure["exitCode"]), (&json!("not_found"), &json!(2)));
        assert_eq!(reply(2)["error"]["code"], -32602);
        assert_eq!(result_of(&reply(3))["error"], "Pass text to start a thread, or a thread to act on.");
    }
}
