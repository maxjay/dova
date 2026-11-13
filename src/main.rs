//! dova: Azure DevOps from the terminal.
//!
//!   main.rs, cli.rs     entry; the command tree, --json/--jq/--web, output, exit codes
//!   commands/           one file per area: logic plus rendering
//!   app.rs              what every command gets: git, Azure DevOps, prompts, stdin, scope
//!   ado/                client (typed REST calls), map (REST → types), auth (az token, session)
//!   daemon.rs           dovad: server, client, auto-start
//!   rpc.rs, mcp.rs      every command as JSON-RPC; ten tools for AI agents
//!   git.rs, urls.rs, text.rs, par.rs, error.rs
//!                       git and branch links; URL parsing; terminal text; parallel calls; errors

mod ado;
mod app;
mod cli;
mod commands;
mod daemon;
mod error;
mod git;
mod mcp;
mod par;
mod rpc;
#[cfg(test)]
mod testing;
mod text;
mod urls;

use std::io::Write;

use app::{App, Env, Options};
use text::Style;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let env = Env::process();
    let done = cli::run(&args, &env, |global| {
        let interactive = global.interactive(&env);
        App::new(Options {
            env: env.clone(),
            interactive,
            flags: global.scope(),
            style: Style::detect(global.colors_off(&env)),
            cwd: None,
            transport: daemon::transport(&env, interactive),
            read_stdin: Box::new(app::process_stdin),
        })
    });
    // A closed pipe (`dova … | head`) is not an error worth reporting.
    let _ = std::io::stdout().write_all(done.stdout.as_bytes());
    let _ = std::io::stderr().write_all(done.stderr.as_bytes());
    std::process::exit(done.code);
}
