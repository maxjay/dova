import type { AdoRequest, AdoResponse } from './ado.js';
import { dovaPaths } from './paths.js';
import { AuthSession, type AuthStatus, type LoginEvent, type LoginParams } from '../auth/session.js';
import { fileCredentialStore, memoryCredentialStore } from '../auth/store.js';
import { connectDaemon, type DaemonConnection } from '../daemon/client.js';

/* ------------------------------------------------------------------ *
 * Who actually sends a request, and holds the sign-in:
 *
 *   - the daemon (default): one long-lived process with the token in
 *     memory and warm connections, started on first use;
 *   - this process, with `DOVA_NO_DAEMON=1`: same sign-in, read from
 *     the store and refreshed for every command — slower, but nothing
 *     left running (CI, debugging the daemon itself);
 *   - this process, with `DOVA_TOKEN=<pat>`: a PAT from the
 *     environment, nothing stored, nothing started.
 * ------------------------------------------------------------------ */

export interface AuthClient {
  login(params: LoginParams, onEvent: (event: LoginEvent) => void): Promise<AuthStatus>;
  status(): Promise<AuthStatus>;
  logout(): Promise<void>;
}

export interface Transport {
  send(req: AdoRequest): Promise<AdoResponse>;
  auth: AuthClient;
  /** Whether this goes through the daemon — for `dova auth status`. */
  kind: 'daemon' | 'in-process';
}

export function usingDaemon(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.DOVA_TOKEN && !isTruthy(env.DOVA_NO_DAEMON);
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

let cached: Transport | null = null;

/** The transport for this process, created on first use. */
export function defaultTransport(): Transport {
  cached ??= usingDaemon() ? daemonTransport() : inProcessTransport();
  return cached;
}

function inProcessTransport(): Transport {
  const pat = process.env.DOVA_TOKEN;
  const session = pat
    ? new AuthSession(memoryCredentialStore({ kind: 'pat', token: pat, account: {} }), { fromEnvironment: true })
    : new AuthSession(fileCredentialStore(dovaPaths().credentialsFile));
  // Ctrl-C ends the whole process, login included; nothing to cancel separately.
  const never = new AbortController().signal;
  return {
    kind: 'in-process',
    send: (req) => session.send(req),
    auth: {
      login: (params, onEvent) => session.login(params, onEvent, never),
      status: () => session.status(),
      logout: () => session.logout(),
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
      login: async (params, onEvent) =>
        (await conn()).call('auth.login', params, (event) => onEvent(event as LoginEvent)) as Promise<AuthStatus>,
      status: async () => (await conn()).call('auth.status') as Promise<AuthStatus>,
      logout: async () => {
        await (await conn()).call('auth.logout');
      },
    },
  };
}
