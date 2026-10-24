import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { PrereqError, UserError } from '../lib/errors.js';

/* ------------------------------------------------------------------ *
 * Signing in to Microsoft Entra ID as the user, for Azure DevOps.
 *
 * Plain OAuth 2.0 against the v2 endpoints — no SDK. Three grants:
 *   - authorization code + PKCE, redirected to a loopback listener (the
 *     default: a browser tab, the user signs in, done)
 *   - device code (SSH sessions, no browser on this machine)
 *   - refresh token (everything after that, silently, in the daemon)
 *
 * The token is the user's own, for the Azure DevOps resource only.
 * ------------------------------------------------------------------ */

/** Azure DevOps' resource id. Every token dova asks for is for this audience. */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const SCOPE = `${AZURE_DEVOPS_RESOURCE}/.default offline_access openid profile`;

/**
 * The OAuth client dova presents. Defaults to the Azure CLI's public
 * client, which every Entra tenant already trusts for Azure DevOps, so
 * signing in needs no app registration and no admin consent. An org
 * that wants its own registration sets $DOVA_CLIENT_ID.
 */
export const DEFAULT_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

export function clientId(): string {
  return process.env.DOVA_CLIENT_ID || DEFAULT_CLIENT_ID;
}

/** Any work or school account; a specific tenant id/domain narrows it. */
export const DEFAULT_TENANT = 'organizations';

const AUTHORITY_HOST = 'https://login.microsoftonline.com';

export interface TokenSet {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  refreshToken?: string;
  idToken?: string;
}

/** An error the token endpoint returned, e.g. `invalid_grant`. */
export class OAuthError extends Error {
  constructor(readonly code: string, readonly description: string) {
    super(`${code}: ${description.split('\r\n')[0]}`);
    this.name = 'OAuthError';
  }
}

async function tokenRequest(tenant: string, params: Record<string, string>, signal?: AbortSignal): Promise<TokenSet> {
  const res = await fetch(`${AUTHORITY_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), ...params }),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== 'string') {
    throw new OAuthError(String(data.error ?? `http_${res.status}`), String(data.error_description ?? ''));
  }
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    idToken: typeof data.id_token === 'string' ? data.id_token : undefined,
  };
}

export function refreshAccessToken(tenant: string, refreshToken: string, signal?: AbortSignal): Promise<TokenSet> {
  return tokenRequest(tenant, { grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPE }, signal);
}

/* ------------------------------------------------------------------ *
 * Device code.
 * ------------------------------------------------------------------ */

export interface DeviceCodePrompt {
  /** Entra's own ready-to-print instruction, naming the URL and the code. */
  message: string;
  verificationUri: string;
  userCode: string;
}

export async function deviceCodeLogin(
  tenant: string,
  onPrompt: (prompt: DeviceCodePrompt) => void,
  signal: AbortSignal
): Promise<TokenSet> {
  const res = await fetch(`${AUTHORITY_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), scope: SCOPE }),
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.device_code !== 'string') {
    throw new OAuthError(String(data.error ?? `http_${res.status}`), String(data.error_description ?? ''));
  }
  onPrompt({
    message: String(data.message),
    verificationUri: String(data.verification_uri),
    userCode: String(data.user_code),
  });

  let interval = Number(data.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(data.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval, signal);
    try {
      return await tokenRequest(
        tenant,
        { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: data.device_code },
        signal
      );
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      if (err.code === 'authorization_pending') continue;
      if (err.code === 'slow_down') {
        interval += 5000;
        continue;
      }
      throw err;
    }
  }
  throw new UserError('The sign-in code expired before it was used.', ['Run `dova auth login` again.']);
}

