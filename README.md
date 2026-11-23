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

To work across projects outside a checkout, run `dova config set org <name>` once.
Dova looks up the organization's GUID and saves it with the name. Both the CLI and
`dova rpc` use that default. An Azure link, an explicit org, `DOVA_ORG`, or an
Azure Repos remote takes precedence, in that order. For example, `dova pr view 9`
and `dova wi view 4` can then run by ID. Project-scoped commands accept `--project`.

`dova config get org --json` shows the saved name and GUID offline. The file is
`$XDG_CONFIG_HOME/dova/config.json` (normally `~/.config/dova/config.json`) on Linux
and `%APPDATA%\dova\config.json` on Windows. Setting `DOVA_HOME` places `config.json`
in that directory instead.

Dova saves your Azure DevOps user ID in `user-id-<org>.json` beside `config.json`
during organization setup or the first identity lookup. `pr list` reuses that ID.

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
| `dova pr list --review` | the ones you or a team of yours were asked to review, with your vote |
| `dova pr diff` | what a pull request changes, file by file, without a clone of its repo |
| `dova pr comment\|thread\|reply\|amend\|resolve` | review threads; `comment --at path:line` puts one on lines of a changed file |
| `dova pipeline list\|log\|watch` | pipeline runs |
| `dova api <path>` | any REST call, signed in |

`dova <command> --help` has the rest.

## Good to know

- **Scriptable.** `--json` on every command, `--jq <expr>` for just the part you want.
- **Pictures that load.** An image in a description or comment is a link that only works signed in. `--inline-images` puts the image itself in the JSON (a `data:` URL), for a tool that shows it; over rpc, `inlineImages: true` on any method.
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

### Live PRs and work items over RPC

Keep one `dova rpc` process open and read newline-delimited JSON from stdout.
To open PR #9 in your default organization, send:

```json
{"jsonrpc":"2.0","id":1,"method":"pr.open","params":{"id":9}}
```

The result contains a `subscription` string and a `snapshot` with eight sections:
`details`, `reviewers`, `discussion`, `checks`, `statuses`, `labels`, `workItems`,
and `files`. Each discussion thread includes its comments and current location.
`files` includes the pinned iteration and all changed paths. Use `pr.diff` with
`pr` and `files` to read file contents on demand.

Dova subscribes to the Azure Repos PR detail hub before loading the snapshot.
The open reply arrives before any notifications for that subscription. Route
replies by request ID and notifications by subscription ID. For example:

```json
{"jsonrpc":"2.0","method":"pr.changed","params":{"subscription":"s1","sections":["discussion"]}}
{"jsonrpc":"2.0","id":2,"method":"pr.read","params":{"subscription":"s1","sections":["discussion"]}}
```

The first line comes from Dova. The second is the app's request. Replace the named
sections with the values in the result. A change signal can cover several edits.
Keep at most one refresh in flight per view and merge any further signals until it
finishes. Idle views use hub keepalives and issue no periodic data reads.

On `pr.disconnected`, mark the view stale. Dova reconnects with backoff and sends
`pr.resynced` with a fresh `params.snapshot`. Discard outstanding reads from before
the disconnect. If the RPC process exits, start a new session and reopen the PR.
Send `pr.close` with the subscription ID when finished, or close stdin to release
all subscriptions. Each PR subscription watches one PR. Linked tickets are snapshots
of their references at read time.

Use the same lifecycle for a work item. For example, send
`{"jsonrpc":"2.0","id":1,"method":"wi.open","params":{"id":3}}`.
The snapshot contains `details` (including the revision and all Azure fields),
`relations` (including attachment and artifact links), and `comments` in
chronological order with reactions. Same-organization work item links carry
`workItemId` and a `workItem` summary with ID, title, type, and state when
accessible. Dova resolves up to 200 linked IDs per batch. Open a related
ticket separately to watch its own changes.

`wi.changed` names the sections to refresh through `wi.read`. A reaction
invalidates comments, a link-only event invalidates details and relations,
and a generic Azure revision can affect all three sections. On `wi.disconnected`
mark the view stale. After reconnection,
`wi.resynced` contains a new snapshot. Use `wi.close` to release the view.
Saved organization IDs avoid the organization lookup on open.

Live views use the Azure DevOps Services portal hub and PR detail provider.
A failed initial subscription or snapshot returns an RPC error. Ordinary
`pr.view` and `pr.diff` also support the REST read path.

## Development

```sh
cargo test        # no az, no network: Azure DevOps and git are faked
cargo run -- status
```

Pushing a tag like `v0.3.0` builds the `.msi` and `.deb` and publishes them as a release. Locally: `cargo deb`, or `./packaging/build-msi.ps1`.

The page at [dova.maxjay.dev](https://dova.maxjay.dev) is `site/public/index.html`. A release publishes it with that release's installers beside it, as `dova.msi` and `dova.deb`.

MIT licensed.
