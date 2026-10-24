import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dovaPaths, type DovaPaths } from '../lib/paths.js';
import { AuthSession, type LoginParams } from '../auth/session.js';
import { fileCredentialStore, writePrivateFile } from '../auth/store.js';
import type { AdoRequest } from '../lib/ado.js';
import { UserError } from '../lib/errors.js';
import { DOVA_VERSION } from '../lib/version.js';
import {
  buildId,
  readMessages,
  toWireError,
  writeMessage,
  type DaemonStatus,
  type HelloParams,
  type HelloResult,
  type WireRequest,
} from './protocol.js';

/* ------------------------------------------------------------------ *
 * dovad: the long-running half of dova. It holds the user's sign-in and
 * makes every Azure DevOps request on the CLI's behalf. It runs until
 * it's told to stop; there is no idle timeout.
 * ------------------------------------------------------------------ */

export interface RunDaemonOptions {
  /** Launched by the OS service manager. A service instance waits for a busy socket instead of exiting. */
  service?: boolean;
  paths?: DovaPaths;
  /** Also log to stderr (`dova daemon run` in a terminal). */
  echoLog?: boolean;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const SERVICE_RETRY_MS = 2000;

export async function runDaemon(opts: RunDaemonOptions = {}): Promise<{ close: () => Promise<void> }> {
  const paths = opts.paths ?? dovaPaths();
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(paths.socket), { recursive: true, mode: 0o700 });

  const log = openLog(paths.logFile, opts.echoLog);
  const session = new AuthSession(fileCredentialStore(paths.credentialsFile));
  const key = randomBytes(32).toString('base64url');
  const keyBuf = Buffer.from(key);
  const startedAt = new Date().toISOString();
  const build = buildId();
  let requests = 0;

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const aborter = new AbortController();
    let authenticated = false;

    socket.on('close', () => {
      sockets.delete(socket);
      // A CLI that went away (Ctrl-C mid-login) cancels what it started.
      aborter.abort();
    });
    socket.on('error', () => {
      // A client vanishing mid-write; 'close' follows.
    });

    readMessages(socket, (raw) => {
      const msg = raw as WireRequest;
      if (typeof msg?.id !== 'number' || typeof msg.method !== 'string') {
        socket.destroy();
        return;
      }
      if (!authenticated) {
        if (msg.method !== 'hello' || !keyMatches((msg.params as HelloParams | undefined)?.key)) {
          writeMessage(socket, { id: msg.id, error: toWireError(new UserError('dova daemon: bad or missing session key.')) });
          socket.end();
          return;
        }
        authenticated = true;
      }
      const respond = (result: unknown): void => writeMessage(socket, { id: msg.id, result });
      const fail = (err: unknown): void => writeMessage(socket, { id: msg.id, error: toWireError(err) });
      handle(msg, (event) => writeMessage(socket, { id: msg.id, event }), aborter.signal).then(respond, fail);
    });
  });

  function keyMatches(candidate: unknown): boolean {
    if (typeof candidate !== 'string') return false;
    const buf = Buffer.from(candidate);
    return buf.length === keyBuf.length && timingSafeEqual(buf, keyBuf);
  }

  async function handle(msg: WireRequest, emit: (event: unknown) => void, signal: AbortSignal): Promise<unknown> {
    switch (msg.method) {
      case 'hello': {
        const hello = msg.params as HelloParams;
        if (hello.build !== build) log(`client build ${hello.build} differs from daemon build ${build}`);
        return { build, pid: process.pid, startedAt } satisfies HelloResult;
      }
      case 'ado.request': {
        const req = msg.params as AdoRequest;
        const started = Date.now();
        requests++;
        try {
          const res = await session.send(req);
          log(`${req.method} ${describePath(req.url)} ${res.status} ${Date.now() - started}ms`);
          return res;
        } catch (err) {
          log(`${req.method} ${describePath(req.url)} failed: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      }
      case 'auth.login': {
        const params = msg.params as LoginParams;
        log(`auth.login (${params.method})`);
        const status = await session.login(params, emit, signal);
        log(`signed in as ${status.account?.username ?? status.account?.name ?? 'unknown'}`);
        return status;
      }
      case 'auth.status':
        return session.status();
      case 'auth.logout':
        await session.logout();
        log('signed out');
        return null;
      case 'daemon.status':
        return {
          build,
          pid: process.pid,
          startedAt,
          version: DOVA_VERSION,
          socket: paths.socket,
          logFile: paths.logFile,
          requests,
          service: Boolean(opts.service),
        } satisfies DaemonStatus;
      case 'daemon.shutdown':
        log('shutdown requested');
        // Answer first, then go — the caller is waiting to hear it worked.
        setImmediate(() => void close().then(() => process.exit(0)));
        return null;
      default:
        throw new UserError(`dova daemon: unknown method "${msg.method}".`);
    }
  }

  await listen(server, paths.socket, Boolean(opts.service), log);
  if (process.platform !== 'win32') fs.chmodSync(paths.socket, 0o600);
  await writePrivateFile(paths.keyFile, key);
  log(`dova daemon ${build} listening on ${paths.socket} (pid ${process.pid})`);

  let closing: Promise<void> | null = null;
  function close(): Promise<void> {
    closing ??= new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
      // Only remove the key if it's still ours — a replacement daemon may
      // already have written its own.
      try {
        if (fs.readFileSync(paths.keyFile, 'utf8') === key) fs.rmSync(paths.keyFile, { force: true });
      } catch {
        // Already gone.
      }
      log('stopped');
    });
    return closing;
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void close().then(() => process.exit(0)));
  }

  return { close };
}

/**
 * Binding the socket is the single-instance lock. If it's taken, either
 * a daemon is alive behind it (then this one isn't needed — unless it's
 * the service instance, which waits its turn so the OS-managed one is
 * always there to take over), or it's a dead daemon's leftover file,
 * which gets removed.
 */
async function listen(server: net.Server, socket: string, service: boolean, log: (line: string) => void): Promise<void> {
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      if (await isAlive(socket)) {
        if (!service) {
          log('another dova daemon is already running; exiting');
          process.exit(0);
        }
        await new Promise((r) => setTimeout(r, SERVICE_RETRY_MS));
        continue;
      }
      // Named pipes vanish with their process, so this is Unix-only.
      fs.rmSync(socket, { force: true });
    }
  }
}

function isAlive(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socket);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

function openLog(file: string, echo?: boolean): (line: string) => void {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.truncateSync(file, 0);
  } catch {
    // No log yet.
  }
  return (line) => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    try {
      fs.appendFileSync(file, entry, { mode: 0o600 });
    } catch {
      // Logging must never take the daemon down.
    }
    if (echo) process.stderr.write(entry);
  };
}

/** Path only — never a query string, which is where a caller might have put something sensitive. */
function describePath(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    return '(invalid url)';
  }
}
