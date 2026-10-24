# Design: dova as a daemon

Status: **proposal** — nothing here is implemented yet.

## Why

Every Azure DevOps operation dova performs today is an `az` subprocess.
`az` is a Python CLI that imports itself and the `azure-devops`
extension on every call, so each one costs on the order of a second
(more on Windows), before any network I/O. A single command makes
several: `dova status` up to six (in two parallel waves), `dova link`
two plus one per child work item type, and `dova bug` four on a first
run in a repo (team, area, iteration, create). dova's own share is small — the
bundled CLI starts in ~150 ms (bare `node` is ~25 ms), almost all of it
module loading.

`az` also accounts for a large share of dova's complexity, none of
which is about Azure DevOps:

- `lib/az-file-arg.ts` — routing every free-text argument through a
  temp file because `az.cmd` re-parses arguments through `cmd.exe`.
- `assertNoNewlineArgs`, `toAsciiSafeJson` — working around newline
  loss and az's Latin-1 `--body` bug.
- `PYTHONIOENCODING` / `PYTHONUTF8`, `interpretAzFailure` — scraping
  stderr to guess whether a failure was auth, a missing extension, or
  something real.
- `AZURE_DEVOPS_AAD_RESOURCE` on every `az rest` call.

So the redesign is two changes:

1. **Talk to the Azure DevOps REST API directly**, with a bearer token,
   over `fetch`. This removes the per-call Python startup and every
   workaround above. This is where most of the speedup comes from.
2. **Run a long-lived daemon that owns authentication and the
   connection to Azure DevOps.** The CLI becomes a client of it. The
   daemon holds the token, refreshes it in the background, keeps TLS
   connections warm, and caches the metadata that barely changes
   (teams, iterations, work item types and states, repo ids, default
   branches).

