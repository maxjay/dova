import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { dovaPaths, type DovaPaths } from '../lib/paths.js';
import { PrereqError } from '../lib/errors.js';
import { buildId, fromWireError, readMessages, writeMessage, type HelloResult, type WireResponse } from './protocol.js';

/* ------------------------------------------------------------------ *
 * The CLI's end of the daemon socket. `connectDaemon()` is all a command
 * ever calls: it finds the running daemon, starts one if there isn't,
 * and replaces it if it's from a different build of dova.
 * ------------------------------------------------------------------ */

const START_TIMEOUT_MS = 5000;
const POLL_MS = 40;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onEvent?: (event: unknown) => void;
}

export class DaemonConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedError: Error | null = null;

  private constructor(private readonly socket: net.Socket) {
    readMessages(socket, (raw) => {
      const msg = raw as WireResponse;
      const call = this.pending.get(msg.id);
      if (!call) return;
      if ('event' in msg) {
        call.onEvent?.(msg.event);
        return;
      }
      this.pending.delete(msg.id);
      this.updateRef();
      if ('error' in msg) call.reject(fromWireError(msg.error));
      else call.resolve(msg.result);
    });
    socket.on('close', () => {
      this.closedError = new PrereqError('Lost the connection to the dova daemon.', ['Check: dova daemon status']);
      for (const call of this.pending.values()) call.reject(this.closedError);
      this.pending.clear();
    });
    socket.on('error', () => {
      // 'close' follows and fails whatever was in flight.
    });
    // Don't hold the CLI open while nothing is in flight.
    socket.unref();
  }

  /** Connects and says hello. Rejects with the raw socket error when nothing is listening. */
  static async open(paths: DovaPaths): Promise<{ connection: DaemonConnection; hello: HelloResult }> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(paths.socket);
      s.once('connect', () => {
        s.removeListener('error', reject);
        resolve(s);
      });
      s.once('error', reject);
    });
    const connection = new DaemonConnection(socket);
    try {
      const hello = (await connection.call('hello', { key: readKey(paths), build: buildId() })) as HelloResult;
      return { connection, hello };
    } catch (err) {
      connection.close();
      throw err;
    }
  }

  call(method: string, params?: unknown, onEvent?: (event: unknown) => void): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
      this.updateRef();
      writeMessage(this.socket, { id, method, params });
    });
  }

  close(): void {
    this.socket.end();
  }

  private updateRef(): void {
    if (this.pending.size > 0) this.socket.ref();
    else this.socket.unref();
  }
}

function readKey(paths: DovaPaths): string {
  try {
    return fs.readFileSync(paths.keyFile, 'utf8').trim();
  } catch {
    return '';
  }
}

export interface ConnectOptions {
  paths?: DovaPaths;
  /** Start a daemon if none is running (default true). */
  autoStart?: boolean;
}

/**
 * The connection every command uses. In order:
 *   1. connect to the running daemon;
 *   2. if it's from another build (dova was upgraded or rebuilt since it
 *      started), ask it to exit and fall through;
 *   3. start one, and wait for it to answer.
 */
export async function connectDaemon(opts: ConnectOptions = {}): Promise<DaemonConnection> {
  const paths = opts.paths ?? dovaPaths();
  const autoStart = opts.autoStart ?? true;

  const existing = await tryOpen(paths);
  if (existing) {
    if (existing.hello.build === buildId()) return existing.connection;
    await existing.connection.call('daemon.shutdown').catch(() => {});
    existing.connection.close();
    await waitUntil(async () => !(await isListening(paths)), START_TIMEOUT_MS);
  }

  if (!autoStart) {
    throw new PrereqError('The dova daemon is not running.', ['Start it: dova daemon start']);
  }

  // An OS-managed daemon (see `dova daemon install`) may be coming back
  // on its own right now; starting another is harmless either way —
  // binding the socket decides which one stays.
  spawnDaemon();
  let opened: Awaited<ReturnType<typeof tryOpen>> = null;
  await waitUntil(async () => {
    opened = await tryOpen(paths);
    return opened !== null && opened.hello.build === buildId();
  }, START_TIMEOUT_MS);
  if (!opened) {
    throw new PrereqError('Could not start the dova daemon.', [
      `See its log: ${paths.logFile}`,
      'Or bypass it for now: DOVA_NO_DAEMON=1',
    ]);
  }
  return (opened as { connection: DaemonConnection }).connection;
}

/** Null when nothing answers; rethrows anything else (a bad session key is a real problem, not "not running"). */
async function tryOpen(paths: DovaPaths): Promise<{ connection: DaemonConnection; hello: HelloResult } | null> {
  try {
    return await DaemonConnection.open(paths);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'ECONNRESET') return null;
    // Connected, but the daemon rejected the key: it has only just
    // started and hasn't written its key yet, or it's a stale socket.
    // Either way, not usable right now.
    if (err instanceof Error && /session key/.test(err.message)) return null;
    if (err instanceof PrereqError) return null;
    throw err;
  }
}

async function isListening(paths: DovaPaths): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(paths.socket);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** The command line that runs the daemon from this same install of dova. */
export function daemonCommand(): { command: string; args: string[] } {
  const entry = process.argv[1];
  if (!entry) throw new PrereqError('Cannot tell how dova was launched, so cannot start its daemon.');
  // execArgv carries a dev loader (tsx) through when there is one.
  return { command: process.execPath, args: [...process.execArgv, entry, 'daemon', 'run'] };
}

export function spawnDaemon(): void {
  const { command, args } = daemonCommand();
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
