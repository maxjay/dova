import type { AdoRequest, AdoResponse } from '../lib/ado.js';
import { SIGN_IN_HINT, accountFromConnectionData, type ConnectionData } from '../lib/ado.js';
import { PrereqError, UserError } from '../lib/errors.js';
import { DOVA_VERSION } from '../lib/version.js';
import { configureProxy } from '../lib/proxy.js';
import {
  DEFAULT_TENANT,
  browserLogin,
  clientId,
  deviceCodeLogin,
  discoverOrgTenant,
  readIdToken,
  refreshAccessToken,
  signInError,
  type DeviceCodePrompt,
} from './entra.js';
import type { CredentialStore, StorageKind, StoredAccount, StoredCredential } from './store.js';

/* ------------------------------------------------------------------ *
 * Everything that knows the user's credentials. The daemon holds one of
 * these for its whole life — access tokens stay in its memory, refreshed
 * on demand, and nothing token-shaped is ever handed to the CLI. With
 * --no-daemon, the CLI holds one for the length of a single command.
 * ------------------------------------------------------------------ */

export type LoginParams =
  | { method: 'browser' | 'device'; tenant?: string }
  | { method: 'pat'; token: string; /** Org to check the token against, when the CLI knows one. */ orgUrl?: string };

/** Progress the CLI shows while a login is waiting on the user. */
export type LoginEvent = { type: 'open-url'; url: string } | ({ type: 'device-code' } & DeviceCodePrompt);

export interface AuthStatus {
  signedIn: boolean;
  method: 'entra' | 'pat' | null;
  account: StoredAccount | null;
  /** The tenant signed in against, for an Entra sign-in. */
  tenant: string | null;
  storage: StorageKind | 'environment' | null;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/** Refresh a little before expiry so a long request never carries a token that dies mid-flight. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 100_000;

export class AuthSession {
  private credential: StoredCredential | null | undefined;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly refreshing = new Map<string, Promise<CachedToken>>();
  private readonly orgTenants = new Map<string, Promise<string | null>>();

  constructor(
    private readonly store: CredentialStore,
    private readonly opts: { fromEnvironment?: boolean } = {}
  ) {
    configureProxy();
  }

  /* ---------------- requests ---------------- */

  /** Sends one Azure DevOps request as the signed-in user. */
  async send(req: AdoRequest): Promise<AdoResponse> {
    const url = assertAzureDevOpsUrl(req.url);
    let res = await this.sendOnce(req, url, false);
    // A token the service rejects despite not having expired (revoked,
    // or a tenant policy changed): drop it, refresh, try exactly once more.
    if ((res.status === 401 || res.status === 203) && (await this.loadCredential())?.kind === 'entra') {
      res = await this.sendOnce(req, url, true);
    }
    return res;
  }

