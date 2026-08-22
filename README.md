# dova

A `gh`/`glab`-style CLI for Azure DevOps. Wraps `az` (with the
`azure-devops` extension) and `git`, inferring org/project/repo/branch/team
from the directory you're standing in instead of making you pass flags
every time.

## Status: v1 command surface implemented

Every command from the project brief is implemented end to end — see
`src/commands/` for the commander wiring and `src/lib/` for the shared
logic each command is built from:

- `dova status` — current branch's active PR, linked work items, recent
  pipeline runs, comment threads. One screen, one `gatherStatus()` call.
- `dova link <id...>` — associates the branch you're *already on* with
  one or more work items, so `dova pr create` links them automatically.
  Doesn't create, name, or check out a branch — see "Context linkage,
  not workflow" below for why, and the full scenario this is built
  around.
- `dova bug` / `dova wi quick` — fast filing, sharing `src/lib/quick-create.ts`,
  with `--link` to chain into `dova link` for the newly created id.
- `dova wi create` — the fuller version, with `--assign-to`/`--parent`.
- `dova wi view` / `dova wi search` — view shows the item's parent and
  *children* (e.g. a Feature's User Stories) in a table, generic across
  every work item type — the same "just look at the actual hierarchy"
  approach `link`'s expansion uses; search builds WIQL from flags
  (`src/lib/wiql.ts`) so nobody has to write it by hand.
- `dova view <id-or-url>` — the generic "read anything" entrypoint: given
  a work item or PR link, or a bare id, view its full detail. A link
  unambiguously says which kind of thing it is; a bare id tries as a
  work item first, falling back to a PR. See "Reading things" below.
- `dova pr create` / `dova pr view` / `dova pr comment` /
  `dova pr comment reply` / `dova pr comment resolve` — `comment` posts a
  new thread, `reply` responds within an existing one, and `resolve`
  takes an optional status (`resolved` by default, also `active`,
  `won't-fix`, `closed`, `pending`) rather than only ever resolving.
- `dova pipeline status` / `dova pipeline watch` — watch polls and exits,
  no daemon.
- `dova api` — the raw REST escape hatch.
- `dova completion {bash,zsh,fish,powershell}` — generated from the live
  command tree (see "Completions" below).

Context resolution (`src/lib/context.ts`) and team/area/iteration
resolution (`src/lib/team-resolver.ts`) are the shared plumbing
underneath nearly all of this, and are the most heavily tested modules
(`tests/context.test.ts`, `tests/team-resolver.test.ts`) since almost
everything else depends on one or both.

## Context linkage, not workflow

This is the organizing principle behind `dova link`, and it's worth
stating explicitly because the command went through two real redesigns
to get here.

**dova is not a replacement for git.** It works alongside it. The
developer (or an agent acting for them) creates branches, names them,
checks them out, commits — all of that is git's job, already done,
using whatever convention they already use, before dova is ever
invoked. dova's job is narrower and sits on either side of that: be a
handy proxy for `az` (fetch a ticket, create a PR, post a comment), and
record the *linkage* between local git state and Azure DevOps entities
that git itself has no concept of — which branch corresponds to which
ticket, so the next `az`-facing command doesn't need to be told again.

### The scenario

An agent is given a ticket and asked to start work on it:

| # | Step | Command | Owner |
|---|---|---|---|
| 1 | Read the ticket | `dova wi view 4821 --json` | **dova** — `az` proxy, a plain read |
| 2 | Create + check out the branch | `git checkout -b fix/4821-login-redirect` | **git** — the agent's own naming, dova never sees it |
| 3 | Link the ticket to the branch just checked out | `dova link 4821` | **dova** — the one fact git has no concept of |
| 4 | Do the work | edits, `git commit`, etc. | **git** / the agent's own tooling |
| 5 | Open the PR | `dova pr create` | **dova** — reads the link back out and attaches it automatically, no flags needed |

Steps 2 and 4 never touch dova. Steps 1, 3, 5 are each either a plain
`az` read/write or a git-config read/write — nothing in the whole flow
has dova creating or naming a branch.

### Why `link`, not `start`

The command used to be called `start` and did four things: create +
name the branch, transition the ticket's state to InProgress, offer to
assign it to you, and write the git-config link. Cut against "dova is a
linkage layer alongside git," only the last of those is actually
linkage:

- **Branch creation/naming** is git's job, full stop — the developer or
  agent already has their own convention, and dova imposing one (or
  even offering to) is dova doing git's work for it.
- **State transition** and **assignment** change something on the
  Azure Boards side that has nothing to do with whether `pr create` can
  find and link the ticket — a PR links by id regardless of the
  ticket's state or assignee. They're workflow automation (mirroring
  what a human does when they *begin* work), not context propagation.
  (These were explicit in the original spec for this command — this is
  a real reconsideration of that requirement, not cleanup of drift.)

What's left once you cut those three is: fetch the ticket(s) (validates
the id, and is where children-disambiguation still lives — see below),
then write `branch.<current-branch>.dova-workitems`/`dova-primary` for
whatever branch you're already standing on. There's no branch being
created and nothing beginning — hence `link`, not `start`.

