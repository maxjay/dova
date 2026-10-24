import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Where dova keeps its own files. Nothing repo-specific lives here —
 * that's still git config (see config.ts). This is the daemon's socket,
 * its session key, and its log.
 *
 * `$DOVA_HOME` puts all of it under one directory, which is what tests
 * and side-by-side installs use.
 * ------------------------------------------------------------------ */

export interface DovaPaths {
  /** Logs and the daemon's session key. */
  stateDir: string;
  /** What the CLI connects to: a Unix socket path, or a Windows named pipe name. */
  socket: string;
  /** The secret every client presents in `hello` — see daemon/protocol.ts. */
  keyFile: string;
  logFile: string;
}

export function dovaPaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): DovaPaths {
  const home = os.homedir();
  let stateDir: string;
  let runtimeDir: string;

  if (env.DOVA_HOME) {
    stateDir = runtimeDir = env.DOVA_HOME;
  } else if (platform === 'win32') {
    stateDir = runtimeDir = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'dova');
  } else {
    stateDir = path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'dova');
    // $XDG_RUNTIME_DIR is per-user, 0700, and cleared at logout — exactly
    // what a socket wants. Without it, the state dir (created 0700 by us).
    runtimeDir = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'dova') : stateDir;
  }

  // A named pipe lives in its own namespace, not on disk. Scoped by user
  // name so two people on one machine get two daemons — the session key
  // is what actually keeps them out of each other's.
  let socket: string;
  if (platform === 'win32') {
    socket = `\\\\.\\pipe\\dova-${safeUserName()}${env.DOVA_HOME ? `-${shortHash(env.DOVA_HOME)}` : ''}`;
  } else {
    socket = path.join(runtimeDir, 'dovad.sock');
    // A Unix socket path can't be longer than ~104 bytes (macOS) / 108
    // (Linux); a deep home directory goes past that. Then it lives in a
    // short per-user directory instead, the way tmux's does — see
    // `ensureSocketDir` for why that's safe in a shared /tmp.
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
      socket = path.join(SHORT_SOCKET_ROOT, `dova-${process.getuid?.() ?? safeUserName()}-${shortHash(runtimeDir)}`, 'dovad.sock');
    }
  }

  return {
    stateDir,
    socket,
    keyFile: path.join(stateDir, 'daemon.key'),
    logFile: path.join(stateDir, 'daemon.log'),
  };
}

const MAX_SOCKET_PATH = 100;
const SHORT_SOCKET_ROOT = '/tmp';

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Creates the socket's directory, 0700, and refuses one that isn't ours:
 * in a shared /tmp another user could have made it first to intercept
 * the socket.
 */
export function ensureSocketDir(socket: string): void {
  const dir = path.dirname(socket);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a private directory owned by you; refusing to put dova's socket there.`);
  }
}

function safeUserName(): string {
  try {
    return os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '_');
  } catch {
    return 'user';
  }
}
