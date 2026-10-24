import { createHash } from 'node:crypto';
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
  const socket =
    platform === 'win32'
      ? `\\\\.\\pipe\\dova-${safeUserName()}${env.DOVA_HOME ? `-${createHash('sha256').update(env.DOVA_HOME).digest('hex').slice(0, 12)}` : ''}`
      : path.join(runtimeDir, 'dovad.sock');

  return {
    stateDir,
    socket,
    keyFile: path.join(stateDir, 'daemon.key'),
    logFile: path.join(stateDir, 'daemon.log'),
  };
}

function safeUserName(): string {
  try {
    return os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '_');
  } catch {
    return 'user';
  }
}
