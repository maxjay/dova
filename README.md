# dova

A `gh`/`glab`-style command-line tool for Azure DevOps. `dova` wraps
`az` (with the `azure-devops` extension) and `git`, resolving
organization, project, repo, branch, and team from the directory
you're standing in — so day-to-day commands don't need `--org`,
`--project`, or `--team` on every call. No organization name, project
name, team name, or process-specific type/state name is hardcoded
anywhere in the source: everything is inferred from the current git
remote, `az`'s own config, or the work item data itself.

## Install

```sh
git clone <this-repo>
cd dova
npm install
npm run build
npm link          # or: npm install -g .
```

Requires Node 20+, `az` with the `azure-devops` extension
(`az extension add --name azure-devops`), and a `git` remote pointed at
an Azure Repos repo. `az login` needs to have run once already — dova
never handles authentication itself.

## Quick start

```sh
cd my-azure-repo               # any repo with an Azure Repos remote
dova status                    # active PR, linked work items, recent pipeline runs, comment threads
dova bug "Login redirects to the wrong page" --at src/auth.ts:42
git checkout -b fix/login-redirect
dova link 4821                 # record that this branch is about ticket #4821
# ...do the work...
dova pr create                 # opens the PR, auto-linked to #4821
```

## Commands

| Command | What it does |
|---|---|
| `dova status` | Current branch: active PR, linked work items, recent pipeline runs, comment threads — one screen. |
| `dova link <id...>` | Associates the branch you're already on with one or more work items, so `pr create` links them automatically. See [Linkage, not workflow](#linkage-not-workflow). |
| `dova list` | Every local branch with a link, most recently active first. See [Finding a branch again](#finding-a-branch-again). |
| `dova summarize <branch>` | Catch-up report for one branch: linked tickets' descriptions, commit log, diff stat. |
| `dova bug <title>` | Quickly file a Bug. `--at file:line` attaches a permalink; `--link` chains into `dova link`. |
| `dova wi quick <type> <title>` | Same as `bug`, for any work item type. |
| `dova wi create` | The fuller create command — `--assign-to`, `--parent`. |
| `dova wi view <id\|url>` | A work item's detail, including its parent and children. |
| `dova wi search` | Search work items by flags, built into a WIQL query. |
| `dova view <id\|url>` | Generic read: a work item or a PR, from a bare id or a link — auto-detects which. |
| `dova pr create` | Opens a PR; auto-attaches any work items linked via `dova link`. |
| `dova pr view [id\|url]` | A PR's detail, including its comment threads. |
| `dova pr comment <id> <text>` | Post a new comment thread. |
| `dova pr comment reply <id> <thread-id> <text>` | Reply within an existing thread. |
| `dova pr comment resolve <id> <thread-id> [status]` | Set a thread's status (`resolved` by default). |
| `dova pipeline status` | Recent pipeline runs for a branch. |
| `dova pipeline watch [run-id]` | Poll a run until it finishes; exits non-zero on failure. |
| `dova pipeline log [run-id]` | Why a run failed — the failed task's own log. See [Diagnosing a failed run](#diagnosing-a-failed-run). |
| `dova api <path>` | Raw authenticated REST call — the escape hatch for anything not wrapped. |
| `dova completion <shell>` | Generates a completion script for bash/zsh/fish/powershell. |

Every command supports `--json [fields]` and `--jq <expr>` for scripted
use (mirroring `gh`), `--no-color`/`$NO_COLOR`, and `--web` where a
browser view makes sense. `--org`/`--org-url`/`--project`/`--repo`
override context resolution on any command that needs it.

## Design

### Context resolution

Org/project/repo resolve in this order (`resolveContext()` in
`src/lib/context.ts`):

1. `--org`/`--org-url`/`--project`/`--repo` flags. `--org` and
   `--project` together are already a complete answer and short-circuit
   everything else.
2. `git remote get-url origin`, parsed for both the modern
   (`dev.azure.com/{org}/{project}/_git/{repo}`) and legacy
   (`{org}.visualstudio.com`) URL forms, HTTPS or SSH.
3. `az devops configure` defaults, read directly from its config file
   (`az devops configure --list` doesn't produce parseable JSON — see
   [az CLI notes](#az-cli-notes)).
4. A specific, actionable error. Never a silent guess.

### Area/iteration resolution

Filing a work item needs an area path and iteration, which needs a
team — `resolveCreateContext()` in `src/lib/team-resolver.ts` resolves
that chain, in order:

1. `--like <id>` — copies `--area`/`--iteration` straight off an
   existing work item (one call), bypassing team resolution entirely.
   `--team <name>` — resolves area/iteration for a named team instead.
   Both are one-off overrides for that call only.
2. Saved `dova.area`/`dova.iteration` (repo-local git config) — the
   common case once a repo has been used once: no prompts, one `az`
   call (the create itself).
3. `dova.team` (repo-local git config), or, the first time, an
   interactive picker over the project's teams — then area/iteration
   resolution for that team, saved for next time. `--like <id> --save`
   writes the same two keys directly.

`--reresolve` ignores every saved value. There is no global
(cross-repo) override for project or team: team is inherently
project-scoped, and a per-repo default covers the realistic case.

### Linkage, not workflow

`dova` does not manage git branches. Creating, naming, and checking out
a branch is git's job — the developer or agent already has their own
convention for it, before `dova` is ever invoked. `dova link` records
the one thing git and Azure DevOps have no shared concept of: that the
branch you're standing on corresponds to a given work item.

```sh
dova wi view 4821 --json          # read the ticket
git checkout -b fix/4821-redirect # create + check out the branch — git, not dova
dova link 4821                    # record the linkage
# ...work, commit...
dova pr create                    # reads the link back out, attaches #4821 automatically
```

`dova link` never creates a branch, never transitions a ticket's
state, and never touches assignment — none of those affect whether
`pr create` can find and attach the ticket. It's additive and
idempotent: linking a second id to an already-linked branch merges
into the existing set rather than overwriting it. If an id is already
linked to a *different* branch, it offers to check that branch out
instead of double-tracking the same work — navigation, not branch
lifecycle management.

An id with open children (an Epic, a Feature, or a Bug used as a
checklist) expands into a multi-select of them, driven by the ticket's
own `[System.Parent]` hierarchy rather than any team/backlog
configuration — the same principle behind never hardcoding work item
type or state names anywhere in this codebase.

### Finding a branch again

A common follow-on: "we forgot to do X for that Y thing," with no
branch name given. `dova link`'s git config already records the
branch-to-ticket mapping; `list` and `summarize` make it queryable,
cheapest option first.

**`dova list`** shows every linked branch, most recently active first.
It costs the same regardless of branch count: one combined
`git config --get-regexp` for every branch's `dova-workitems`/
`dova-primary` at once, one `git for-each-ref` for recency, and one
batched work item fetch for every linked id across every branch. Often
enough on its own — a branch named `fix/200-login-redirect` next to "we
forgot to fix the login redirect" doesn't need more.

**`dova summarize <branch>`** is a catch-up report for the branches
`list` alone doesn't resolve: the linked tickets' full descriptions
(the *why*), the commit log since the branch diverged from its base
(the *what happened* — often more distinctive for matching a vague
description than a diff would be), and a `diff --stat` (the *how big*).
Compact by default; `--full` shows full commit messages and the actual
diff. Neither `list` nor `summarize` checks a branch out or does any
matching itself — deciding whether a branch fits what was described is
the caller's judgment, not something dova computes.

The base `summarize` compares against resolves in order: `--base <ref>`
> the target branch of an active PR for this branch, when one exists >
the repo's default branch (from a local `origin/HEAD` symref, falling
back to one `az repos show` call if that's unset).

### Reading anything

`dova view`, `dova wi view`, and `dova pr view` each accept a bare id
or a link (`src/lib/urls.ts` parses both work item and PR URLs,
including the legacy `.visualstudio.com` host). A link's org/project
(and repo, for a PR) override context resolution, so pasting a link to
a different org than the one you're standing in just works.

`dova view` is the generic form: a link says unambiguously what kind of
thing it is; a bare id tries as a work item first, falling back to a
PR, since the two are separate id spaces.

Every work item view also resolves its immediate parent and children —
generic across every work item type, from the ticket's own
`[System.Parent]` field rather than any type-specific hierarchy
knowledge. This comes through in `--json` as `parent`/`children`
directly, so a script or an LLM can walk the hierarchy without a second
call per child just to get a title.

### Diagnosing a failed run

`dova status`/`dova pipeline status` show that a run failed, not why —
`az` itself has no timeline, job, or log command at all (the
`azure-devops` extension's `pipelines runs` group is only
`list`/`show`/`tag`/`artifact`). `dova pipeline log` goes through
`az rest` against the Build REST API directly:

1. `GET .../builds/{id}/timeline?api-version=7.1` — the full
   stage/job/task breakdown, one call.
2. `GET .../builds/{id}/logs/{logId}?api-version=7.1` — one call per
   task, plain text rather than JSON (`runAzRestText()` in
   `src/lib/exec.ts`).

A run can have several failed tasks — a failure cascades up through its
job and stage, and independent tasks can fail too. By default,
`dova pipeline log [run-id]` (most recent run for the current branch)
shows just the earliest failure, on the theory that the real root cause
is usually the first one and everything after is fallout. `--task
<name>` targets a specific task; `--all` shows every failed one.
Human output tails to the last 200 lines (`--full` for the whole log);
`--json` always carries the untruncated text.

## Architecture

```
src/
  index.ts            entrypoint: builds the program, maps thrown errors to exit codes
  cli.ts              assembles the full command tree (single source of truth for --help and completions)
  commands/           one file per command; each registers itself on a commander Command
  lib/
    exec.ts           the only place that shells out to az/git — everything else takes a Runner
    context.ts         org/project/repo/branch resolution
    team-resolver.ts   team/area/iteration resolution, incl. the --like/--save/--team overrides
    config.ts          git-config helpers + az devops's own config file
    output.ts           --json / --jq / color / table rendering
    command-helpers.ts   shared flag-group builders (--org/--project/--repo, --json, --jq, --web, --no-color)
    completions/         tree -> {bash,zsh,fish,powershell} script generators
    work-items.ts        fetch-by-id / batch-fetch-by-id / children / full detail+render, shared by wi/pr/link/view
    work-item-types.ts   state -> category (used to drop Completed/Removed children from link's expansion)
    wiql.ts                small WIQL builder (wi search, batch id fetch, link's + view's children query)
    pr.ts                  PR fetch/threads/comment/reply/resolve/full detail+render, shared by status + pr * + view
    pipelines.ts            pipeline run fetch + web URL + timeline/log fetch, shared by status + pipeline *
    quick-create.ts          shared guts of `dova bug` / `dova wi quick`
    link.ts                   `dova link`'s implementation
    urls.ts                    work item / PR link parsing, for "give dova a link or an id"
  types/azure-devops.ts  minimal REST object shapes (PR, WorkItem, Build, CommentThread, GitRepository)
tests/
  context.test.ts        parseAzureRepoRemoteUrl + resolveContext, fully mocked
  team-resolver.test.ts   resolveProject/resolveTeam/resolveAreaPath/resolveIterationPath/resolveCreateContext
  list.test.ts / summarize.test.ts
                          gatherLinkedBranches / resolveBase+resolveDiffableRef+gatherSummary
  wiql.test.ts / work-item-types.test.ts / api.test.ts / urls.test.ts / pr.test.ts / exec.test.ts / pipelines.test.ts
                          pure-logic unit tests for the modules above
  fixtures/               fabricated remote URLs + az JSON payloads (contoso/MyProject/my-repo placeholders — no real org anywhere)
```

Every `az` call goes through `runAzJson()` (`src/lib/exec.ts`), which
appends `--output json` and parses it — nothing scrapes table output.
Every command's real logic takes a `Runner` (the `git`/`az` process
interface) as a parameter rather than importing `execa` directly, so
tests substitute an in-memory fake instead of mocking modules.

### Stack

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript on Node 20+ | see [below](#why-typescript-not-a-compiled-binary) |
| CLI parsing | [commander](https://github.com/tj/commander.js) | Explicit, no generator step; nested subcommands map cleanly onto `dova wi create` style paths |
| Color | [chalk](https://github.com/chalk/chalk) | Respects `NO_COLOR` / non-TTY out of the box |
| Tables | [cli-table3](https://github.com/cli-table/cli-table3) | Real column alignment/wrapping |
| Interactive prompts | [@inquirer/prompts](https://github.com/SBoudrias/Inquirer.js) | Arrow-key select/confirm for the ambiguous-without-a-flag cases |
| Process execution | [execa](https://github.com/sindresorhus/execa) | Every `az`/`git` call goes through `src/lib/exec.ts`, the one seam tests fake |
| `--jq` | [jq-wasm](https://github.com/owenthereal/jq-wasm) | Real jq semantics with no external binary required |
| Browser opening | [open](https://github.com/sindresorhus/open) | Cross-platform `--web` |
| Build | [tsup](https://github.com/egoist/tsup) | Single ESM bundle with a shebang banner |
| Tests | [vitest](https://vitest.dev) | Fast, native TS |

### Why TypeScript, not a compiled binary

`gh`/`glab` ship as a single static Go binary because they're
distributed to every contributor on every OS with zero assumptions.
dova is an internal tool where the people running it are the people
building it, and already run `az` (a Python CLI) and `git` — a Node
runtime is the same class of five-minute install, not a new one. That
trade favors TypeScript: a real type system over the Azure DevOps REST
shapes, fast edit-test loops, no separate language to onboard a
contributor into. Distribution is still simple without a single binary
— `npm install -g` (or a private registry) is the realistic path for a
team that already runs `az`; a static binary via `pkg`/`nexe` is a
follow-on packaging step over the existing `tsup` bundle if it's ever
needed, not a rewrite.

### az CLI notes

Some `az`/REST shapes used here aren't fully documented on
learn.microsoft.com. Where that was true, the
[azure-devops-cli-extension](https://github.com/Azure/azure-devops-cli-extension)
source was read directly — its `commands.py` files give the ground-truth
mapping from `az` command names to implementation functions:

- `az devops configure --list` does not produce parseable JSON (its
  `list_config` path is a bare `print()`) — dova reads the extension's
  own INI config file directly instead (`azDevopsConfigFilePath()` in
  `lib/config.ts`).
- `az boards area team list` returns one `TeamFieldValues` object
  (`{ defaultValue, values }`), not a flattened list.
- `az boards iteration team list --timeframe current` is supported by
  the current extension — no fallback needed, since dova only targets
  `dev.azure.com`.
- `az repos pr work-item list` resolves and returns full `WorkItem`
  objects, not just refs, so status/pr-view don't need a second
  round-trip per item.
- `az pipelines runs list`/`runs show` are the same `Build` REST model
  as the older `az pipelines build` commands (both call the same
  `BuildClient`) — one `AzBuild` type covers both.
- `az boards work-item relation add --relation-type Parent` is how
  `wi create --parent` links a child. Relation-type names like "Parent"
  are matched case-insensitively against the org's relation types —
  fixed system vocabulary, unlike work item type/state names.
- There is no `az boards work-item-type` command group — it's absent
  from the extension's command registry — so `lib/work-item-types.ts`
  (state -> category, used to drop Completed/Removed items from
  `link`'s children expansion) goes through `az rest` directly.
- The `pipelines runs` command group is only `list`/`show`/`tag`/
  `artifact` — no timeline, job, or log command — so `pipeline log`
  goes through `az rest` against the Build timeline/logs endpoints.
- `az repos show` returns a `GitRepository` object including
  `defaultBranch` (e.g. `refs/heads/main`), used as `summarize`'s
  fallback base branch.

For anything else: reading the extension's Python source on GitHub
(`commands.py` per command group for the name-to-function mapping, then
the named implementation file for the actual shape) is faster and more
reliable than guessing from `--help` or table output.

## Development

```sh
npm install
npm run dev -- status   # run against source via tsx, no build step
npm run build            # bundle to dist/index.js
npm test                  # vitest
npm run typecheck          # tsc --noEmit
```

Test fixtures use `contoso`/`MyProject`/`my-repo`/`MyTeam` as
placeholders throughout — no real org name appears anywhere in the
source, examples, or tests.

## Out of scope

Not built, on purpose: `dova tui` (full-screen dashboard), `dova stats`
(OData-based cycle time/PR turnaround), `dova blame`, an extension
system, a local TTL cache for reads, and any push-notification feature
(webhooks can't target localhost, and a polling loop marketed as
"real-time" isn't an acceptable substitute).
