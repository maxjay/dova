import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session, withAutoLogin, type AuthStatus, type TokenSource } from './ado/auth.js';
import type { AdoHttp, AdoRequest, AdoResponse } from './ado/http.js';
import { DovaError, ExitCode, ExternalError, NotFoundError, NotSignedInError, PrereqError, UserError } from './errors.js';
import { DOVA_VERSION } from './version.js';

/* ------------------------------------------------------------------ *
 * dovad: a long-running process holding the az token in memory, which
 * makes every Azure DevOps request for the CLI. Started by the first
 * command that needs it; runs until stopped. It speaks newline-delimited
 * JSON over a user-only Unix socket (a named pipe on Windows):
 *
 *   → { id, method, params }      ← { id, result } | { id, error }
 *
 * The first call must be `hello` with the key the daemon wrote to a
 * user-only file — the boundary on Windows, whose pipes Node can't lock
 * down. A daemon from another build of dova is replaced.
 * ------------------------------------------------------------------ */

export interface Paths {
  dir: string;
  socket: string;
  key: string;
  log: string;
}

export function daemonPaths(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Paths {
  const dir =
    env.DOVA_HOME ??
    (platform === 'win32'
      ? path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'dova')
      : path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'dova'));
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 12);
  let socket = path.join(env.XDG_RUNTIME_DIR && !env.DOVA_HOME ? path.join(env.XDG_RUNTIME_DIR, 'dova') : dir, 'dovad.sock');
  if (platform === 'win32') socket = `\\\\.\\pipe\\dova-${os.userInfo().username}-${hash}`;
  // Unix socket paths max out around 104 bytes; a deep home goes past that.
  else if (Buffer.byteLength(socket) > 100) socket = path.join('/tmp', `dova-${process.getuid?.()}-${hash}`, 'dovad.sock');
  return { dir, socket, key: path.join(dir, 'daemon.key'), log: path.join(dir, 'daemon.log') };
}

/** Version plus bundle mtime, so a rebuild counts as a different build too. */
export function buildId(): string {
  try {
    return `${DOVA_VERSION}+${Math.floor(fs.statSync(fileURLToPath(import.meta.url)).mtimeMs)}`;
  } catch {
    return DOVA_VERSION;
  }
}

/* ---------------- wire ---------------- */

interface WireError {
  name: string;
  message: string;
  hints: string[];
  exitCode: number;
  tenant?: string;
}

function toWire(err: unknown): WireError {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    name: e.name,
    message: e.message,
    hints: e instanceof DovaError ? e.hints : [],
    exitCode: e instanceof DovaError ? e.exitCode : ExitCode.Unexpected,
    tenant: e instanceof NotSignedInError ? e.tenant : undefined,
  };
}

/** The same error class on the CLI side, so exit codes and `instanceof` work as if thrown locally. */
export function fromWire(w: WireError): Error {
  const classes: Record<string, new (m: string, h: string[]) => Error> = { UserError, NotFoundError, PrereqError, ExternalError };
  if (w.name === 'NotSignedInError') return new NotSignedInError(w.message, w.tenant);
  if (classes[w.name]) return new classes[w.name]!(w.message, w.hints);
  return w.exitCode === ExitCode.Unexpected ? new Error(w.message) : new DovaError(w.message, w.exitCode, w.hints);
}

function onMessages(socket: net.Socket, handle: (msg: Record<string, unknown>) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        if (line.trim()) handle(JSON.parse(line));
      } catch {
        socket.destroy();
      }
    }
  });
}

const send = (socket: net.Socket, msg: unknown) => socket.destroyed || socket.write(`${JSON.stringify(msg)}\n`);

/* ---------------- server ---------------- */

export interface DaemonStatus {
  pid: number;
  build: string;
  startedAt: string;
  requests: number;
  socket: string;
  log: string;
}

export async function serve(opts: { paths?: Paths; tokenSource?: TokenSource; echo?: boolean } = {}): Promise<{ close(): void }> {
  const paths = opts.paths ?? daemonPaths();
  for (const dir of [paths.dir, path.dirname(paths.socket)]) {
    if (process.platform === 'win32') break;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    // In a shared /tmp, someone else could have made it first.
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new PrereqError(`${dir} is not a directory of yours.`);
    if (stat.mode & 0o077) fs.chmodSync(dir, 0o700);
  }
  const log = (line: string) => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    fs.appendFileSync(paths.log, entry, { mode: 0o600 });
    if (opts.echo) process.stderr.write(entry);
  };
  const session = new Session(opts.tokenSource);
  const key = Buffer.from(randomBytes(32).toString('base64url'));
  const status: DaemonStatus = { pid: process.pid, build: buildId(), startedAt: new Date().toISOString(), requests: 0, socket: paths.socket, log: paths.log };

  const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
    'ado.request': async (params) => {
      const req = params as AdoRequest;
      const started = Date.now();
      status.requests++;
      const res = await session.send(req).catch((err) => {
        log(`${req.method} ${new URL(req.url).pathname} failed: ${(err as Error).message}`);
        throw err;
      });
      log(`${req.method} ${new URL(req.url).pathname} ${res.status} ${Date.now() - started}ms`); // never the query string
      return res;
    },
    'auth.status': () => session.status(),
    'daemon.status': async () => status,
    'daemon.stop': async () => void setImmediate(() => process.exit(0)),
  };

  const server = net.createServer((socket) => {
    let trusted = false;
    socket.on('error', () => {});
    onMessages(socket, ({ id, method, params }) => {
      if (!trusted) {
        const offered = Buffer.from(String((params as { key?: string })?.key ?? ''));
        trusted = method === 'hello' && offered.length === key.length && timingSafeEqual(offered, key);
        send(socket, trusted ? { id, result: status } : { id, error: toWire(new PrereqError('dova daemon: bad session key.')) });
        if (!trusted) socket.end();
        return;
      }
      const handler = handlers[String(method)];
      (handler ? handler(params) : Promise.reject(new UserError(`Unknown method ${method}`))).then(
        (result) => send(socket, { id, result }),
        (err) => send(socket, { id, error: toWire(err) })
      );
    });
  });

  // Binding the socket is the single-instance lock.
  await new Promise<void>((resolve, reject) => {
    const listen = (retry: boolean) =>
      server.once('error', async (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EADDRINUSE' || !retry) return reject(err);
        if (await reachable(paths.socket)) return reject(new PrereqError('Another dova daemon is already running.'));
        fs.rmSync(paths.socket, { force: true }); // a dead daemon's leftover
        listen(false);
      }).listen(paths.socket, () => resolve());
    listen(true);
  });
  if (process.platform !== 'win32') fs.chmodSync(paths.socket, 0o600);
  fs.writeFileSync(paths.key, key, { mode: 0o600 });
  log(`dova daemon ${status.build} listening on ${paths.socket}`);
  const close = () => {
    server.close();
    if (fs.existsSync(paths.key) && fs.readFileSync(paths.key).equals(key)) fs.rmSync(paths.key);
  };
  process.once('SIGTERM', () => (close(), process.exit(0)));
  process.once('SIGINT', () => (close(), process.exit(0)));
  return { close };
}

