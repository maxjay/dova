# Design: dova as a daemon

Status: **implemented**, except the items under [Next](#next).

## Why

dova used to make every Azure DevOps call by spawning `az`. Each call
started a Python CLI and its `azure-devops` extension, which cost about
a second before any network traffic (more on Windows), and one command
made several: `dova status` made up to six. dova's own startup is
~150 ms.

`az` also brought a pile of workarounds that had nothing to do with
Azure DevOps: temp-file arguments to survive `cmd.exe`, ASCII-escaping
around az's Latin-1 bug, Python encoding variables, and guessing
failures from stderr. All of that is gone.

Now:

1. dova calls the **Azure DevOps REST API** directly with `fetch`.
2. A **long-running daemon (`dovad`)** gets a token from `az` once,
   holds it in memory, and makes every request on the CLI's behalf
   over warm connections. `az` runs about once an hour instead of on
   every call.

## Shape

```
┌───────────── dova (CLI) ─────────────┐   socket    ┌──────────────── dovad ────────────────┐
│ commands, prompts, rendering, --json │  (ndjson)   │ token from `az account                │
│ git, in the user's working tree      │ ◄─────────► │   get-access-token`, held in memory   │
│ context resolution                   │             │ fetch → dev.azure.com only            │
│ Runner.ado → transport               │             │                                       │
└──────────────────────────────────────┘             └───────────────────────────────────────┘
```

The daemon is **thin**: it is an authenticated Azure DevOps gateway,
not a command runner. Command logic, git, interactive prompts, stdin
and rendering all stay in the CLI process.

### The seam

`Runner` is `{ git(args), ado(req) }`. Every lib function builds
requests with `adoUrl` and reads them through `adoJson` / `adoText`
(`src/lib/ado.ts`). These map HTTP statuses to dova's errors:

- 401 or 203 → `PrereqError` with the hint "dova auth login"
- 404 → `NotFoundError`, carrying the service's message
- anything else → `ExternalCommandError`

`Runner.ado` hands the request to the daemon by default. With
`DOVA_NO_DAEMON=1`, the CLI process sends it itself.

## Authentication

Authentication is unchanged from before: **the Azure CLI's login**.

The daemon runs `az account get-access-token --resource 499b84ac-…`
(Azure DevOps' resource id) once, keeps the token in memory, and runs
it again:

- five minutes before the token expires, or
- when Azure DevOps rejects the token.

Concurrent requests share one `az` run. Nothing is written to disk.

- `dova auth login` runs `az login`, passing `--tenant` and
  `--use-device-code` through. It then tells the daemon to drop its
  cached token, so the new account takes effect immediately.
- `dova auth status` shows the account and tenant from the token's
  claims, when the token expires, and whether the current repo's org
  accepts it.

The azure-devops `az` extension is no longer needed, only core `az`.

## Daemon

- **Always running.** There is no idle timeout. The CLI starts the
  daemon if it isn't up. `dova daemon install` registers a login
  service that brings it back if it dies:
  - Linux: a systemd user unit with `Restart=always`
  - macOS: a launchd agent with `KeepAlive`
  - Windows: a hidden launcher in the Startup folder
- **Single instance.** Binding the socket is the lock. A service
  instance (`--service`) that finds the socket busy waits its turn
  instead of exiting.
- **Upgrades.** `hello` carries a build id (version + bundle mtime).
  If the daemon is from another build, the CLI tells it to exit and
  starts a fresh one; a service restarts itself.
- **Commands:** `dova daemon start | stop | restart | status | run |
  install | uninstall`.

### IPC

- **Transport.** A Unix socket, mode 0600 in a 0700 directory
  (`$XDG_RUNTIME_DIR/dova/`, otherwise `~/.local/state/dova/`). On
  Windows, the named pipe `\\.\pipe\dova-<user>`.
- **Session key.** The first message must be `hello` carrying the
  session key the daemon wrote to a 0600 file at start. That is the
  boundary on Windows, where Node can't tighten a pipe's ACL.
- **Format.** Newline-delimited JSON: `{id, method, params}` →
  `{id, result} | {id, error}`. Calls multiplex on one connection.
- **Errors** cross the socket as `{name, message, hints, exitCode}` and
  are rebuilt as the same class on the CLI side.
- **Methods:** `hello`, `ado.request`, `auth.status`, `auth.reset`,
  `daemon.status`, `daemon.shutdown`.
- **What it fetches.** The daemon only fetches https URLs on
  `dev.azure.com`, `*.dev.azure.com` and `*.visualstudio.com`. It
  never sends the token anywhere else.
- **Logs** go to `~/.local/state/dova/daemon.log` (on Windows,
  `%LOCALAPPDATA%\dova`): method, path, status and duration. Never
  query strings, never tokens.
- **`$DOVA_HOME`** puts the socket, key and log under one directory.

**Proxies.** `HTTPS_PROXY` / `NO_PROXY` are honored through undici's
`ProxyAgent`, and a TLS-inspecting proxy's CA comes from
`NODE_EXTRA_CA_CERTS`. `dova daemon install` copies these into the
service definition, along with `PATH` and `AZURE_CONFIG_DIR` so the
service can find and run `az`.

## Next

- **Metadata cache in the daemon.** Teams, team area paths, current
  iteration, work item type states, and the repo's default branch.
- **`pipeline watch` as a daemon subscription** instead of 5 s polling
  from the CLI.
- **Lazy-load command modules** to cut CLI startup below ~150 ms.