`dova link` is also idempotent and additive: running it again on the
same branch with another id merges it into the existing linked set
(keeping whichever primary was already established) rather than
clobbering it — exactly the shape "also link this related ticket to
what I'm already working on" needs. If an id you're linking is already
linked to a *different* branch, it offers to check that branch out
instead of double-tracking the same ticket in two places — that's not
branch lifecycle management (nothing is created or named), it's the
same kind of navigation `gh pr checkout` does.

Any id with open children (an Epic, a Feature, or just a Bug someone's
been using as a checklist — whatever the process calls it) still
expands into a multi-select of them, unchanged from before, and for the
same reason work item type/state names are never hardcoded elsewhere in
this codebase: it's driven by the ticket's actual `[System.Parent]`
hierarchy, not by asking a team what its backlog levels are called. For
an agent that's already run `wi view` on the ticket first (step 1
above), this disambiguation is mostly moot — the agent already knows
from that response whether the ticket has open children and can pass
the correct leaf id(s) straight to `link`, at which point `link`
degenerates to a pure git-config write with no extra `az` calls at all.
The children-check is the safety net for a human (or an agent) linking
an id cold, without having looked at it first.

`link` never resolves a team. The old `start` did, up front, on every
call, purely to look up the org's backlog configuration and answer "is
this a portfolio type" — meaning an ordinary Bug paid for a team picker
(and an unconditional "save to git config?" prompt with no flag to skip
it) exactly as much as an actual Epic did. Team resolution
(`team-resolver.ts`) is untouched and still exactly as necessary as
before for `wi create`/`wi quick`/`bug`, where a *new* ticket genuinely
needs an area path and iteration assigned and there's no other source
for those — it just no longer has anything to do with linking a branch
to a ticket that already exists.

## Why TypeScript, not a compiled binary

This is a developer tool built for iteration speed, not a binary shipped
to end users who've never heard of Node. That distinction is what
settled the language call:

- **The team building it lives in TypeScript already.** Velocity here
  means fast edit-test loops, an editor that understands the Azure
  DevOps REST shapes as real types, and contributors who don't have to
  learn Go/Cobra to add a command. A scripting-language tool with a real
  type system costs nothing extra to maintain and is faster to extend.
- **The runtime "cost" is already paid.** dova's own hard prerequisites
  are `az` (a Python-based CLI with its own runtime) and `git`. A team
  that can install and keep those current on a locked-down machine can
  install Node — it's a five-minute, well-trodden ask, not a new class of
  problem. This would be a much harder sell for a tool with *no* other
  runtime prerequisites at all.
- **Distribution is still simple without a single binary.** `npm i -g
  dova` (or a private registry / internal npm mirror) is the realistic
  install path for a team that already runs `az` and `git`. If a single
  static binary ever becomes a real requirement (fully offline machines,
  no npm registry access), `tsup`'s output is a plain Node ESM bundle —
  `pkg`/`nexe`-style packaging is a follow-on step, not a rewrite.

