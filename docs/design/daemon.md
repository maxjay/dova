# Design: dova as a daemon

Status: **implemented**, except the items under [Next](#next).

## Why

dova used to make every Azure DevOps call by spawning `az`. That meant
starting a Python CLI and its `azure-devops` extension each time, which
cost about a second per call before any network traffic (more on
Windows). A single command made several of those calls: `dova status`
made up to six. dova's own startup is ~150 ms.

`az` also brought a pile of workarounds that had nothing to do with
Azure DevOps: temp-file arguments to survive `cmd.exe`, ASCII-escaping
around az's Latin-1 bug, Python encoding variables, and guessing
failures from stderr. All of that is gone.

Now:

1. dova calls the **Azure DevOps REST API** directly with `fetch`, as
   the signed-in user.
2. A **long-running daemon (`dovad`)** holds the sign-in and makes every
   request on the CLI's behalf. It keeps the access token in memory,
   refreshes it before expiry, and keeps connections warm. The CLI
   never sees a token.

## Shape

```
┌───────────── dova (CLI) ─────────────┐   socket    ┌──────────────── dovad ────────────────┐
│ commands, prompts, rendering, --json │  (ndjson)   │ AuthSession: tokens in memory,        │
│ git, in the user's working tree      │ ◄─────────► │   per-org tenant, refresh, retry      │
│ context resolution                   │             │ fetch → dev.azure.com only            │
│ Runner.ado → transport               │             │ credential store (keychain + file)    │
└──────────────────────────────────────┘             └───────────────────────────────────────┘
```

The daemon is **thin**: it is an authenticated Azure DevOps gateway,
not a command runner. Command logic, git, interactive prompts, stdin
and rendering all stay in the CLI process. The daemon never needs the
user's cwd or terminal.

### The seam

`Runner` is `{ git(args), ado(req) }`. Every lib function builds
requests with `adoUrl` and reads them through `adoJson` / `adoText`
(`src/lib/ado.ts`). These map HTTP statuses to dova's errors:

- 401 or 203 → `PrereqError` with the hint "dova auth login"
- 404 → `NotFoundError`, carrying the service's message
- anything else → `ExternalCommandError`

`Runner.ado` hands the request to a transport (`src/lib/transport.ts`):

| Transport | When |
|---|---|
| daemon | Default. Auto-started on first use. |
| in-process, stored sign-in | `DOVA_NO_DAEMON=1` |
| in-process, PAT from env | `DOVA_TOKEN=<pat>` (CI) |

## Authentication

`dova auth login` signs the user in **as themselves**, with plain
OAuth 2.0 against Entra ID v2 (`src/auth/entra.ts`):

- **Browser (default).** Authorization code + PKCE. The redirect goes
  to a loopback listener on 127.0.0.1 and ::1, at the same port.
- **Device code.** Used with `--device-code`, and automatically over
  SSH or on Linux with no display.
- **PAT.** `--with-token`, read from stdin. It is checked against the
  current org when there is one.

The token audience is Azure DevOps (`499b84ac-…/.default`). The OAuth
client defaults to the Azure CLI's public client ID, which every
tenant already trusts for Azure DevOps. That means no app registration
and no admin consent. `DOVA_CLIENT_ID` overrides it.

**Tenants.** Each org's backing tenant comes from the
`X-VSS-ResourceTenant` header of an unauthenticated request, so a
guest user in another company's tenant gets a token for the right one.
The refresh token is redeemed per tenant, and tokens are cached per
tenant. If a tenant demands MFA that a silent refresh can't satisfy,
the error says `dova auth login --tenant <id>`.

**Storage** (`src/auth/store.ts`). The credential (a refresh token or
a PAT) is AES-256-GCM encrypted into `credentials.json`. Only the
32-byte key goes in the OS keychain, because Windows Credential
Manager caps a stored blob at 2560 bytes and a refresh token can
exceed that. With no keychain (a headless Linux box with no Secret
Service), the credential is stored in a 0600 file instead, and
`dova auth status` says so. Rotated refresh tokens are persisted as
they arrive.

## Daemon

- **Always running.** There is no idle timeout. The CLI starts the
  daemon if it isn't up. `dova daemon install` registers a login
  service that brings it back if it dies:
  - Linux: a systemd user unit with `Restart=always`
  - macOS: a launchd agent with `KeepAlive`
  - Windows: a hidden launcher in the Startup folder
- **Single instance.** Binding the socket is the lock. A service
  instance (`--service`) that finds the socket busy waits its turn
  instead of exiting, so the OS-managed one takes over whenever the
  other goes.
- **Upgrades.** `hello` carries a build id (version + bundle mtime).
  If the daemon is from another build, the CLI tells it to exit and
  starts a fresh one; a service restarts itself.
- **Commands:** `dova daemon start | stop | restart | status | run |
  install | uninstall`.

### IPC

- **Transport.** A Unix socket at `$XDG_RUNTIME_DIR/dova/dovad.sock`
  (otherwise the state dir), mode 0600 in a 0700 directory. On
  Windows, the named pipe `\\.\pipe\dova-<user>`.
- **Session key.** The first message must be `hello` carrying the
  session key the daemon wrote to a 0600 file at start. That is the
  boundary on Windows, where Node can't tighten a pipe's ACL.
- **Format.** Newline-delimited JSON: `{id, method, params}` →
  `{id, result} | {id, error} | {id, event}`. Calls multiplex on one
  connection.
- **Errors** cross the socket as `{name, message, hints, exitCode}` and
  are rebuilt as the same class on the CLI side.
- **Methods:** `hello`, `ado.request`, `auth.login` (with progress
  events), `auth.status`, `auth.logout`, `daemon.status`,
  `daemon.shutdown`.
- **What it fetches.** The daemon only fetches https URLs on
  `dev.azure.com`, `*.dev.azure.com` and `*.visualstudio.com`. It
  never sends credentials anywhere else.
- **Logs** go to `daemon.log` in the state dir: method, path, status
  and duration. Never query strings, never tokens.

### Paths

| | Linux / macOS | Windows |
|---|---|---|
| credentials | `$XDG_CONFIG_HOME/dova` (`~/.config/dova`) | `%APPDATA%\dova` |
| log, session key | `$XDG_STATE_HOME/dova` (`~/.local/state/dova`) | `%LOCALAPPDATA%\dova` |

`$DOVA_HOME` puts everything under one directory.

**Proxies.** `HTTPS_PROXY` / `NO_PROXY` are honored through undici's
`ProxyAgent`, and a TLS-inspecting proxy's CA comes from
`NODE_EXTRA_CA_CERTS`. `dova daemon install` copies these into the
service definition.

## Next

- **Metadata cache in the daemon.** Teams, team area paths, current
  iteration (until its finish date), work item type states, repo
  default branch. These are GETs only, opt-in per request, and evicted
  on writes.
- **`pipeline watch` as a daemon subscription** instead of 5 s polling
  from the CLI.
- **Lazy-load command modules** to cut CLI startup below ~150 ms.