function reachable(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socket, () => (probe.destroy(), resolve(true)));
    probe.on('error', () => resolve(false));
  });
}

/* ---------------- client ---------------- */

export class DaemonClient {
  private next = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  private constructor(private readonly socket: net.Socket) {
    onMessages(socket, (msg) => {
      const call = this.pending.get(msg.id as number);
      if (!call) return;
      this.pending.delete(msg.id as number);
      if (this.pending.size === 0) socket.unref();
      if (msg.error) call.reject(fromWire(msg.error as WireError));
      else call.resolve(msg.result);
    });
    socket.on('close', () => {
      for (const call of this.pending.values()) call.reject(new PrereqError('Lost the connection to the dova daemon.', ['Check: dova daemon status']));
      this.pending.clear();
    });
    socket.on('error', () => {});
    socket.unref(); // never keep the CLI alive while idle
  }

  /** Null when nothing is listening. */
  static async open(paths: Paths): Promise<{ client: DaemonClient; status: DaemonStatus } | null> {
    const socket = await new Promise<net.Socket | null>((resolve) => {
      const s = net.connect(paths.socket, () => resolve(s));
      s.on('error', () => resolve(null));
    });
    if (!socket) return null;
    const client = new DaemonClient(socket);
    let key = '';
    try {
      key = fs.readFileSync(paths.key, 'utf8');
    } catch {
      // a daemon that hasn't written it yet
    }
    try {
      return { client, status: (await client.call('hello', { key })) as DaemonStatus };
    } catch {
      client.close();
      return null;
    }
  }

  call(method: string, params?: unknown): Promise<unknown> {
    const id = this.next++;
    this.socket.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      send(this.socket, { id, method, params });
    });
  }

  close(): void {
    this.socket.end();
  }
}

/** The running daemon, started — or replaced, if it's from another build — as needed. */
export async function connect(paths = daemonPaths()): Promise<DaemonClient> {
  const existing = await DaemonClient.open(paths);
  if (existing?.status.build === buildId()) return existing.client;
  if (existing) {
    await existing.client.call('daemon.stop').catch(() => {});
    await waitFor(async () => !(await reachable(paths.socket)));
  }
  const entry = process.argv[1];
  if (!entry) throw new PrereqError('Cannot tell how dova was started, so cannot start its daemon.');
  spawn(process.execPath, [...process.execArgv, entry, 'daemon', 'run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  let opened: Awaited<ReturnType<typeof DaemonClient.open>> = null;
  await waitFor(async () => (opened = await DaemonClient.open(paths)) !== null);
  if (!opened) throw new PrereqError('Could not start the dova daemon.', [`See ${paths.log}`, 'Or skip it: DOVA_NO_DAEMON=1']);
  return (opened as { client: DaemonClient }).client;
}

async function waitFor(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((r) => setTimeout(r, 40))) {
    if (await check()) return;
  }
}

/* ---------------- transport ---------------- */

export interface Transport {
  kind: 'daemon' | 'in-process';
  http: AdoHttp;
  status(): Promise<AuthStatus>;
}

/** Through the daemon; or, with DOVA_NO_DAEMON=1, from this process with a fresh az token every command. */
export function createTransport(env: NodeJS.ProcessEnv, interactive: boolean): Transport {
  if (env.DOVA_NO_DAEMON && env.DOVA_NO_DAEMON !== '0') {
    const session = new Session();
    return { kind: 'in-process', http: withAutoLogin(session.send, interactive), status: () => session.status() };
  }
  let client: Promise<DaemonClient> | null = null;
  const daemon = () => (client ??= connect().catch((err) => ((client = null), Promise.reject(err))));
  return {
    kind: 'daemon',
    http: withAutoLogin(async (req) => (await daemon()).call('ado.request', req) as Promise<AdoResponse>, interactive),
    status: async () => (await daemon()).call('auth.status') as Promise<AuthStatus>,
  };
}