The counter-case — Go + Cobra + a table/color library, one static
binary, zero runtime — is the right call for a tool distributed to
strangers (which is exactly why `gh` and `glab` are built that way: they
ship to every contributor on every OS with zero assumptions). dova isn't
that; it's an internal team tool where the people running it are the
people building it. TypeScript wins on velocity here without meaningfully
losing on the deployment story.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript on Node 20+ | see above |
| CLI parsing | [commander](https://github.com/tj/commander.js) | Small, explicit, no generator/build-step magic; nested subcommands map cleanly onto `dova wi create` style paths |
| Color | [chalk](https://github.com/chalk/chalk) | Respects `NO_COLOR` / non-TTY out of the box; `getColor()` also forces it off for `--no-color` |
| Tables | [cli-table3](https://github.com/cli-table/cli-table3) | Real column alignment/wrapping, not hand-padded strings |
| Interactive prompts | [@inquirer/prompts](https://github.com/SBoudrias/Inquirer.js) | Arrow-key select/confirm for the ambiguous-without-a-flag cases |
| Process execution | [execa](https://github.com/sindresorhus/execa) | Sane cross-platform spawning; every `az`/`git` call goes through `src/lib/exec.ts`, which is the one seam tests fake instead of mocking modules |
| `--jq` | [jq-wasm](https://github.com/owenthereal/jq-wasm) | Real jq semantics with **no external binary** — matters on a locked-down machine where installing a second CLI tool isn't a given |
| Browser opening | [open](https://github.com/sindresorhus/open) | Cross-platform `--web` |
| Build | [tsup](https://github.com/egoist/tsup) | Bundles to a single ESM file with a shebang banner; no separate `declaration`/type-emit step needed for a CLI |
| Tests | [vitest](https://vitest.dev) | Fast, native TS, good `vi.fn()` ergonomics for the prompt/runner fakes |

## Architecture

```
src/
  index.ts            entrypoint: builds the program, maps thrown errors to exit codes
  cli.ts              assembles the full command tree (single source of truth for --help and completions)
  commands/           one file per command; each registers itself on a commander Command
  lib/
    exec.ts           the only place that shells out to az/git — everything else takes a Runner
    context.ts         org/project/repo/branch resolution
    team-resolver.ts   team/area/iteration resolution for creating work items, incl. --like/--save/--team overrides
    config.ts          git-config helpers + az devops's own config file
    output.ts           --json / --jq / color / table rendering
    command-helpers.ts   shared flag-group builders (--org/--project/--repo, --json, --jq, --web, --no-color)
    completions/         tree -> {bash,zsh,fish,powershell} script generators
    work-items.ts        fetch-by-id / batch-fetch-by-id / children / full detail+render, shared by wi/pr/link/view
    work-item-types.ts   state -> category (used to drop Completed/Removed children from link's expansion)
    wiql.ts                small WIQL builder (wi search, batch id fetch, link's + view's children query)
    pr.ts                  PR fetch/threads/comment/reply/resolve/full detail+render, shared by status + pr * + view
    pipelines.ts            pipeline run fetch + web URL, shared by status + pipeline *
    quick-create.ts          shared guts of `dova bug` / `dova wi quick`
    link.ts                   `dova link`'s full implementation
    urls.ts                    work item / PR link parsing, for "give dova a link or an id"
  types/azure-devops.ts  minimal REST object shapes (PR, WorkItem, Build, CommentThread)
tests/
  context.test.ts        parseAzureRepoRemoteUrl + resolveContext, fully mocked
  team-resolver.test.ts   resolveProject/resolveTeam/resolveAreaPath/resolveIterationPath/resolveCreateContext, fully mocked
  wiql.test.ts / work-item-types.test.ts / api.test.ts / urls.test.ts / pr.test.ts / exec.test.ts
                          pure-logic unit tests for the modules above
  fixtures/               fabricated remote URLs + az JSON payloads (contoso/MyProject/my-repo placeholders — no real org anywhere)
```

**Every `az` call goes through `runAzJson()`** (`src/lib/exec.ts`), which
appends `--output json` and parses it — nothing scrapes table output.
Every command's real logic takes a `Runner` (the `git`/`az` process
interface) as a parameter rather than importing `execa` directly, so
tests substitute an in-memory fake instead of mocking modules.

### Where the az CLI facts in this codebase came from

Several choices across this codebase depend on exact `az`/REST shapes
that aren't fully nailed down on learn.microsoft.com (or the docs site
wasn't reachable while building this). Where that was true, the actual
[azure-devops-cli-extension](https://github.com/Azure/azure-devops-cli-extension)
source — including its `commands.py` command-registration files, which
give the ground-truth mapping from `az` command names to implementation
functions — was read directly rather than guessed. Notably:

- `az devops configure --list` does **not** produce parseable JSON (its
  `list_config` code path is a bare `print()`, returning nothing) — so
  dova reads the extension's own INI config file directly instead
  (`azDevopsConfigFilePath()` in `lib/config.ts`).
- `az boards area team list` returns one `TeamFieldValues` object
  (`{ defaultValue, values }`), not a flattened list — so "no area
  flagged as default" is just `!defaultValue`, no searching required.
- `az boards iteration team list --timeframe current` is genuinely
  supported by the current extension (confirmed from source) — no
  fallback needed for an older extension version, since dova only
  targets `dev.azure.com`.
- `az repos pr work-item list` doesn't just return refs — the extension
  resolves them and returns full `WorkItem` objects, fields included, so
  status/pr-view don't need a second round-trip per item.
- `az pipelines runs list`/`runs show` are, under the hood, the same
  `Build` REST model as the older `az pipelines build` commands (both
  call the same `BuildClient`) — so one `AzBuild` type covers both.
- `az boards work-item relation add --relation-type Parent` is how
  `wi create --parent` links a child, confirmed against
  `dev/boards/relations.py` (relation-type names like "Parent" are
  matched case-insensitively against the org's relation types — this is
  fixed system vocabulary, not something that varies by process
  template, unlike work item type/state names).
- There is **no** `az boards work-item-type` command group at all (it's
  simply absent from the extension's command registry), so "what state
  category is this state in" (`lib/work-item-types.ts`, used to drop
  Completed/Removed items from `dova link`'s children expansion — never
  a hardcoded state name) goes through `az rest` against the REST API
  directly for that reason.

If you're extending this and hit a command whose JSON shape isn't
obvious from `--help`, the same technique (read the extension's Python
source on GitHub — `commands.py` in each command group's directory for
the command-name-to-function mapping, then the named file for the
actual shape) is usually faster and more reliable than guessing from
docs or table output.

## Context resolution

Every command that needs org/project/repo resolves it in this order —
see `resolveContext()`:

1. Explicit `--org`/`--org-url`/`--project`/`--repo` flags. If `--org`
   and `--project` are both given, that's already a complete answer and
   nothing else is even consulted.
2. `git remote get-url origin`, parsed for both the modern
   (`dev.azure.com/{org}/{project}/_git/{repo}`, HTTPS or SSH) and legacy
   (`{org}.visualstudio.com`, HTTPS or SSH) URL forms.
3. `az devops configure` defaults (read from its config file directly —
   see above).
4. A specific, actionable error. Never a silent guess.

Area/iteration resolution for creating a work item (`resolveCreateContext()`
in `team-resolver.ts`) is separate, shared plumbing behind every command
that creates or files one (`dova bug`, `dova wi quick`, `dova wi
create`). One repo has one team's worth of tickets in it — that's the
whole assumption — so the only thing dova ever remembers durably is
repo-local git config, no separate cache directory:

1. `--like <id>` or `--team <name>` — explicit, one-off overrides for
   this call only, never persisted. `--like` copies `--area`/`--iteration`
   straight off an existing work item (one `boards work-item show`
   call, no team resolved at all — team is only ever a means to an
   area/iteration pair, and `work-item create` doesn't take `--team`).
   `--team` picks a team by name and resolves its area/iteration fresh.
2. Saved `dova.area`+`dova.iteration` repo-local git config — the
   common case once a repo has been used once: zero interactive
   prompts, one `az` call (the create itself).
3. `dova.team` repo-local git config, or (first time only) an
   interactive picker over `az devops team list` — then `--area`/
   `--iteration` resolution for that team, saved to `dova.area`/
   `dova.iteration` for next time (and `--like <id> --save` writes the
   same two keys directly, for "this ticket's team, not the repo's
   usual one, is now the default").

`--reresolve` ignores every saved value and starts over. There's no
global (cross-repo) override for project or team — team is inherently
project-scoped, and nothing about "my default team everywhere" survived
contact with a real scenario, so it isn't there to reach for.

## Reading things

`dova view`, `dova wi view`, and `dova pr view` all accept either a bare
id or a link (`lib/urls.ts` parses both the work item and PR URL forms,
including the legacy `.visualstudio.com` host). A link's org/project
(and repo, for a PR link) override context resolution — pasting a link
to a *different* org/project than the one you're standing in just works,
the way `gh pr view <url>` does.

`dova view` is the generic form for when the caller (a person, or an
LLM driving dova) doesn't already know or care whether an id is a work
item or a PR: a link says so unambiguously; a bare id tries as a work
item first (falling back to a PR), since work item ids and PR ids are
separate id spaces with no way to tell them apart from the number alone.

Every "view" also resolves the item's immediate hierarchy, not just its
own fields — generic across every work item type (a Feature's User
Stories, an Epic's Features, a Bug's linked Tasks, whatever the process
calls them), the same "just look at `[System.Parent]`" approach
`dova link`'s own expansion uses:

- **parent** — id, title, type, state (hydrated with one extra fetch when a parent exists)
- **children** — same shape, one WIQL call on `[System.Parent] = <id>`

That structure comes through in `--json` as `parent`/`children`
directly (see `WorkItemDetail` in `lib/work-items.ts`) — a nav an LLM
consuming `--json` can walk without a second `dova wi view` per child
just to get titles/states, and a table in the human view for the same
reason.

## Completions

`dova completion <bash|zsh|fish|powershell>` generates a script directly
from the live commander command tree (`src/lib/completions/introspect.ts`
walks the actual `Command` graph — there's no separate, hand-maintained
list of commands/flags to keep in sync).

```sh
# bash
source <(dova completion bash)

# zsh
source <(dova completion zsh)

# fish
dova completion fish > ~/.config/fish/completions/dova.fish

# PowerShell
dova completion powershell >> $PROFILE
```

The bash generator avoids `declare -A` (bash 4+ only) since macOS ships
bash 3.2; zsh reuses that same generated logic via `bashcompinit` rather
than a second hand-written implementation. PowerShell's generator takes
a different tack that fits the shell better: it serializes the whole
tree as a nested hashtable and walks it with one generic script block at
completion time, rather than one branch per command path.

## Development

```sh
npm install
npm run dev -- status         # run against source via tsx, no build step
npm run build                 # bundle to dist/index.js
npm test                       # vitest
npm run typecheck              # tsc --noEmit
```

No org name, project name, team name, or process-specific state/type
name is hardcoded anywhere in the source, examples, or tests — see the
"No hardcoded org" requirement this was built against. Test fixtures use
`contoso`/`MyProject`/`my-repo`/`MyTeam` as placeholders throughout.

## Deliberately out of scope for v1

Noted, not built: `dova tui` (full-screen dashboard), `dova stats`
(OData-based cycle time/PR turnaround), `dova blame`, an extension
system, a local TTL cache for reads, and any push-notification feature
(webhooks can't target localhost, and a naive polling loop marketed as
"real-time" isn't an acceptable substitute — see the project brief).