Change 1 delivers most of the latency win even without change 2. The
daemon is still worth doing: it is one place for credentials (the CLI
never sees a refresh token), one place for caching, and later the
natural home for push-style features (`pipeline watch` streaming,
prefetching the current branch's PR/build status).

Rough target: `dova wi view 123` from ~1.5–3 s today to ~0.2–0.4 s;
`dova status` from several seconds to well under one. These are
estimates. Phase 1 should measure before and after.

## Shape

```
┌────────────── dova (CLI) ───────────────┐         ┌──────────── dovad (daemon) ─────────────┐
│ commander, prompts, rendering, --json   │         │ auth providers ─ token cache (memory)   │
│ git (runs in the user's cwd)            │  IPC    │                 refresh token (keychain)│
│ context resolution (git remote, config) │◄──────► │ AdoClient: fetch + keep-alive agent     │
│ AdoClient (IPC impl)                    │ JSON-RPC│ metadata cache (TTL, invalidate-on-write)│
└─────────────────────────────────────────┘         └─────────────────────────────────────────┘
```

### Thin daemon, not a command-executing daemon

Two ways to split the work:

- **Fat**: the CLI forwards argv, cwd, env and the TTY to the daemon,
  which runs the command and streams output back (the nailgun / Gradle
  daemon model).
- **Thin**: the CLI keeps all command logic, git calls, prompts and
  rendering. The daemon is an authenticated Azure DevOps gateway.

**Recommendation: thin.** Fat would save the remaining ~120 ms of
module loading, but it has to proxy interactive prompts (`inquirer`),
stdin (`--description -`), TTY detection, `$NO_COLOR` and the client's
cwd across a socket. That is a lot of surface for a small gain, and the
same gain is available by lazy-loading command modules. With thin, the
daemon has a small, security-focused job and the CLI stays testable
exactly as it is today.

### The `AdoClient` seam

This replaces `Runner.az`. `Runner.git` stays.

```ts
interface AdoClient {
  request<T>(req: {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    url: string;                       // absolute dev.azure.com URL
    body?: unknown;                    // JSON, sent as-is (no ASCII escaping needed)
    contentType?: string;              // e.g. application/json-patch+json
    responseType?: 'json' | 'text';
    cache?: { ttlSeconds: number; key?: string };
  }): Promise<T>;
}
```

There are three implementations:

- `DaemonAdoClient`: the CLI's default. Sends each request over IPC.
- `DirectAdoClient`: runs in-process. The daemon uses it internally,
  and it is the `--no-daemon` / CI fallback.
- `FakeAdoClient`: for tests, the same pattern as `fake-runner.ts`,
  matching on method + URL instead of az argv.

Errors map from HTTP status, not from scraping stderr: 401/203 →
`AuthError` ("run `dova auth login`"), 404 → `NotFoundError`, 400 →
`UserError` carrying the service's `message`, and everything else →
`ExternalCommandError`.

### Porting the az calls

Every az command dova uses is a thin wrapper over a REST endpoint:

| Today (az) | REST |
|---|---|
| `boards work-item show` | `GET _apis/wit/workitems/{id}?$expand=relations` |
| `boards query --wiql` | `POST {project}/_apis/wit/wiql` → `POST _apis/wit/workitemsbatch` |
| `boards work-item create` | `POST {project}/_apis/wit/workitems/${type}` (json-patch) |
| `boards work-item relation add` | `PATCH _apis/wit/workitems/{id}` (json-patch `add /relations/-`) |
| `boards area team list` | `GET {project}/{team}/_apis/work/teamsettings/teamfieldvalues` |
| `boards iteration team list` | `GET {project}/{team}/_apis/work/teamsettings/iterations?$timeframe=current` |
| `devops team list` | `GET _apis/projects/{project}/teams` |
| `repos show` | `GET {project}/_apis/git/repositories/{repo}` |
| `repos pr list / show` | `GET {project}/_apis/git/repositories/{repo}/pullrequests[/{id}]` |
| `repos pr create` | `POST .../pullrequests` (with `workItemRefs`) |
| `repos pr work-item list` | `GET .../pullrequests/{id}/workitems` + batch get |
| `pipelines runs list / show` | `GET {project}/_apis/build/builds[/{id}]` |
| `az rest …` (threads, timeline, logs, states) | already REST; drop the wrapper |

All of this is pinned to `api-version=7.1`. `dova api` becomes a real
REST passthrough: dova reads `--body @file` and `--body -` itself
instead of handing az's `@` syntax through.

## Authentication

`dova auth login` asks the daemon to run a login flow. The daemon keeps
the access token in memory and persists only what it needs to survive
a restart (a refresh token or a PAT) in the OS credential store: DPAPI
on Windows, Keychain on macOS, libsecret on Linux, through
`@azure/msal-node-extensions`. If no store is available, dova errors
rather than falling back to a plaintext file.

Providers, chosen at login:

| Provider | How | When |
|---|---|---|
| `entra` (default) | MSAL public client. Interactive browser with a loopback redirect to the daemon; `--device-code` for SSH/headless. Scope `499b84ac-1321-427f-aa17-267ca6975798/.default`. | Normal use. |
| `azcli` | `az account get-access-token --resource 499b84ac-…` once, then again ~5 min before expiry. | Zero-setup migration for current users; tenants that block new apps. |
| `pat` | `dova auth login --pat` (read from stdin). | Orgs that allow PATs; CI. |

Login over IPC: the daemon returns either an authorize URL (the CLI
opens the browser, and the redirect lands on the daemon's loopback
listener) or a device-code message (the CLI prints it). The CLI waits
on a `auth.login` completion notification.

Commands:

```
dova auth login [--provider entra|azcli|pat] [--device-code] [--tenant <id>]
dova auth status            # who, which provider, token expiry, which orgs answered
dova auth logout            # wipes memory + keychain entry
```

`dova auth status` calls `_apis/connectionData` to show the
authenticated identity per org.

## Daemon lifecycle

- **Auto-start.** If the socket is absent, the CLI spawns `dova daemon
  run` detached and waits up to ~2 s for it to come up. Nobody has to
  remember to start it.
- **Explicit control:** `dova daemon start | stop | restart | status |
  logs`.
- **Version handshake.** The first message is `hello {version}`. If
  the daemon is a different version (say after `npm update`), the CLI
  tells it to exit and starts a fresh one. A stale daemon never serves
  a new CLI.
- **Idle exit.** The daemon exits after 8 h with no requests (to be
  tuned). Restarting is cheap because the refresh token is in the
  keychain.
- **Single instance.** Binding the socket is the lock. If a stale
  socket file refuses connections, it is removed and rebound.
- **Logs** go to `$XDG_STATE_HOME/dova/daemon.log` (on Windows,
  `%LOCALAPPDATA%\dova\daemon.log`). Tokens are never logged.
- **`--no-daemon` / `DOVA_NO_DAEMON=1`** runs `DirectAdoClient`
  in-process with the same providers. For CI and debugging.

## IPC and its security

- **Transport.** On Unix, a socket at `$XDG_RUNTIME_DIR/dova/dovad.sock`
  (fallback `~/.dova/run/`), in a `0700` directory, with the socket
  `0600`. On Windows, a named pipe `\\.\pipe\dova-<user-sid-hash>`.
- **Who can connect.** On Unix the file permissions decide. Node can't
  set a DACL on a named pipe, and the default one grants read to
  Everyone, which is not enough to send a request but is not a boundary
  we should rely on. So on both platforms the daemon also writes a
  random 256-bit session key to a user-only file at start, and every
  connection must present it in `hello`. Anyone who can read that file
  can already read the keychain as the user.
- **Protocol.** Newline-delimited JSON-RPC 2.0:
  - `hello`
  - `auth.status`, `auth.login` (plus progress notifications),
    `auth.logout`
  - `ado.request`
  - `cache.clear`
  - `daemon.status`, `daemon.shutdown`
  - Later: `watch.*` subscriptions.
- **What the daemon fetches.** It only fetches `https://dev.azure.com/*`
  and `https://*.visualstudio.com/*` URLs. It is not a general
  authenticated proxy for whatever a local process asks.

## Caching (in the daemon)

TTL cache keyed by method + URL, GETs only, opt-in per request:

| Data | TTL |
|---|---|
| teams, team area paths | 1 h |
| current iteration | until its `finishDate` (cap 24 h) |
| work item types/states | 24 h |
| repo id, default branch, project id | 24 h |
| work items, PRs, builds, threads | not cached |

A write to a work item or PR evicts that resource's entries.
`dova cache clear` (and `--reresolve`) bypasses the cache. The existing
git-config persistence of team/area/iteration choices stays as it is.
That is user intent, not a cache.

## What gets deleted

- `src/lib/az-file-arg.ts` and its tests.
- From `src/lib/exec.ts`: `Runner.az`, `runAzJson`, `runAzRestJson`,
  `runAzRestText`, `assertNoNewlineArgs`, `toAsciiSafeJson`,
  `interpretAzFailure`, `AZURE_DEVOPS_AAD_RESOURCE` (it moves into the
  auth providers as the token scope).
- `execa` for az. git keeps it.
- The README requirement on the Azure CLI and the `azure-devops`
  extension. They are only needed for the `azcli` provider.
- In `src/instructions/` and the skill references, "never call
  `az boards`" stays true; agents get `dova auth status` for diagnosing
  auth.

## Phases

1. **REST, in-process.** Add `AdoClient` + `DirectAdoClient`, with the
   `azcli` provider as the only token source (behavior identical for
   users, no new setup). Port `lib/` module by module (work-items →
   pr → pipelines → team-resolver → creates) and move the tests to
   `FakeAdoClient`. Delete the az plumbing. Measure.
2. **Daemon.** Add `dovad`, the IPC protocol, `DaemonAdoClient`,
   auto-start, the version handshake, `dova daemon …`, and
   `dova auth status/logout`.
3. **Own auth.** Add the `entra` provider (MSAL + keychain),
   `pat`, and `dova auth login`. Make `entra` the default.
4. **Use the daemon.** Add the metadata cache, `pipeline watch` as a
   subscription, branch-status prefetch, and lazy-loaded command
   modules for CLI startup.

Each phase ships on its own and leaves dova working.

## Open questions

1. **Entra client ID.** Register a multi-tenant public-client app for
   dova, or reuse the Azure CLI's well-known client ID
   (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`)? Our own app is the honest
   option, but tenants that require admin consent for new apps will
   block it until an admin approves. The az client ID is pre-consented
   nearly everywhere, but it means borrowing another product's identity.
2. **Thin vs. fat daemon.** This doc recommends thin. Fat is only
   worth it if ~100 ms of CLI startup matters after lazy loading.
3. **Idle timeout.** Should the daemon exit after a few hours, or stay
   up until logout or reboot?
4. **On-premises Azure DevOps Server.** dova only recognizes
   dev.azure.com today. If on-prem support is ever wanted, it changes
   the auth story (NTLM/Kerberos/PAT, no Entra), so it would be cheaper
   to decide now.
