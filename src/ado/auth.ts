import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa, type Options } from 'execa';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { NotSignedInError, PrereqError, UserError } from '../errors.js';
import { DOVA_VERSION } from '../version.js';
import type { AdoHttp, AdoRequest, AdoResponse } from './http.js';

/* ------------------------------------------------------------------ *
 * Requests signed with the user's own `az login`. az is asked for a
 * token once and it's kept until near expiry, per tenant. A new
 * `az login` is noticed from az's profile file changing; an org in
 * another tenant names it in its 401, and gets a token from there.
 * ------------------------------------------------------------------ */

const RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'; // Azure DevOps
const MARGIN_MS = 5 * 60 * 1000;

export interface Token {
  accessToken: string;
  expiresAt: number;
}

export type TokenSource = (tenant?: string) => Promise<Token>;

export interface AuthStatus {
  signedIn: boolean;
  account: string | null;
  tenant: string | null;
  expiresAt: string | null;
  error: string | null;
}

export class Session {
  private tokens = new Map<string, Promise<Token>>();
  private orgTenants = new Map<string, string>();
  private profileStamp: number | null = null;

  constructor(
    private readonly source: TokenSource = azToken,
    private readonly profile: string | null = path.join(process.env.AZURE_CONFIG_DIR || path.join(os.homedir(), '.azure'), 'azureProfile.json')
  ) {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxy && !/(^|,)\s*(\*|\.?(dev\.)?azure\.com)\s*(,|$)/.test(process.env.NO_PROXY || process.env.no_proxy || '')) {
      setGlobalDispatcher(new ProxyAgent(proxy));
    }
  }

  readonly send: AdoHttp = async (req) => {
    const url = new URL(req.url);
    if (url.protocol !== 'https:' || !/(^|\.)dev\.azure\.com$|\.visualstudio\.com$/i.test(url.hostname) || url.username) {
      throw new UserError(`dova only sends requests to Azure DevOps, not ${url.origin}.`);
    }
    this.dropTokensIfAzLoginChanged();
    const org = url.hostname.endsWith('.visualstudio.com') ? url.hostname.split('.')[0]! : url.pathname.split('/')[1]!;
    const tenant = this.orgTenants.get(org) ?? '';
    const first = await this.fetch(req, tenant, false);
    if (first.res.status !== 401 && first.res.status !== 203) return first.res;
    // The org is in another tenant than the token's: get one there.
    if (first.wantedTenant && first.wantedTenant !== claims(first.token).tid) {
      this.orgTenants.set(org, first.wantedTenant);
      return (await this.fetch(req, first.wantedTenant, false)).res;
    }
    return (await this.fetch(req, tenant, true)).res;
  };

  async status(): Promise<AuthStatus> {
    this.dropTokensIfAzLoginChanged();
    try {
      const token = await this.token('', false);
      const c = claims(token.accessToken);
      return { signedIn: true, account: c.upn ?? c.unique_name ?? null, tenant: c.tid ?? null, expiresAt: new Date(token.expiresAt).toISOString(), error: null };
    } catch (err) {
      return { signedIn: false, account: null, tenant: null, expiresAt: null, error: (err as Error).message };
    }
  }

  private async fetch(req: AdoRequest, tenant: string, fresh: boolean) {
    const { accessToken } = await this.token(tenant, fresh);
    const res = await fetch(req.url, {
      method: req.method,
      body: req.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(100_000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: req.accept === 'text' ? 'text/plain' : 'application/json',
        'X-TFS-FedAuthRedirect': 'Suppress', // a 401 instead of a 203 sign-in page
        'User-Agent': `dova/${DOVA_VERSION}`,
        ...(req.contentType ? { 'Content-Type': req.contentType } : {}),
      },
    });
    const wanted = res.headers.get('x-vss-resourcetenant')?.split(',')[0]?.trim();
    const response: AdoResponse = { status: res.status, contentType: res.headers.get('content-type'), body: await res.text() };
    return { res: response, token: accessToken, wantedTenant: wanted && !/^[0-]+$/.test(wanted) ? wanted : null };
  }

  private token(tenant: string, fresh: boolean): Promise<Token> {
    const cached = this.tokens.get(tenant);
    if (!fresh && cached) {
      return cached.then((t) => (t.expiresAt - MARGIN_MS > Date.now() ? t : this.token(tenant, true)));
    }
    const pending = this.source(tenant || undefined);
    this.tokens.set(tenant, pending);
    pending.catch(() => this.tokens.get(tenant) === pending && this.tokens.delete(tenant));
    return pending;
  }

  /** `az login`, `az logout` and `az account set` all rewrite az's profile. */
  private dropTokensIfAzLoginChanged(): void {
    if (!this.profile) return;
    let stamp: number | null = null;
    try {
      stamp = fs.statSync(this.profile).mtimeMs;
    } catch {
      // no profile yet
    }
    if (stamp !== this.profileStamp) this.tokens.clear();
    this.profileStamp = stamp;
  }
}