/* ------------------------------------------------------------------ *
 * Browser: authorization code + PKCE, redirected to a loopback listener.
 * ------------------------------------------------------------------ */

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export async function browserLogin(tenant: string, onOpenUrl: (url: string) => void, signal: AbortSignal): Promise<TokenSet> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  const { port, code, close } = await listenForRedirect(state, signal);
  const redirectUri = `http://localhost:${port}`;
  try {
    const authorize = new URL(`${AUTHORITY_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`);
    authorize.search = new URLSearchParams({
      client_id: clientId(),
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    onOpenUrl(authorize.toString());

    return await tokenRequest(
      tenant,
      { grant_type: 'authorization_code', code: await code, redirect_uri: redirectUri, code_verifier: verifier, scope: SCOPE },
      signal
    );
  } finally {
    close();
  }
}

/**
 * Listens on 127.0.0.1 and ::1 at the same port, since `localhost` may
 * resolve to either in the browser. Resolves `code` with the first
 * redirect that carries our `state`.
 */
async function listenForRedirect(
  state: string,
  signal: AbortSignal
): Promise<{ port: number; code: Promise<string>; close: () => void }> {
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller always awaits `code`, but a rejection that lands before it
  // gets there must not count as unhandled.
  code.catch(() => {});

  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('state') !== state) {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const value = url.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      error
        ? `<p>Sign-in failed: ${escapeHtml(url.searchParams.get('error_description') ?? error)}</p>`
        : '<p>Signed in to dova. You can close this tab.</p>'
    );
    if (error) settle.reject(new OAuthError(error, url.searchParams.get('error_description') ?? ''));
    else if (value) settle.resolve(value);
  };

  const v4 = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    v4.once('error', reject);
    v4.listen(0, '127.0.0.1', resolve);
  });
  const port = (v4.address() as AddressInfo).port;
  const v6 = http.createServer(handler);
  v6.on('error', () => {
    // No IPv6 loopback on this machine — the browser will use 127.0.0.1.
  });
  v6.listen(port, '::1');

  const timer = setTimeout(() => settle.reject(new UserError('Timed out waiting for the browser sign-in.')), LOGIN_TIMEOUT_MS);
  const onAbort = (): void => settle.reject(new UserError('Sign-in was cancelled.'));
  signal.addEventListener('abort', onAbort, { once: true });

  return {
    port,
    code,
    close: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      v4.close();
      v6.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Helpers.
 * ------------------------------------------------------------------ */

export interface IdTokenClaims {
  username?: string;
  name?: string;
  tenantId?: string;
  objectId?: string;
}

/** Reads (does not verify) a JWT's claims. Only ever used on tokens dova just received from Entra over TLS, for display. */
export function readIdToken(jwt: string | undefined): IdTokenClaims {
  if (!jwt) return {};
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    return {
      username: str(payload.preferred_username) ?? str(payload.upn) ?? str(payload.email),
      name: str(payload.name),
      tenantId: str(payload.tid),
      objectId: str(payload.oid),
    };
  } catch {
    return {};
  }
}

const NO_TENANT = '00000000-0000-0000-0000-000000000000';

/**
 * The Entra tenant an organization is backed by. Azure DevOps names it in
 * the `X-VSS-ResourceTenant` header of any unauthenticated request, so a
 * user who's a guest in another company's tenant gets a token for the
 * right one without having to know its id. Null when the org doesn't say
 * (or is backed by Microsoft accounts rather than a tenant).
 */
export async function discoverOrgTenant(orgUrl: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(`${orgUrl}/_apis/connectionData`, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'X-TFS-FedAuthRedirect': 'Suppress' },
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    const tenant = res.headers.get('x-vss-resourcetenant')?.split(',')[0]?.trim();
    return tenant && tenant !== NO_TENANT ? tenant : null;
  } catch {
    return null;
  }
}

/** What an OAuth failure means for the user, as an error they can act on. */
export function signInError(err: unknown, tenant: string): Error {
  if (!(err instanceof OAuthError)) return err instanceof Error ? err : new Error(String(err));
  // MFA, conditional access, or consent that this tenant demands and a
  // silent refresh can't satisfy.
  if (err.code === 'interaction_required' || /AADSTS(50076|50079|50158|65001)\b/.test(err.description)) {
    return new PrereqError(`Tenant ${tenant} needs you to sign in to it directly (MFA or a consent policy).`, [
      `Run: dova auth login --tenant ${tenant}`,
    ]);
  }
  if (err.code === 'invalid_grant') {
    return new PrereqError('Your dova sign-in has expired or was revoked.', ['Run: dova auth login']);
  }
  return new PrereqError(`Signing in failed: ${err.message}`, ['Run: dova auth login']);
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new UserError('Sign-in was cancelled.'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new UserError('Sign-in was cancelled.'));
      },
      { once: true }
    );
  });
}
