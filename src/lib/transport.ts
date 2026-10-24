import type { AdoRequest, AdoResponse } from './ado.js';
import { AuthSession, type AuthStatus } from '../auth/session.js';
import { connectDaemon, type DaemonConnection } from '../daemon/client.js';

/* ------------------------------------------------------------------ *
 * Who actually sends a request:
 *
 *   - the daemon (default): one long-lived process holding the az token
 *     in memory, started on first use;
 *   - this process, with `DOVA_NO_DAEMON=1`: asks az for a token every
 *     command — slow, but nothing left running (CI, debugging the
 *     daemon itself).
 * ------------------------------------------------------------------ */

export interface AuthClient {
  status(): Promise<AuthStatus>;
  /** Drop the cached token, so the next request asks az again. */
  reset(): Promise<void>;
}

export interface Transport {
  send(req: AdoRequest): Promise<AdoResponse>;
  auth: AuthClient;
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

function inProcessTransport(): Transport {
  const session = new AuthSession();
  return {
    kind: 'in-process',
    send: (req) => session.send(req),
    auth: {
      status: () => session.status(),
      reset: async () => session.reset(),
    },
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
    send: async (req) => (await conn()).call('ado.request', req) as Promise<AdoResponse>,
    auth: {
      status: async () => (await conn()).call('auth.status') as Promise<AuthStatus>,
      reset: async () => {
        await (await conn()).call('auth.reset');
      },
    },
  };
}
