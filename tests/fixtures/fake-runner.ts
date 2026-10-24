import type { Runner, ProcessResult } from '../../src/lib/exec.js';
import type { AdoRequest, AdoResponse } from '../../src/lib/ado.js';

export type GitHandler = (args: string[], opts?: { cwd?: string }) => ProcessResult | Promise<ProcessResult>;

/**
 * What an Azure DevOps handler sees: the request as sent, plus its URL
 * already taken apart — `path` is the decoded pathname (e.g.
 * `/contoso/MyProject/_apis/git/repositories/web/pullrequests`), `query`
 * its search params, and `json` the parsed body, when there is one.
 */
export interface FakeAdoRequest extends AdoRequest {
  path: string;
  query: URLSearchParams;
  json: unknown;
}

export type AdoHandler = (req: FakeAdoRequest) => AdoResponse | Promise<AdoResponse>;

export function ok(stdout: string): ProcessResult {
  return { stdout, stderr: '', exitCode: 0 };
}

export function okJson(data: unknown): ProcessResult {
  return ok(JSON.stringify(data));
}

export function fail(stderr = '', exitCode = 1): ProcessResult {
  return { stdout: '', stderr, exitCode };
}

/** A 200 with a JSON body. */
export function adoOk(data: unknown): AdoResponse {
  return { status: 200, contentType: 'application/json', body: data === undefined ? '' : JSON.stringify(data) };
}

/** A 200 with a plain-text body (build logs). */
export function adoTextOk(text: string): AdoResponse {
  return { status: 200, contentType: 'text/plain', body: text };
}

/** An error response shaped the way Azure DevOps sends them. */
export function adoError(status: number, message = `HTTP ${status}`): AdoResponse {
  return { status, contentType: 'application/json', body: JSON.stringify({ message }) };
}

/**
 * Anything a test didn't set up a handler for. A 599 matches none of the
 * statuses dova treats specially, so it surfaces as an error naming the
 * request rather than being mistaken for "not found".
 */
export function unexpected(req: FakeAdoRequest): AdoResponse {
  return adoError(599, `unexpected request in test: ${req.method} ${req.path}`);
}

function enrich(req: AdoRequest): FakeAdoRequest {
  const url = new URL(req.url);
  let json: unknown;
  if (req.body !== undefined) {
    try {
      json = JSON.parse(req.body);
    } catch {
      json = undefined;
    }
  }
  return { ...req, path: decodeURIComponent(url.pathname), query: url.searchParams, json };
}

/**
 * A fully in-memory `Runner` for tests — no git process, no network.
 * Handlers pattern-match on what they're given; anything unmatched should
 * return `fail(...)` / `unexpected(req)` so a test fails loudly instead of
 * passing on a call it never meant to allow.
 */
export function createFakeRunner(handlers: { git?: GitHandler; ado?: AdoHandler }): Runner {
  return {
    async git(args, gitOpts) {
      if (!handlers.git) return fail('no git handler configured for this test');
      return handlers.git(args, gitOpts);
    },
    async ado(req) {
      const enriched = enrich(req);
      if (!handlers.ado) return unexpected(enriched);
      return handlers.ado(enriched);
    },
  };
}
