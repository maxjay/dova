import type { Command } from 'commander';
import { defaultRunner, tryGit, type Runner } from '../lib/exec.js';
import { resolveContext, type ResolvedContext } from '../lib/context.js';
import { fetchWorkItemsByIds, fieldValue } from '../lib/work-items.js';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption } from '../lib/command-helpers.js';
import { emit, getColor, renderTable } from '../lib/output.js';

export interface ListFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  json?: string | boolean;
  jq?: string;
  color: boolean;
}

export interface LinkedBranch {
  branch: string;
  /** Last commit's ISO date on this branch, for recency sorting — null if the ref vanished since linking. */
  lastActivity: string | null;
  primaryId: number | null;
  primaryTitle: string | null;
  otherIds: number[];
}

export interface ListResult {
  branches: LinkedBranch[];
}

/**
 * Every local branch `dova link` has ever touched, most recently active
 * first. Two git calls regardless of branch count (one combined
 * --get-regexp for both dova-workitems and dova-primary, one
 * for-each-ref for commit recency) plus one batched work item fetch for
 * every linked id across every branch at once — so this stays cheap
 * whether there are 3 linked branches or 30.
 */
export async function gatherLinkedBranches(runner: Runner, ctx: ResolvedContext, cwd?: string): Promise<LinkedBranch[]> {
  const configLines = await tryGit(runner, ['config', '--get-regexp', String.raw`^branch\..*\.dova-(workitems|primary)$`], { cwd });
  if (!configLines) return [];

  const idsByBranch = new Map<string, number[]>();
  const primaryByBranch = new Map<string, number>();
  for (const line of configLines.split('\n')) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const key = line.slice(0, spaceIdx);
    const value = line.slice(spaceIdx + 1);
    const match = key.match(/^branch\.(.+)\.dova-(workitems|primary)$/);
    if (!match) continue;
    const [, branch, kind] = match;
    if (kind === 'workitems') {
      const ids = value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length > 0) idsByBranch.set(branch!, ids);
    } else {
      primaryByBranch.set(branch!, Number(value));
    }
  }

  const branches = [...idsByBranch.keys()];
  if (branches.length === 0) return [];

  const dateLines = await tryGit(runner, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:iso-strict)', 'refs/heads/'], { cwd });
  const dateByBranch = new Map<string, string>();
  if (dateLines) {
    for (const line of dateLines.split('\n')) {
      const [branch, date] = line.split('\t');
      if (branch && date) dateByBranch.set(branch, date);
    }
  }

  const allIds = [...new Set([...idsByBranch.values()].flat())];
  const items = await fetchWorkItemsByIds(runner, ctx.orgUrl, allIds);
  const itemById = new Map(items.map((i) => [i.id, i]));

  const result: LinkedBranch[] = branches.map((branch) => {
    const ids = idsByBranch.get(branch)!;
    const primaryId = primaryByBranch.has(branch) && ids.includes(primaryByBranch.get(branch)!) ? primaryByBranch.get(branch)! : ids[0]!;
    const primaryItem = itemById.get(primaryId);
    return {
      branch,
      lastActivity: dateByBranch.get(branch) ?? null,
      primaryId,
      primaryTitle: primaryItem ? fieldValue(primaryItem, 'System.Title') : null,
      otherIds: ids.filter((id) => id !== primaryId),
    };
  });

  result.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  return result;
}

function renderListHuman(result: ListResult, color: ReturnType<typeof getColor>): void {
  if (result.branches.length === 0) {
    process.stdout.write(`${color.dim('No branches are linked to any work items yet — see `dova link`.')}\n`);
    return;
  }
  const rows = result.branches.map((b) => [
    b.branch,
    b.primaryId ? `#${b.primaryId}` : color.dim('?'),
    b.primaryTitle ?? color.dim('(title unknown)'),
    b.otherIds.length > 0 ? color.dim(`+${b.otherIds.length} more`) : '',
  ]);
  process.stdout.write(`${renderTable(['Branch', 'Primary', 'Title', ''], rows)}\n`);
}

export function registerListCommand(program: Command): void {
  const cmd = program
    .command('list')
    .description('List local branches linked to work items (see `dova link`), most recently active first');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);

  cmd.action(async (opts: ListFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);
    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });
    const branches = await gatherLinkedBranches(runner, ctx);
    const result: ListResult = { branches };
    await emit(result, opts, () => renderListHuman(result, color));
  });
}
