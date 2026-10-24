import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { AdoRequest, AdoResponse } from '../lib/ado.js';
import { NotSignedInError, PrereqError, UserError } from '../lib/errors.js';
import { DOVA_VERSION } from '../lib/version.js';
import { configureProxy } from '../lib/proxy.js';

/* ------------------------------------------------------------------ *
 * The sign-in is the Azure CLI's: `az login`, once, as before. What
 * changed is how often az runs. The daemon asks it for an Azure DevOps
 * token, keeps that in memory, and makes every request itself with it
 * until it's close to expiring — instead of a Python process per call.
 *
 * Nothing here ever needs the user to come back and sign in again:
 *   - a new `az login` (another account, `az account set`) is noticed
 *     on its own, from az's profile file changing;
 *   - an org in another tenant names that tenant on its 401, and the
 *     token is fetched for it from the same az login.
 * ------------------------------------------------------------------ */

/** Azure DevOps' resource id — the audience of the token az is asked for. */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

export interface AccessToken {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** A token for Azure DevOps — for `tenant` when given, otherwise az's current one. */
export type TokenSource = (tenant?: string) => Promise<AccessToken>;

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

export interface AuthSessionOptions {
  source?: TokenSource;
  /** The file `az login` / `az account set` rewrite. Null to not watch anything (tests). */
  azProfile?: string | null;
}

/** Fetch a new token this long before the cached one expires, so a request never carries one that dies mid-flight. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 100_000;
const NO_TENANT = '00000000-0000-0000-0000-000000000000';
/** Map key for "whatever tenant az is currently on". */
const DEFAULT = '';

export function azProfileFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.AZURE_CONFIG_DIR || path.join(os.homedir(), '.azure'), 'azureProfile.json');
}

export class AuthSession {
  private readonly source: TokenSource;
  private readonly azProfile: string | null;
  private readonly tokens = new Map<string, AccessToken>();
  private readonly pending = new Map<string, Promise<AccessToken>>();
  /** Org URL -> the tenant it said it belongs to. */
  private readonly orgTenants = new Map<string, string>();
  private profileStamp: number | null = null;

  constructor(opts: AuthSessionOptions = {}) {
    this.source = opts.source ?? azCliToken;
    this.azProfile = opts.azProfile === undefined ? azProfileFile() : opts.azProfile;
    configureProxy();
  }

  /** Sends one Azure DevOps request as whoever az is signed in as. */
  async send(req: AdoRequest): Promise<AdoResponse> {
    const url = assertAzureDevOpsUrl(req.url);
    this.forgetTokensIfAzLoginChanged();
    const org = orgUrlOf(url);
    const tenant = (org && this.orgTenants.get(org)) ?? DEFAULT;

    const first = await this.sendOnce(req, url, tenant, false);
    if (first.res.status !== 401 && first.res.status !== 203) return first.res;

    // The org lives in another tenant than the token's: ask az for one
    // there, and remember it for this org from now on.
    const wanted = first.resourceTenant;
    if (org && wanted && wanted !== first.tokenTenant) {
      this.orgTenants.set(org, wanted);
      return (await this.sendOnce(req, url, wanted, false)).res;
    }
    // Same tenant, still rejected before expiry (revoked, or az signed in
    // as someone else since): ask az again, once.
    return (await this.sendOnce(req, url, tenant, true)).res;
  }

  private async sendOnce(
    req: AdoRequest,
    url: URL,
    tenant: string,
    fresh: boolean
  ): Promise<{ res: AdoResponse; resourceTenant: string | null; tokenTenant: string | null }> {
    const { accessToken } = await this.accessToken(tenant, fresh);
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
    const resourceTenant = res.headers.get('x-vss-resourcetenant')?.split(',')[0]?.trim() || null;
    return {
      res: { status: res.status, contentType: res.headers.get('content-type'), body: await res.text() },
      resourceTenant: resourceTenant && resourceTenant !== NO_TENANT ? resourceTenant : null,
      tokenTenant: readClaims(accessToken).tenant,
    };
  }

