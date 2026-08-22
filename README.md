# dova

`dova` brings Azure DevOps to the command line the way `gh` and `glab`
do for GitHub and GitLab: work items, pull requests, and pipelines,
without leaving the terminal, and without typing your org and project
name into every invocation.

It is not a new API client. Underneath, every operation is either a
`git` command or an `az` call (Azure CLI's `azure-devops` extension) —
`dova` is the layer that knows which one to run and with which
arguments, given nothing but the repo you're standing in.

## Install

```sh
git clone <this-repo> && cd dova
npm install && npm run build
npm link
```

Needs Node 20+, `az` with `az extension add --name azure-devops`, and
an existing `az login` session. `dova` reads your Azure CLI credentials
and config; it doesn't manage its own.

## Example

```sh
cd my-azure-repo

dova bug "Login redirects to the wrong page" --at src/auth.ts:42
#  -> files a Bug, area/iteration resolved from this repo's saved team

git checkout -b fix/login-redirect
dova link 4821
#  -> records that this branch is about #4821 (dova never touches git branches itself)

# ...make the fix, commit...

dova pr create
#  -> opens the PR, #4821 attached automatically

dova pipeline log
#  -> if CI is red, shows the failing task's log directly
```

## Why the org/project/team are never typed

Everything `dova` needs to talk to Azure DevOps is already sitting in
your repo:

- **org, project, repo** come from `git remote get-url origin` — parsed
  for both `dev.azure.com/{org}/{project}/_git/{repo}` and the legacy
  `{org}.visualstudio.com` form, HTTPS or SSH.
- **team** (needed only when *filing* a new work item, to resolve an
  area path and iteration) is asked once, the first time it's needed,
  and then remembered in that repo's own git config
  (`dova.team`/`dova.area`/`dova.iteration`) — no separate cache, no
  server-side state.

`--org`, `--project`, `--repo`, and `--team` all exist as overrides for
the cases where inference gets it wrong or there's no repo to infer
from, but the common path needs none of them.

## What `dova` does *not* do

It does not create, name, or check out git branches, transition a work
item's state, or manage assignment. Those stay exactly what they
already are: things a developer or an agent does with `git` and Azure
Boards directly, using whatever convention they already have.

The one thing `dova` adds on top of being an `az` proxy is *linkage* —
recording which branch corresponds to which work item, since neither
git nor Azure DevOps tracks that on its own. `dova link <id>` writes it
(to that branch's own git config, so it travels with no server call);
`dova pr create` reads it back out to attach the ticket automatically;
`dova list`/`dova summarize` make it queryable later, when someone says
"we forgot to finish that thing" without naming a branch.

## Commands

**Status & discovery**
- `status` — active PR, linked work items, recent pipeline runs, and comment threads for the current branch, in one call.
- `list` — every branch with a linked ticket, most recently active first.
- `summarize <branch>` — a catch-up report for one branch: its tickets' descriptions, commit log, and diff stat since it diverged.
- `view <id|url>` — read a work item or PR from a bare id or a pasted link; detects which.

**Work items**
- `bug <title>` — file a Bug fast (`--at file:line` for a permalink, `--link` to link it in the same call).
- `wi quick <type> <title>` — `bug`, for any work item type.
- `wi create` — the full create command (`--assign-to`, `--parent`).
- `wi view <id|url>` — a work item plus its parent and children.
- `wi search` — flag-driven search.

**Pull requests**
- `pr create` — opens a PR, auto-attaching whatever `dova link` recorded.
- `pr view [id|url]` — a PR's detail, including comment threads.
- `pr comment <id> <text>` / `comment reply` / `comment resolve` — post, reply, or change a thread's status.

**Pipelines**
- `pipeline status` — recent runs for a branch.
- `pipeline watch [run-id]` — poll until a run finishes; exits non-zero on failure.
- `pipeline log [run-id]` — the failing task's actual log, not just "it failed."

**Linking**
- `link <id...>` — associate the current branch with one or more work items.

**Everything else**
- `api <path>` — an authenticated REST call, for anything not wrapped above.
- `completion <bash|zsh|fish|powershell>` — shell completions, generated from the live command tree.

Every read command supports `--json [fields]` and `--jq <expr>`
(mirroring `gh`), and `--web` where opening a browser makes sense.
`--no-color` / `$NO_COLOR` are respected everywhere.

## Notes for anyone extending this

**`az`'s command coverage has real gaps**, filled with direct `az rest`
calls against the REST API: PR comment threads, work item type/state
metadata, and pipeline run timelines/logs all have no native `az`
command at all (confirmed by reading the `azure-devops-cli-extension`
source's `commands.py` files — the ground-truth list of what each
command group actually registers, since this isn't always obvious from
`--help` or the docs). If you hit an `az` command whose JSON shape
isn't documented, that source is more reliable than guessing from table
output.

**Every `az` call goes through `runAzJson()`** in `src/lib/exec.ts`,
which appends `--output json` and parses it — nothing here scrapes
table-formatted output. Every command's logic takes a `Runner`
interface rather than importing `execa` directly, so tests substitute
an in-memory fake instead of mocking modules.

**No org-specific value is hardcoded** anywhere — not in source, not in
examples, not in tests. Fixtures use `contoso`/`MyProject`/`my-repo` as
placeholders throughout.

```
src/
  cli.ts / index.ts     command tree + entrypoint
  commands/              one file per command
  lib/
    exec.ts              the only place that shells out to az/git
    context.ts            org/project/repo/branch resolution
    team-resolver.ts      team/area/iteration resolution
    config.ts              git-config + az devops's own config file
    link.ts                 dova link's implementation
    work-items.ts / work-item-types.ts / wiql.ts / pr.ts / pipelines.ts
                             fetch/render logic per Azure DevOps entity, shared across commands
    urls.ts                  work item / PR link parsing
    output.ts                 --json / --jq / color / table rendering
  types/azure-devops.ts   minimal REST object shapes
tests/                    one *.test.ts per lib module, fully mocked — no real az/git ever runs
```

## Development

```sh
npm run dev -- status   # run from source via tsx
npm test                 # vitest
npm run typecheck         # tsc --noEmit
npm run build              # bundle to dist/index.js
```

## Not built

`dova tui`, `dova stats` (cycle time/PR turnaround reporting), an
extension system, a local read cache, and any push-notification
feature — Azure DevOps webhooks can't target a developer's laptop, and
a polling loop isn't a substitute worth building.
