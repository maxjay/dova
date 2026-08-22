import type { Command } from 'commander';
import { defaultRunner, runAzRestJson, AZURE_DEVOPS_AAD_RESOURCE, type AzRestOptions } from '../lib/exec.js';
import { resolveContext } from '../lib/context.js';
import { addContextOptions, addJqOption, addNoColorOption } from '../lib/command-helpers.js';
import type { JqInput } from 'jq-wasm';
import { applyJq } from '../lib/output.js';
import { UserError } from '../lib/errors.js';

export interface ApiFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  method: string;
  body?: string;
  resource?: string;
  jq?: string;
}

const REST_METHODS: AzRestOptions['method'][] = ['get', 'post', 'patch', 'put', 'delete'];

function validateMethod(raw: string): AzRestOptions['method'] {
  const lower = raw.toLowerCase();
  if ((REST_METHODS as string[]).includes(lower)) {
    return lower as AzRestOptions['method'];
  }
  throw new UserError(`Unknown HTTP method "${raw}".`, [`Supported: ${REST_METHODS.join(', ')}`]);
}

const DEFAULT_API_VERSION = '7.1';

/**
 * Builds the full REST URL for a path the user gave us:
 *   - already absolute (http(s)://...)         -> used as-is
 *   - starts with "/"                          -> relative to the org (e.g. /_apis/projects)
 *   - otherwise                                -> relative to the org/project (the common case,
 *                                                  e.g. _apis/wit/workitems/123)
 * `api-version` is defaulted to 7.1 when the caller didn't specify one.
 */
export function buildApiUrl(path: string, orgUrl: string, project?: string): string {
  let url: URL;
  if (/^https?:\/\//i.test(path)) {
    url = new URL(path);
  } else if (path.startsWith('/')) {
    url = new URL(orgUrl + path);
  } else {
    if (!project) {
      throw new UserError('This path needs a project — pass --project, or use a leading "/" for an org-level path.');
    }
    url = new URL(`${orgUrl}/${encodeURIComponent(project)}/${path}`);
  }
  if (!url.searchParams.has('api-version')) {
    url.searchParams.set('api-version', DEFAULT_API_VERSION);
  }
  return url.toString();
}

export function registerApiCommand(program: Command): void {
  const cmd = program
    .command('api <path>')
    .description('Raw authenticated Azure DevOps REST call — the escape hatch for anything not yet wrapped');

  addContextOptions(cmd);
  cmd
    .option('-X, --method <verb>', 'HTTP method', 'GET')
    .option('-f, --body <json>', 'request body: inline JSON, or @path/to/file.json')
    .option(
      '--resource <aad-resource>',
      `override the AAD resource az requests a token for (default: Azure DevOps, ${AZURE_DEVOPS_AAD_RESOURCE})`
    );
  addJqOption(cmd);
  addNoColorOption(cmd);

  cmd.action(async (path: string, opts: ApiFlags) => {
    const runner = defaultRunner;
    const ctx = await resolveContext(runner, {
      org: opts.org,
      orgUrl: opts.orgUrl,
      project: opts.project,
      repo: opts.repo,
    });

    const url = buildApiUrl(path, ctx.orgUrl, ctx.project);
    const data = await runAzRestJson<unknown>(runner, {
      method: validateMethod(opts.method),
      uri: url,
      // Passed straight through, not via `body`/toAsciiSafeJson: this is
      // the user's own raw text, which may already use az's own
      // @path/to/file.json syntax that must not be re-encoded.
      rawBody: opts.body,
      resource: opts.resource,
    });

    if (opts.jq) {
      process.stdout.write(`${await applyJq(data as JqInput, opts.jq)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    }
  });
}
