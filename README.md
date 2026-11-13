# dova

Azure DevOps from the terminal — work items, pull requests and pipelines for the repo you're in, the way `gh` does it for GitHub. Org, project and repo come from your git remote; there's nothing to configure.

```console
$ dova view 4821                      # read the ticket
$ git checkout -b fix/4821-login
$ dova link 4821                      # this branch is for #4821
  … work, commit …
$ dova pr create --title 'Fix login redirect' --body - < notes.md
$ dova status                         # PR, work items, CI, review threads
$ dova pr reply 612 3 'Fixed in 9f2c' --resolve
$ dova pipeline log                   # why CI failed
```

## Install

dova is one executable. It needs git and the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli): you sign in with `az login`, once — and if you haven't, the first `dova` command runs it for you.

**Windows** — download `dova-<version>-x64.msi` from [Releases](https://github.com/maxjay/dova/releases) and run it. It installs for your user (no administrator needed) and puts `dova` on your PATH; open a new terminal afterwards.

**Ubuntu, Debian, WSL** — download `dova_<version>-1_amd64.deb` from Releases, then:

```sh
sudo apt install ./dova_*_amd64.deb
```

Inside WSL dova uses the `az` and `git` installed in WSL, not the Windows ones.

**From source** — with [Rust](https://rustup.rs): `cargo install --path .`

Tab completion comes with the `.deb` for bash, zsh and fish. Anywhere else, `dova completion <shell>` prints the script — for PowerShell, add this to your `$PROFILE`:

```powershell
dova completion powershell | Out-String | Invoke-Expression
```

## Commands

| | |
|---|---|
| `dova status` | the current branch: its PR, work items, latest runs, review threads |
| `dova summarize [branch\|pr]` | catch up: linked tickets, commits and diff since it diverged (`--files`, `--full`) |
| `dova view <id\|link>` | a work item or a PR |
| `dova link <ids…>` / `unlink` / `list` | record which work items a branch is for; `pr create` links them |
| `dova wi view\|search\|create` | work items; `create` files into the team's default area and current sprint |
| `dova bug <title>` | `wi create --type Bug` (`--at file:line` adds a permalink, `--link` links it) |
| `dova pr create\|view` | open a PR from the branch (target and work items worked out), or read one with its threads |
| `dova pr comment\|thread\|reply\|resolve` | review threads |
| `dova pipeline list\|log\|watch` | runs for the branch, the failed task's log, follow a run |
| `dova api <path>` | any REST call, signed in |
| `dova mcp` · `dova rpc` | an MCP server for AI agents · every command as JSON-RPC, for other tools |
| `dova auth status` · `dova daemon status\|stop` | who you're signed in as · the background process |
| `dova instructions [--in-repo]` | teach coding agents (Copilot, Windsurf/Devin, Cursor, Codex) to use dova |
| `dova completion <shell>` | bash, zsh, fish, powershell |

Every command takes `--json`, or `--jq <expr>` for just the part you want, and `--org`/`--project`/`--repo` (or `$DOVA_ORG`/`$DOVA_PROJECT`) outside an Azure Repos clone. Commands that show one thing take `--web` to open it in the browser instead. Free text can be piped in with `-`; stdin is read only when a command is given `-`. Exit codes: `1` bad input, `2` not found, `3` not signed in or no access, `4` a request failed.

`dova link` records exactly the ids you give it, and `dova pr create` attaches exactly what's recorded (or `--work-items`). New work items go to the repo's team: the project's only team, or the one you pick the first time, which is then remembered. Its current sprint is looked up each time, so nothing is filed into last month's.

Without a terminal — an agent, CI, the end of a pipe — dova never prompts: it fails at once, naming the flag that answers the question and the values to choose from. `--no-input` or `DOVA_NO_INPUT=1` force that.

## For AI agents: `dova mcp`

`dova mcp` is an MCP server over stdio. Register it with your agent as the command `dova mcp`. It exposes ten tools shaped around what an agent does rather than one per command — `status`, `view`, `summarize`, `search_work_items`, `create_work_item`, `link_work_items`, `create_pull_request`, `review_thread` (read, reply, resolve or start a thread in one tool), `pipeline_log`, `azure_devops_api` — with the workflow rules in their descriptions. Text goes in as JSON, so none of the shell-quoting rules apply. Every tool takes an optional `cwd` for the repo to act in.

## From other tools: `dova rpc`

`dova rpc` serves every command as a [JSON-RPC 2.0](https://www.jsonrpc.org/specification) method, one message per line on stdin/stdout — spawn it once and send requests. The method is the command path with dots; params are its arguments and flags by camelCased name, plus `cwd` (which repo to act in) and `org`/`project`/`repo`. Results are exactly what `--json` prints.

```console
$ dova rpc
→ {"jsonrpc":"2.0","id":1,"method":"wi.view","params":{"idOrUrl":"4821"}}
← {"jsonrpc":"2.0","id":1,"result":{"id":4821,"title":"Login redirects to the wrong page",…}}
→ {"jsonrpc":"2.0","id":2,"method":"api","params":{"path":"_apis/git/repositories","cwd":"/src/web"}}
→ {"jsonrpc":"2.0","id":3,"method":"rpc.methods"}
```

Requests run concurrently, through the same daemon and `az` sign-in as the CLI. Nothing prompts; text the CLI would read from stdin (`bug`'s title, `pr reply`'s text) is a param. Errors carry dova's kind in `error.data`: `{ kind, exitCode, hints }`, where `kind` is `user`, `not_found`, `prereq`, `not_signed_in`, `external` or `unexpected`.

## How it works

The first command starts **dovad**, a background process that stays up. It asks `az` for an Azure DevOps token once, keeps it in memory, and makes every REST request for the CLI over a user-only socket (a named pipe on Windows), on connections it keeps open — so a command costs its round trips: no Python start, no TLS handshake. A new `az login` is picked up on its own, an organization in another tenant gets a token for that tenant, and a newer dova replaces an older daemon. `DOVA_NO_DAEMON=1` does it all in-process instead.

Requests that don't depend on each other go out together: `dova status` is two rounds of three, not six in a row.

dova remembers two things, both in git config: `branch.<name>.dova-workitems`, the work items a branch is for, and `dova.team`, the team new work items go to. Who may talk to the daemon is left to the operating system: its socket sits in a directory only you can enter, and Windows opens its pipe for writing only to you.

## Development

```sh
cargo test                      # no az, no network: Azure DevOps and git are faked
cargo clippy --all-targets
cargo fmt
cargo run -- status
```

```
src/
  main.rs, cli.rs       entry; the command tree, --json/--jq/--web, output, exit codes
  commands/             one file per area: logic plus rendering
  app.rs                what every command gets: git, Azure DevOps, prompts, stdin, scope
  ado/                  client (typed REST calls), map (REST → types), auth (az token, session)
  daemon.rs             dovad: server, client, auto-start
  rpc.rs, mcp.rs        every command as JSON-RPC; ten tools for AI agents
  git.rs, urls.rs, text.rs, par.rs, error.rs
completions/            the shell shims `dova completion` prints, and the .deb installs
packaging/              the Windows installer
```

The command tree in `cli.rs` is the only list of commands: `--help`, shell completion, `rpc.methods` and `dova rpc` calls all read it, so a new command is a struct with a `run` and one line in that tree.

**Installers.** Pushing a tag like `v0.3.0` builds both and attaches them to a GitHub release (`.github/workflows/build.yml`); every other push builds them as workflow artifacts. Locally:

```sh
cargo install cargo-deb && cargo deb          # target/debian/dova_<version>-1_amd64.deb
```

```powershell
dotnet tool install --global wix --version 5.0.2
./packaging/build-msi.ps1                     # target\dova-<version>-x64.msi
```

## License

MIT
