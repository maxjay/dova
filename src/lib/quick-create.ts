import type { Runner } from './exec.js';
import { runAzJson, tryGit } from './exec.js';
import { resolveContext, type ResolvedContext } from './context.js';
import { resolveProject, resolveCreateContext } from './team-resolver.js';
import { buildWiWebUrl } from './work-items.js';
import { UserError } from './errors.js';
import type { AzWorkItem } from '../types/azure-devops.js';

export interface QuickCreateOptions {
  type: string;
  title: string;
  /** "path/to/file.ts:42" — builds a "Found in:" permalink appended to the description. */
  at?: string;
  /** Re-run project/team resolution against a different project (e.g. a bug whose root cause is a shared library). */
  project?: string;
  team?: string;
  /** Area/iteration set outright, skipping team-based resolution — see resolveCreateContext(). */
  area?: string;
  iteration?: string;
  reresolve?: boolean;
  /** Work item id to copy area/iteration from directly — see resolveCreateContext(). */
  like?: string;
  /** Persist the --like ticket's area/iteration as this repo's default (requires `like`). */
  save?: boolean;
  cwd?: string;
}

export interface QuickCreateResult {
  id: number;
  url: string;
  project: string;
  /** null when area/iteration came from --like or a saved repo-local override — no team was ever resolved. */
  team: string | null;
  areaPath: string;
  iterationPath: string;
  warnings: string[];
}

function splitFileLine(at: string): { file: string; line: number | null } {
  const match = at.match(/^(.*):(\d+)$/);
  if (match) {
    return { file: match[1]!, line: Number(match[2]) };
  }
  return { file: at, line: null };
}

/**
 * Azure Repos file permalink format: `{orgUrl}/{project}/_git/{repo}?path=
 * {file}&version=GC{sha}&line={n}&lineEnd={n+1}&lineStartColumn=1&lineEndColumn=1`.
 * `GC{sha}` pins it to an exact commit rather than a branch, so the link
 * stays correct even after the branch moves on.
 */
async function buildFoundInPermalink(runner: Runner, ctx: ResolvedContext, at: string, cwd?: string): Promise<string> {
  if (!ctx.repo) {
    throw new UserError('--at needs a repo in context to build a permalink.', [
      'Run this inside the repo the file lives in, or omit --at.',
    ]);
  }
  const sha = await tryGit(runner, ['rev-parse', 'HEAD'], { cwd });
  if (!sha) {
    throw new UserError('--at needs a commit to point to, but HEAD could not be resolved.');
  }
  const { file, line } = splitFileLine(at);
  const url = new URL(`${ctx.orgUrl}/${encodeURIComponent(ctx.project)}/_git/${encodeURIComponent(ctx.repo)}`);
  url.searchParams.set('path', file.startsWith('/') ? file : `/${file}`);
  url.searchParams.set('version', `GC${sha}`);
  if (line !== null) {
    url.searchParams.set('line', String(line));
    url.searchParams.set('lineEnd', String(line + 1));
    url.searchParams.set('lineStartColumn', '1');
    url.searchParams.set('lineEndColumn', '1');
  }
  return url.toString();
}

/**
 * Shared guts of `dova bug` and `dova wi quick`: resolve team/area/
 * iteration (silently, from saved repo-local git config in the common
 * case — see resolveCreateContext()), optionally build a --at
 * permalink, and file the item.
 */
export async function quickCreateWorkItem(runner: Runner, opts: QuickCreateOptions): Promise<QuickCreateResult> {
  const ctx = await resolveContext(runner, { project: opts.project }, { cwd: opts.cwd });
  const projectResult = await resolveProject(runner, ctx.project, { project: opts.project }, { cwd: opts.cwd });
  const createContext = await resolveCreateContext(
    runner,
    ctx.orgUrl,
    projectResult.project,
    { team: opts.team, area: opts.area, iteration: opts.iteration },
    { cwd: opts.cwd, reresolve: opts.reresolve, like: opts.like, save: opts.save }
  );

  const args = [
    'boards', 'work-item', 'create',
    '--type', opts.type,
    '--title', opts.title,
    '--area', createContext.areaPath,
    '--iteration', createContext.iterationPath,
    '--organization', ctx.orgUrl,
    '--project', projectResult.project,
  ];
  if (opts.at) {
    const permalink = await buildFoundInPermalink(runner, ctx, opts.at, opts.cwd);
    args.push('--description', `Found in: ${permalink}`);
  }

  const created = await runAzJson<AzWorkItem>(runner, args);

  return {
    id: created.id,
    url: buildWiWebUrl(ctx.orgUrl, projectResult.project, created.id),
    project: projectResult.project,
    team: createContext.team,
    areaPath: createContext.areaPath,
    iterationPath: createContext.iterationPath,
    warnings: createContext.warnings,
  };
}