  private async accessToken(tenant: string, fresh: boolean): Promise<AccessToken> {
    const cached = this.tokens.get(tenant);
    if (!fresh && cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached;
    // Concurrent requests all wait on the same az run.
    let pending = this.pending.get(tenant);
    if (!pending) {
      pending = this.source(tenant === DEFAULT ? undefined : tenant)
        .then((token) => {
          this.tokens.set(tenant, token);
          return token;
        })
        .finally(() => this.pending.delete(tenant));
      this.pending.set(tenant, pending);
    }
    return pending;
  }

  /**
   * `az login`, `az logout` and `az account set` all rewrite az's
   * profile file. When it has changed since the tokens were fetched,
   * they may belong to the wrong account: drop them.
   */
  private forgetTokensIfAzLoginChanged(): void {
    if (!this.azProfile) return;
    let stamp: number | null;
    try {
      stamp = fs.statSync(this.azProfile).mtimeMs;
    } catch {
      stamp = null;
    }
    if (stamp !== this.profileStamp) {
      this.tokens.clear();
      this.profileStamp = stamp;
    }
  }

  async status(): Promise<AuthStatus> {
    this.forgetTokensIfAzLoginChanged();
    try {
      const token = await this.accessToken(DEFAULT, false);
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

const INSTALL_AZ = 'Install: https://learn.microsoft.com/cli/azure/install-azure-cli';

export async function azCliToken(tenant?: string): Promise<AccessToken> {
  let result;
  try {
    result = await execa(
      'az',
      ['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, ...(tenant ? ['--tenant', tenant] : []), '--output', 'json'],
      { reject: false, env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new PrereqError('az (Azure CLI) is not installed or not on PATH.', [INSTALL_AZ]);
    }
    throw err;
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    if (/az login|aadsts|please run|expired|refresh token|interaction/i.test(stderr)) {
      throw tenant
        ? new NotSignedInError(`This organization belongs to tenant ${tenant}, which your az login doesn't cover yet.`, tenant)
        : new NotSignedInError('Not logged in to Azure CLI.');
    }
    throw new PrereqError(`az could not get an Azure DevOps token:\n${stderr || '(no output on stderr)'}`);
  }
  return parseAzToken(result.stdout);
}

export function parseAzToken(stdout: string): AccessToken {
  let data: AzAccessToken;
  try {
    data = JSON.parse(stdout) as AzAccessToken;
  } catch {
    throw new PrereqError('az returned something other than a token.');
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

/**
 * `az login`, in this terminal — what a command does by itself the first
 * time it finds az not logged in, so nobody has to go and run it first.
 * Its output goes to stderr: stdout belongs to the command's own result.
 */
export async function runAzLogin(tenant?: string): Promise<void> {
  process.stderr.write(tenant ? `Signing in to tenant ${tenant} with az login…\n` : 'Not signed in to Azure — running az login…\n');
  try {
    const result = await execa('az', ['login', ...(tenant ? ['--tenant', tenant] : []), '--output', 'none'], {
      stdin: 'inherit',
      stdout: process.stderr,
      stderr: 'inherit',
      reject: false,
    });
    if (result.exitCode !== 0) throw new PrereqError(`az login exited with code ${result.exitCode}.`);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new PrereqError('az (Azure CLI) is not installed or not on PATH.', [INSTALL_AZ]);
    }
    throw err;
  }
}

/** `https://dev.azure.com/{org}` for a URL under an org; null for org-less hosts. */
export function orgUrlOf(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const first = url.pathname.split('/').filter(Boolean)[0];
  if (host === 'dev.azure.com' || host.endsWith('.dev.azure.com')) {
    return first && !first.startsWith('_') ? `https://dev.azure.com/${first}` : null;
  }
  const sub = host.slice(0, -'.visualstudio.com'.length);
  return sub && !sub.includes('.') && sub !== 'app' ? `https://dev.azure.com/${sub}` : null;
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