  private async sendOnce(req: AdoRequest, url: URL, forceRefresh: boolean): Promise<AdoResponse> {
    const headers: Record<string, string> = {
      Authorization: await this.authorization(url, forceRefresh),
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

  private async authorization(url: URL, forceRefresh: boolean): Promise<string> {
    const credential = await this.loadCredential();
    if (!credential) {
      throw new PrereqError('Not signed in to Azure DevOps.', [SIGN_IN_HINT]);
    }
    if (credential.kind === 'pat') {
      return `Basic ${Buffer.from(`:${credential.token}`).toString('base64')}`;
    }
    const tenant = await this.tenantFor(url, credential);
    return `Bearer ${(await this.accessToken(tenant, credential, forceRefresh)).accessToken}`;
  }

  /** The tenant backing the org a URL belongs to, falling back to the one signed in against. */
  private async tenantFor(url: URL, credential: Extract<StoredCredential, { kind: 'entra' }>): Promise<string> {
    const fallback = credential.tenant !== DEFAULT_TENANT ? credential.tenant : credential.homeTenant ?? credential.tenant;
    const orgUrl = orgUrlOf(url);
    if (!orgUrl) return fallback;
    let tenant = this.orgTenants.get(orgUrl);
    if (!tenant) {
      tenant = discoverOrgTenant(orgUrl);
      this.orgTenants.set(orgUrl, tenant);
    }
    return (await tenant) ?? fallback;
  }

  private async accessToken(
    tenant: string,
    credential: Extract<StoredCredential, { kind: 'entra' }>,
    forceRefresh: boolean
  ): Promise<CachedToken> {
    const cached = this.tokens.get(tenant);
    if (!forceRefresh && cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached;

    // Every concurrent request for this tenant waits on the same refresh.
    let pending = this.refreshing.get(tenant);
    if (!pending) {
      pending = (async () => {
        try {
          const set = await refreshAccessToken(tenant, credential.refreshToken);
          // Entra rotates refresh tokens; keep the newest so the stored one
          // never ages out while the daemon is up.
          if (set.refreshToken && set.refreshToken !== credential.refreshToken) {
            credential.refreshToken = set.refreshToken;
            await this.store.save(credential).catch(() => {});
          }
          const token = { accessToken: set.accessToken, expiresAt: set.expiresAt };
          this.tokens.set(tenant, token);
          return token;
        } catch (err) {
          throw signInError(err, tenant);
        } finally {
          this.refreshing.delete(tenant);
        }
      })();
      this.refreshing.set(tenant, pending);
    }
    return pending;
  }

  private async loadCredential(): Promise<StoredCredential | null> {
    if (this.credential === undefined) this.credential = await this.store.load();
    return this.credential;
  }

  /* ---------------- login / logout / status ---------------- */

  async login(params: LoginParams, onEvent: (event: LoginEvent) => void, signal: AbortSignal): Promise<AuthStatus> {
    if (this.opts.fromEnvironment) {
      throw new UserError('$DOVA_TOKEN is set, so dova is using that token and not a stored sign-in.', [
        'Unset DOVA_TOKEN to sign in interactively.',
      ]);
    }

    let credential: StoredCredential;
    if (params.method === 'pat') {
      credential = { kind: 'pat', token: params.token, account: {} };
      if (params.orgUrl) credential.account = await this.checkPat(params.token, params.orgUrl);
    } else {
      const tenant = params.tenant ?? DEFAULT_TENANT;
      let set;
      try {
        set =
          params.method === 'device'
            ? await deviceCodeLogin(tenant, (prompt) => onEvent({ type: 'device-code', ...prompt }), signal)
            : await browserLogin(tenant, (url) => onEvent({ type: 'open-url', url }), signal);
      } catch (err) {
        throw signInError(err, tenant);
      }
      if (!set.refreshToken) {
        throw new PrereqError('Signed in, but Entra issued no refresh token, so the sign-in could not be kept.');
      }
      const claims = readIdToken(set.idToken);
      credential = {
        kind: 'entra',
        clientId: clientId(),
        tenant,
        homeTenant: claims.tenantId,
        refreshToken: set.refreshToken,
        account: { username: claims.username, name: claims.name },
      };
      this.tokens.clear();
      if (claims.tenantId) this.tokens.set(claims.tenantId, { accessToken: set.accessToken, expiresAt: set.expiresAt });
    }

    await this.store.save(credential);
    this.credential = credential;
    return this.status();
  }

  /** A PAT has no id token to read a name from; asking an org who it is both checks it and names it. */
  private async checkPat(token: string, orgUrl: string): Promise<StoredAccount> {
    const res = await fetch(`${orgUrl}/_apis/connectionData`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
        'X-TFS-FedAuthRedirect': 'Suppress',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      throw new UserError(`${orgUrl} did not accept that token (HTTP ${res.status}).`, [
        'Check it has not expired, and that it was created for this organization.',
      ]);
    }
    const data = (await res.json()) as ConnectionData;
    return accountFromConnectionData(data);
  }

  async logout(): Promise<void> {
    if (this.opts.fromEnvironment) {
      throw new UserError('$DOVA_TOKEN is set; there is no stored sign-in to remove.', ['Unset DOVA_TOKEN instead.']);
    }
    await this.store.clear();
    this.credential = null;
    this.tokens.clear();
  }

  async status(): Promise<AuthStatus> {
    const credential = await this.loadCredential();
    if (!credential) return { signedIn: false, method: null, account: null, tenant: null, storage: null };
    return {
      signedIn: true,
      method: credential.kind,
      account: credential.account,
      tenant: credential.kind === 'entra' ? credential.homeTenant ?? credential.tenant : null,
      storage: this.opts.fromEnvironment ? 'environment' : await this.store.storage(),
    };
  }
}

/* ------------------------------------------------------------------ *
 * URLs.
 * ------------------------------------------------------------------ */

/**
 * The daemon authenticates whatever it's asked to fetch, so it only
 * fetches Azure DevOps. It is not a general-purpose proxy that attaches
 * the user's token to any URL a local process names.
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

/** `https://dev.azure.com/{org}` for any URL under an org; null for org-less hosts like app.vssps.visualstudio.com. */
export function orgUrlOf(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const first = url.pathname.split('/').filter(Boolean)[0];
  if (host === 'dev.azure.com' || host.endsWith('.dev.azure.com')) {
    return first && !first.startsWith('_') ? `https://dev.azure.com/${first}` : null;
  }
  const sub = host.slice(0, -'.visualstudio.com'.length);
  if (sub && !sub.includes('.') && sub !== 'app') return `https://dev.azure.com/${sub}`;
  return null;
}
