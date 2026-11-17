# dova

**Azure DevOps from the terminal.** Work items, pull requests and pipelines for the repo you're in — like `gh`, for Azure DevOps. Nothing to configure: it reads your git remote.

```console
$ dova view 4821                  # read the ticket
$ git checkout -b fix/4821-login
$ dova link 4821                  # this branch is for #4821
$ dova pr create                  # opens the PR, ticket attached
$ dova status                     # PR, work items, CI, review threads
$ dova pipeline log               # why CI failed
```

One screen for the branch you're on:

```console
$ dova status
Branch: fix/4821-login

Pull Request
  #612 Fix login redirect
  active · Jane Doe · into main
  https://dev.azure.com/contoso/MyProject/_git/web/pullrequest/612

Work Items
┌───────┬──────┬───────────────────────────────────────────┬────────┐
│ ID    │ Type │ Title                                     │ State  │
├───────┼──────┼───────────────────────────────────────────┼────────┤
│ #4821 │ Bug  │ Login redirects to the wrong page         │ Active │
│ #5219 │ Bug  │ Null check missing on empty session token │ New    │
└───────┴──────┴───────────────────────────────────────────┴────────┘

Pipeline Runs
┌──────────┬───────────┬──────────────────────┬─────────────────────────────────────────────────────────────────────┐
│ Pipeline │ Result    │ Queued               │ URL                                                                 │
├──────────┼───────────┼──────────────────────┼─────────────────────────────────────────────────────────────────────┤
│ CI       │ failed    │ 2026-08-22T10:02:11Z │ https://dev.azure.com/contoso/MyProject/_build/results?buildId=4102 │
│ CI       │ succeeded │ 2026-08-22T10:02:11Z │ https://dev.azure.com/contoso/MyProject/_build/results?buildId=4098 │
└──────────┴───────────┴──────────────────────┴─────────────────────────────────────────────────────────────────────┘

Threads (1 open, 1 resolved)

#4  open  /src/auth.ts:42  Jane Doe
  Can you also handle the null case here?
  … 1 earlier — dova pr thread 612 4

#7  resolved  (general)  Sam Lee
  Nice catch.
```

And nothing to spell out. The same pull request, with the Azure CLI and with dova:

```sh
az repos pr create --organization https://dev.azure.com/contoso --project MyProject \
  --repository web --source-branch fix/4821-login --target-branch main \
  --title 'Fix login redirect' --work-items 4821
```

```sh
dova pr create
```

## Install

| | |
|---|---|
| **Windows** | run [dova.maxjay.dev/dova.msi](https://dova.maxjay.dev/dova.msi) (no admin needed) |
| **Ubuntu, Debian, WSL** | `curl -LO https://dova.maxjay.dev/dova.deb && sudo apt install ./dova.deb` |
| **From source** | `cargo install --git https://github.com/maxjay/dova` |

Both links are the latest release. Older versions are on [Releases](https://github.com/maxjay/dova/releases).

Needs git and the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli). Sign in once with `az login`.

## Commands

| | |
|---|---|
| `dova status` | the current branch: PR, work items, pipeline runs, review threads |
| `dova view <id\|link>` | a work item or a PR |
| `dova summarize [branch\|pr]` | catch up: tickets, commits, diff |
| `dova link <ids…>` · `unlink` · `list` | which work items a branch is for |
| `dova wi view\|search\|create\|edit\|comment` · `dova bug <title>` | work items |
| `dova pr create\|view\|edit` | pull requests |
| `dova pr list` | the pull requests you opened, with their checks and open threads |
| `dova pr comment\|thread\|reply\|amend\|resolve` | review threads |
| `dova pipeline list\|log\|watch` | pipeline runs |
| `dova api <path>` | any REST call, signed in |

`dova <command> --help` has the rest.

## Good to know

- **Scriptable.** `--json` on every command, `--jq <expr>` for just the part you want.
- **Never hangs.** Without a terminal it doesn't prompt: it fails and names the flag to pass.
- **Safe with text.** Pass `-` and pipe the text in; the shell never touches it.
- **Pictures.** `![the new screen](shot.png)` in a PR description or comment uploads the file and shows it.
- **Fast.** A background process holds your sign-in and one open connection (HTTP/2) that every command shares. `DOVA_NO_DAEMON=1` turns it off.
- **Exit codes.** `1` bad input · `2` not found · `3` not signed in or no access · `4` a request failed.
- **Tab completion.** Included in the `.deb`; elsewhere, `dova completion <shell>`.

## For agents and tools

| | |
|---|---|
| `dova mcp` | an MCP server: twelve tools for AI agents |
| `dova rpc` | every command as JSON-RPC over stdio (`rpc.methods` lists them) |
| `dova instructions` | teaches Copilot, Windsurf, Cursor and Codex to use dova |

## Development

```sh
cargo test        # no az, no network: Azure DevOps and git are faked
cargo run -- status
```

Pushing a tag like `v0.3.0` builds the `.msi` and `.deb` and publishes them as a release. Locally: `cargo deb`, or `./packaging/build-msi.ps1`.

The page at [dova.maxjay.dev](https://dova.maxjay.dev) is `site/public/index.html`. A release publishes it with that release's installers beside it, as `dova.msi` and `dova.deb`.

MIT licensed.
