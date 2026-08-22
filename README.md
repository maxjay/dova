# dova

A `gh`/`glab`-style CLI for Azure DevOps. Wraps `az` (with the
`azure-devops` extension) and `git`, inferring org/project/repo/branch/team
from the directory you're standing in instead of making you pass flags
every time.

## Status: early scaffold

This repo is mid-build. What's real today:

- Context resolution (`src/lib/context.ts`) — parses `git remote get-url
  origin` for org/project/repo, falls back to `az devops configure`
  defaults, errors clearly otherwise. Fully tested.
- Team/area/iteration resolution (`src/lib/team-resolver.ts`) — the
  shared plumbing every work-item-touching command needs. Fully tested.
- `dova status` — implemented end to end.
- `dova api` — implemented end to end (the escape hatch).
- `dova completion {bash,zsh,fish,powershell}` — implemented, generated
  from the live command tree (see "Completions" below).
- Everything else (`start`, `bug`, `wi *`, `pr *`, `pipeline *`) is
  scaffolded — full `--help`, full flag surface — but each action just
  throws "not implemented yet". See the command's docstring for its
  planned behavior.

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
  types/azure-devops.ts  minimal REST object shapes (PR, WorkItem, Build, CommentThread)
tests/
  context.test.ts        parseAzureRepoRemoteUrl + resolveContext, fully mocked
  team-resolver.test.ts   resolveProject/resolveTeam/resolveAreaPath/resolveIterationPath/resolveTeamContext, fully mocked
  fixtures/               fabricated remote URLs + az JSON payloads (contoso/MyProject/my-repo placeholders — no real org anywhere)
```

**Every `az` call goes through `runAzJson()`** (`src/lib/exec.ts`), which
appends `--output json` and parses it — nothing scrapes table output.
Every command's real logic takes a `Runner` (the `git`/`az` process
interface) as a parameter rather than importing `execa` directly, so
tests substitute an in-memory fake instead of mocking modules.

### Where the az CLI facts in this codebase came from

A few of the choices in `team-resolver.ts` and `config.ts` depend on
exact `az`/REST shapes that aren't fully nailed down on
learn.microsoft.com (or weren't reachable while building this). Where
that was true, the actual
[azure-devops-cli-extension](https://github.com/Azure/azure-devops-cli-extension)
source was read directly rather than guessed — see the comments in those
two files for what was verified and where. Notably:

- `az devops configure --list` does **not** produce parseable JSON (its
  `list_config` code path is a bare `print()`, returning nothing) — so
  dova reads the extension's own INI config file directly instead
  (`azDevopsConfigFilePath()` in `config.ts`).
- `az boards area team list` returns one `TeamFieldValues` object
  (`{ defaultValue, values }`), not a flattened list — so "no area
  flagged as default" is just `!defaultValue`, no searching required.
- `az boards iteration team list --timeframe current` is genuinely
  supported by the current extension (confirmed from source), with a
  defensive `az rest` fallback in case that ever changes.

If you're extending this and hit a command whose JSON shape isn't
obvious from `--help`, the same technique (read the extension's Python
source on GitHub) is usually faster and more reliable than guessing from
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
