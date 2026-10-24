import type { Runner } from './exec.js';
import { ExternalCommandError, NotFoundError, PrereqError } from './errors.js';

/* ------------------------------------------------------------------ *
 * The one way dova talks to Azure DevOps: an HTTP request against its
 * REST API. Where the request actually goes out from — the daemon, or
 * this process with --no-daemon — is the transport's business (see
 * transport.ts); everything in lib/ only builds requests and reads
 * responses, through `adoJson`/`adoText` below.
 * ------------------------------------------------------------------ */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Plain data, so it crosses the daemon socket as-is. */
export interface AdoRequest {
  method: HttpMethod;
  /** Absolute https URL on dev.azure.com or *.visualstudio.com. */
  url: string;
  /** Already-serialized request body. */
  body?: string;
  contentType?: string;
  /** What to ask for back; JSON unless this is `text`. */
  accept?: 'json' | 'text';
}

export interface AdoResponse {
  status: number;
  contentType: string | null;
  body: string;
}

export const API_VERSION = '7.1';

/** `dova auth login` runs `az login` and makes the daemon pick up the new account. */
export const SIGN_IN_HINT = 'Run: dova auth login';

type QueryValue = string | number | boolean | undefined;

/**
 * `{base}/{path}?api-version=7.1&...`. `base` is an org URL, or an org
 * URL plus already-encoded project/team segments (see `projectBase`).
 * Undefined query values are dropped, so optional filters can be passed
 * inline.
 */
export function adoUrl(base: string, path: string, query: Record<string, QueryValue> = {}): string {
  const url = new URL(`${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', API_VERSION);
  return url.toString();
}

/** `{orgUrl}/{project}[/{team}]`, each segment encoded. */
export function projectBase(orgUrl: string, project: string, team?: string): string {
  return [orgUrl, encodeURIComponent(project), ...(team ? [encodeURIComponent(team)] : [])].join('/');
}

export interface AdoCall {
  method: HttpMethod;
  url: string;
  /** Any JSON-serializable value. */
  body?: unknown;
  /** A body that is already text — `dova api` passing through what the user typed. */
  rawBody?: string;
  /** Defaults to application/json when there is a body. */
  contentType?: string;
  accept?: 'json' | 'text';
}

/** Sends a request and parses the JSON response. An empty 2xx body comes back as `null`. */
export async function adoJson<T>(runner: Runner, call: AdoCall): Promise<T> {
  const res = await send(runner, call);
  const text = res.body.trim();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ExternalCommandError(`Azure DevOps sent a response that isn't JSON for ${call.method} ${describeUrl(call.url)}:\n${text.slice(0, 500)}`);
  }
}

/** For endpoints that return plain text (build logs). */
export async function adoText(runner: Runner, call: AdoCall): Promise<string> {
  return (await send(runner, { accept: 'text', ...call })).body;
}

async function send(runner: Runner, call: AdoCall): Promise<AdoResponse> {
  const req: AdoRequest = { method: call.method, url: call.url };
  if (call.accept) req.accept = call.accept;
  const body = call.rawBody ?? (call.body !== undefined ? JSON.stringify(call.body) : undefined);
  if (body !== undefined) {
    req.body = body;
    req.contentType = call.contentType ?? 'application/json';
  } else if (call.contentType) {
    req.contentType = call.contentType;
  }
  const res = await runner.ado(req);
  throwForStatus(res, call);
  return res;
}

/**
 * Status codes are the whole error story now — no stderr to scrape.
 * 203 is how Azure DevOps answers an unauthenticated request it wants
 * to bounce to a sign-in page: success-shaped, HTML body, not the
 * resource. It means the same thing as a 401.
 */
export function throwForStatus(res: AdoResponse, call: Pick<AdoCall, 'method' | 'url'>): void {
  if (res.status === 203 || res.status === 401) {
    throw new PrereqError('Azure DevOps rejected dova\'s sign-in.', [
      SIGN_IN_HINT,
      ...(serviceMessage(res) ? [`Azure DevOps said: ${serviceMessage(res)}`] : []),
    ]);
  }
  if (res.status >= 200 && res.status < 300) return;

  const message = serviceMessage(res);
  if (res.status === 404) {
    throw new NotFoundError(message ?? `Not found: ${describeUrl(call.url)}`);
  }
  if (res.status === 403) {
    throw new ExternalCommandError(message ?? `Access denied: ${call.method} ${describeUrl(call.url)}`, [
      'Your account (or token) lacks permission for this — check `dova auth status`.',
    ]);
  }
  throw new ExternalCommandError(
    `Azure DevOps returned ${res.status} for ${call.method} ${describeUrl(call.url)}${message ? `:\n${message}` : ''}`
  );
}

/** Azure DevOps errors are `{ "message": "TF401232: ...", "typeKey": ... }`. */
function serviceMessage(res: AdoResponse): string | null {
  try {
    const parsed = JSON.parse(res.body) as { message?: unknown };
    return typeof parsed.message === 'string' && parsed.message ? parsed.message : null;
  } catch {
    return null;
  }
}

/** The path, without the org host or api-version noise. */
function describeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.searchParams.delete('api-version');
    return `${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
}

/* ------------------------------------------------------------------ *
 * Who the token belongs to, as Azure DevOps sees it.
 * ------------------------------------------------------------------ */

export interface ConnectionData {
  authenticatedUser?: {
    providerDisplayName?: string;
    properties?: { Account?: { $value?: string } };
  };
}

export function accountFromConnectionData(data: ConnectionData): { name?: string; username?: string } {
  return {
    name: data.authenticatedUser?.providerDisplayName,
    username: data.authenticatedUser?.properties?.Account?.$value,
  };
}