function claims(jwt: string): Record<string, string | undefined> {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());
  } catch {
    return {};
  }
}

const INSTALL_AZ = 'Install: https://learn.microsoft.com/cli/azure/install-azure-cli';

async function az(args: string[], opts: Options = {}) {
  const res = await execa('az', args, { reject: false, ...opts });
  if (res.code === 'ENOENT') throw new PrereqError('az (Azure CLI) is not installed or not on PATH.', [INSTALL_AZ]);
  return res;
}

export async function azToken(tenant?: string): Promise<Token> {
  const res = await az(['account', 'get-access-token', '--resource', RESOURCE, ...(tenant ? ['--tenant', tenant] : []), '--output', 'json']);
  if (res.exitCode !== 0) {
    const stderr = String(res.stderr).trim();
    if (/az login|aadsts|expired|refresh token|interaction/i.test(stderr)) {
      throw tenant
        ? new NotSignedInError(`This organization belongs to tenant ${tenant}, which your az login doesn't cover yet.`, tenant)
        : new NotSignedInError('Not logged in to Azure CLI.');
    }
    throw new PrereqError(`az could not get an Azure DevOps token: ${stderr}`);
  }
  return parseAzToken(String(res.stdout));
}

export function parseAzToken(stdout: string): Token {
  let data: { accessToken: string; expires_on?: number; expiresOn?: string };
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new PrereqError('az returned something other than a token.');
  }
  // expires_on (epoch seconds) on newer az; expiresOn (local time) on all.
  const at = data.expires_on ? data.expires_on * 1000 : new Date((data.expiresOn ?? '').replace(' ', 'T')).getTime();
  return { accessToken: data.accessToken, expiresAt: Number.isFinite(at) ? at : Date.now() + 10 * 60 * 1000 };
}

/** `az login` in this terminal, its output on stderr so stdout stays the command's. */
export async function azLogin(tenant?: string): Promise<void> {
  process.stderr.write(tenant ? `Signing in to tenant ${tenant}…\n` : 'Not signed in to Azure — running az login…\n');
  const res = await az(['login', ...(tenant ? ['--tenant', tenant] : []), '--output', 'none'], { stdin: 'inherit', stdout: process.stderr, stderr: 'inherit' });
  if (res.exitCode !== 0) throw new PrereqError(`az login exited with code ${res.exitCode}.`);
}

/**
 * In a terminal, a NotSignedInError becomes `az login` and a retry —
 * once per tenant per process, shared by concurrent requests.
 */
export function withAutoLogin(send: AdoHttp, interactive: boolean, login: (tenant?: string) => Promise<void> = azLogin): AdoHttp {
  const logins = new Map<string, Promise<void>>();
  return async (req) => {
    const tried = new Set<string>();
    for (;;) {
      try {
        return await send(req);
      } catch (err) {
        const key = err instanceof NotSignedInError ? err.tenant ?? '' : null;
        if (key === null || !interactive || tried.has(key)) throw err;
        tried.add(key);
        if (!logins.has(key)) logins.set(key, login(key || undefined));
        await logins.get(key);
      }
    }
  };
}
