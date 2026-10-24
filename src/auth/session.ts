import { execa } from 'execa';
import { SIGN_IN_HINT, type AdoRequest, type AdoResponse } from '../lib/ado.js';
import { PrereqError, UserError } from '../lib/errors.js';
import { DOVA_VERSION } from '../lib/version.js';
import { configureProxy } from '../lib/proxy.js';

/* ------------------------------------------------------------------ *
 * The sign-in is the Azure CLI's: `az login`, as before. What changed
 * is how often az runs. The daemon asks it for an Azure DevOps access
 * token once, keeps that in memory, and makes every request itself with
 * it until it's close to expiring — instead of a Python process per
 * request.
 * ------------------------------------------------------------------ */

/** Azure DevOps' resource id — the audience of the token az is asked for. */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

export interface AccessToken {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

export type TokenSource = () => Promise<AccessToken>;

export interface AuthStatus {
  signedIn: boolean;
  /** Who the token belongs to, from its own claims. */
  account: string | null;
  tenant: string | null;
  /** ISO time the cached token expires; null when none is cached. */
  expiresAt: string | null;
  /** Why there's no token, when there isn't one. */
  error: string | null;
}

/** Fetch a new token this long before the cached one expires, so a request never carries one that dies mid-flight. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 100_000;

export class AuthSession {
  private token: AccessToken | null = null;
  private pending: Promise<AccessToken> | null = null;

  constructor(private readonly source: TokenSource = azCliToken) {
    configureProxy();
  }

  /** Sends one Azure DevOps request with the cached token. */
  async send(req: AdoRequest): Promise<AdoResponse> {
    const url = assertAzureDevOpsUrl(req.url);
    let res = await this.sendOnce(req, url, false);
    // Rejected before it expired (a new `az login` as someone else, a
    // revoked session): ask az again, once.
    if (res.status === 401 || res.status === 203) res = await this.sendOnce(req, url, true);
    return res;
  }

  private async sendOnce(req: AdoRequest, url: URL, fresh: boolean): Promise<AdoResponse> {
    const { accessToken } = await this.accessToken(fresh);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      // Build logs come back as JSON lines unless text is asked for.
      Accept: req.accept === 'text' ? 'text/plain' : 'application/json',
      // Without this, an unauthenticated request gets a 203 + sign-in
      // page instead of a plain 401.
      'X-TFS-FedAuthRedirect': 'Suppress',
      'User-Agent': `dova/${DOVA_VERSION}`,
    };
    if (req.contentType) headers['Content-Type'] = req.contentType;

    const res = await fetch(url, {
      method: req.method,
      headers,
      body: req.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: res.status, contentType: res.headers.get('content-type'), body: await res.text() };
  }

  private async accessToken(fresh: boolean): Promise<AccessToken> {
    if (!fresh && this.token && this.token.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return this.token;
    // Concurrent requests all wait on the same az run.
    this.pending ??= this.source()
      .then((token) => {
        this.token = token;
        return token;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** Forget the cached token — after `az login`, so the next request picks up the new account. */
  reset(): void {
    this.token = null;
  }

  async status(): Promise<AuthStatus> {
    try {
      const token = await this.accessToken(false);
      const claims = readClaims(token.accessToken);
      return {
        signedIn: true,
        account: claims.account,
        tenant: claims.tenant,
        expiresAt: new Date(token.expiresAt).toISOString(),
        error: null,
      };
    } catch (err) {
      return { signedIn: false, account: null, tenant: null, expiresAt: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/* ------------------------------------------------------------------ *
 * az.
 * ------------------------------------------------------------------ */

interface AzAccessToken {
  accessToken: string;
  /** Epoch seconds — newer az versions. */
  expires_on?: number;
  /** Local time, e.g. "2026-10-24 19:41:07.000000" — every version. */
  expiresOn?: string;
}

export async function azCliToken(): Promise<AccessToken> {
  let result;
  try {
    result = await execa('az', ['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--output', 'json'], {
      reject: false,
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new PrereqError('az (Azure CLI) is not installed or not on PATH.', [
        'Install: https://learn.microsoft.com/cli/azure/install-azure-cli',
      ]);
    }
    throw err;
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    if (/az login|aadsts|please run|expired|refresh token/i.test(stderr)) {
      throw new PrereqError('Not logged in to Azure CLI (or the login expired).', [SIGN_IN_HINT]);
    }
    throw new PrereqError(`az could not get an Azure DevOps token:\n${stderr || '(no output on stderr)'}`, [SIGN_IN_HINT]);
  }
  return parseAzToken(result.stdout);
}

export function parseAzToken(stdout: string): AccessToken {
  let data: AzAccessToken;
  try {
    data = JSON.parse(stdout) as AzAccessToken;
  } catch {
    throw new PrereqError('az returned something other than a token.', [SIGN_IN_HINT]);
  }
  const expiresAt =
    typeof data.expires_on === 'number'
      ? data.expires_on * 1000
      : data.expiresOn
        ? new Date(data.expiresOn.replace(' ', 'T')).getTime()
        : NaN;
  // An expiry we can't read: treat the token as good for a few minutes,
  // so it gets used and then re-fetched rather than trusted for an hour.
  return { accessToken: data.accessToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 10 * 60 * 1000 };
}

/** Reads (does not verify) the token's claims, for display only. */
function readClaims(jwt: string): { account: string | null; tenant: string | null } {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return { account: str(payload.upn) ?? str(payload.unique_name) ?? str(payload.name), tenant: str(payload.tid) };
  } catch {
    return { account: null, tenant: null };
  }
}

/* ------------------------------------------------------------------ *
 * URLs.
 * ------------------------------------------------------------------ */

/**
 * The daemon attaches the user's token to whatever it's asked to fetch,
 * so it only fetches Azure DevOps — it is not a general-purpose proxy
 * for any URL a local process names.
 */
export function assertAzureDevOpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError(`Not a URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const allowed = host === 'dev.azure.com' || host.endsWith('.dev.azure.com') || host.endsWith('.visualstudio.com');
  if (url.protocol !== 'https:' || !allowed || url.username || url.password) {
    throw new UserError(`dova only sends requests to Azure DevOps (https://dev.azure.com), not ${url.origin}.`);
  }
  return url;
}
