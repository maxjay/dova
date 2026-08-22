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
- `dova start <id...>` — the big one: any id with open children (whatever
  it's called — no team/backlog-config lookup involved, just the item's
  own hierarchy) expands into a multi-select of them, state-category-based
  transitions (never a literal state name, never regresses an item),
  assignment, local branch-naming, duplicate-branch detection, and
  git-config tracking. See `src/lib/start.ts`'s doc comments for the full
  flow.
- `dova bug` / `dova wi quick` — fast filing, sharing `src/lib/quick-create.ts`.
- `dova wi create` — the fuller version, with `--assign-to`/`--parent`.
- `dova wi view` / `dova wi search` — view shows the item's parent and
  *children* (e.g. a Feature's User Stories) in a table, generic across
  every work item type — the same "just look at the actual hierarchy"
  approach `start`'s expansion uses; search builds WIQL from flags
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

**On `dova start`'s call count:** the project brief's "no command makes
more than 3-4 calls" guideline is met everywhere else, but `start`
inherently doesn't fit it — transitioning and (optionally) assigning N
work items is O(n) in however many ids you pass, by the nature of the
command, not from over-fetching. Every *lookup* that doesn't have to
scale with N is batched/cached instead (one call for the seed items
regardless of count, one call for all their children combined, one
state-category fetch per distinct work item *type* in the batch — reused
for both the children-filtering step and the transition step, not
fetched twice — one `git config --get-regexp` for the whole
duplicate-branch scan instead of one per local branch). Flagging this
per the brief's own instruction rather than quietly building past the
guideline.

`start` originally resolved a team up front to look up the org's backlog
configuration, purely to answer "is this id a portfolio type" before
deciding whether to expand it — meaning every call paid for a team
picker (and an unconditional "save to git config?" prompt) even for an
ordinary Bug that never needed one. The work item it already fetches
carries everything that expansion decision needs: its own children. So
`start` now just queries `[System.Parent] = <id>` directly (the same
data `wi view`'s children table is built from) and expands on that —
faster, more general (works for any item with children, not just
canonical portfolio types), and doesn't ask about team at all unless a
work item is actually being *created* (`wi create`/`wi quick`/`bug`,
where area/iteration genuinely are team-specific and unavoidable).

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
| Config/cache dir | [conf](https://github.com/sindresorhus/conf) | Resolves the correct per-OS path (XDG / AppData / Application Support) itself |
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
    team-resolver.ts   team/area/iteration resolution + its on-disk cache
    config.ts          git-config helpers + az devops's own config file + dova's cache dir
    output.ts           --json / --jq / color / table rendering
    command-helpers.ts   shared flag-group builders (--org/--project/--repo, --json, --jq, --web, --no-color)
    completions/         tree -> {bash,zsh,fish,powershell} script generators
    work-items.ts        fetch-by-id / batch-fetch-by-id / children / full detail+render, shared by wi/pr/start/view
    work-item-types.ts   state -> category, and the "what should dova start transition into" decision
    wiql.ts                small WIQL builder (wi search, batch id fetch, start's + view's children query)
    pr.ts                  PR fetch/threads/comment/reply/resolve/full detail+render, shared by status + pr * + view
    pipelines.ts            pipeline run fetch + web URL, shared by status + pipeline *
    branch-naming.ts        slug/prefix/branch-name for `dova start`
    quick-create.ts          shared guts of `dova bug` / `dova wi quick`
    start.ts                  `dova start`'s full implementation
    urls.ts                    work item / PR link parsing, for "give dova a link or an id"
  types/azure-devops.ts  minimal REST object shapes (PR, WorkItem, Build, CommentThread)
tests/
  context.test.ts        parseAzureRepoRemoteUrl + resolveContext, fully mocked
  team-resolver.test.ts   resolveProject/resolveTeam/resolveAreaPath/resolveIterationPath/resolveTeamContext, fully mocked
  wiql.test.ts / branch-naming.test.ts / work-item-types.test.ts / api.test.ts / urls.test.ts / pr.test.ts / exec.test.ts
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
  supported by the current extension (confirmed from source), with a
  defensive `az rest` fallback in case that ever changes.
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
  category is this state in" (`lib/work-item-types.ts`, the "never
  hardcode a state name" logic `dova start`'s transition step needs)
  goes through `az rest` against the REST API directly for that reason.

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

Team/area/iteration resolution (`resolveTeamContext()`) is separate,
shared plumbing used by any command that creates or files a work item —
see the doc comment at the top of `team-resolver.ts` for its full
resolution order and caching behavior.

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
`dova start`'s own expansion uses:

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
