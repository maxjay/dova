import type { Command } from 'commander';
import { defaultRunner, runAzJson } from '../lib/exec.js';
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
  jq?: string;
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
    .option('-f, --body <json>', 'request body: inline JSON, or @path/to/file.json');
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
    const args = ['rest', '--method', opts.method.toLowerCase(), '--uri', url];
    if (opts.body) args.push('--body', opts.body);

    const data = await runAzJson<unknown>(runner, args);

    if (opts.jq) {
      process.stdout.write(`${await applyJq(data as JqInput, opts.jq)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    }
  });
}
