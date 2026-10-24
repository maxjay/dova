import type { AdoRequest, AdoResponse } from './ado.js';
import { NotSignedInError } from './errors.js';
import { isInteractive } from './interactive.js';
import { AuthSession, runAzLogin, type AuthStatus } from '../auth/session.js';
import { connectDaemon, type DaemonConnection } from '../daemon/client.js';

/* ------------------------------------------------------------------ *
 * Who actually sends a request:
 *
 *   - the daemon (default): one long-lived process holding the az token
 *     in memory, started on first use;
 *   - this process, with `DOVA_NO_DAEMON=1`: asks az for a token every
 *     command — slow, but nothing left running (CI, debugging the
 *     daemon itself).
 *
 * Either way, a command that finds az not logged in, in a terminal,
 * runs `az login` right there and carries on — nobody has to stop and
 * sign in first.
 * ------------------------------------------------------------------ */

export interface Transport {
  send(req: AdoRequest): Promise<AdoResponse>;
  status(): Promise<AuthStatus>;
  kind: 'daemon' | 'in-process';
}

export function usingDaemon(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DOVA_NO_DAEMON;
  return value === undefined || value === '' || value === '0' || value.toLowerCase() === 'false';
}

let cached: Transport | null = null;

/** The transport for this process, created on first use. */
export function defaultTransport(): Transport {
  cached ??= usingDaemon() ? daemonTransport() : inProcessTransport();
  return cached;
}

/**
 * Wraps `send` so a NotSignedInError becomes one `az login` (per tenant,
 * per process — concurrent requests share it) and a retry. Without a
 * terminal there's nobody to sign in, so the error goes out as-is.
 */
export function withAutoLogin(
  send: (req: AdoRequest) => Promise<AdoResponse>,
  opts: { interactive?: () => boolean; login?: (tenant?: string) => Promise<void> } = {}
): (req: AdoRequest) => Promise<AdoResponse> {
  const interactive = opts.interactive ?? isInteractive;
  const login = opts.login ?? runAzLogin;
  const logins = new Map<string, Promise<void>>();
  return async (req) => {
    // A login can uncover the next one: signed in at last, the org turns
    // out to live in another tenant. Each tenant gets one login at most,
    // so this ends.
    const tried = new Set<string>();
    for (;;) {
      try {
        return await send(req);
      } catch (err) {
        if (!(err instanceof NotSignedInError) || !interactive()) throw err;
        const key = err.tenant ?? '';
        if (tried.has(key)) throw err;
        tried.add(key);
        let pending = logins.get(key);
        if (!pending) {
          pending = login(err.tenant);
          logins.set(key, pending);
        }
        await pending;
      }
    }
  };
}

function inProcessTransport(): Transport {
  const session = new AuthSession();
  return {
    kind: 'in-process',
    send: withAutoLogin((req) => session.send(req)),
    status: () => session.status(),
  };
}

function daemonTransport(): Transport {
  let connection: Promise<DaemonConnection> | null = null;
  const conn = (): Promise<DaemonConnection> => {
    connection ??= connectDaemon();
    // A failed connect isn't cached: the next call tries again.
    connection.catch(() => {
      connection = null;
    });
    return connection;
  };
  return {
    kind: 'daemon',
    send: withAutoLogin(async (req) => (await conn()).call('ado.request', req) as Promise<AdoResponse>),
    status: async () => (await conn()).call('auth.status') as Promise<AuthStatus>,
  };
}
