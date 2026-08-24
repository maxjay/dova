import { confirm as inquirerConfirm, checkbox as inquirerCheckbox } from '@inquirer/prompts';
import type { ChalkInstance } from 'chalk';
import type { Runner } from './exec.js';
import { defaultRunner, runAzJson, tryGit, runGit } from './exec.js';
import { resolveContext } from './context.js';
import { gitConfigGet, gitConfigSet } from './config.js';
import { fetchWorkItemsByIds, fieldValue } from './work-items.js';
import { buildWiql } from './wiql.js';
import { fetchWorkItemTypeStates, categoryOf } from './work-item-types.js';
import { UserError, NotFoundError } from './errors.js';
import { isInteractive, nonInteractiveError } from './interactive.js';
import type { AzWorkItem } from '../types/azure-devops.js';

export interface LinkPrompts {
  confirm(config: { message: string; default?: boolean }): Promise<boolean>;
  checkbox(config: {
    message: string;
    choices: Array<{ name: string; value: string; checked?: boolean }>;
    /** Flag(s)/args that would have answered this, quoted back when dova can't prompt. */
    nonInteractiveHint?: string[];
  }): Promise<string[]>;
}

const defaultLinkPrompts: LinkPrompts = {
  // A "no" here means: don't switch branches. Checking out another
  // branch unasked would move the working tree out from under whoever
  // called us mid-task, so non-interactively this must never be a yes,
  // even though the interactive default is.
  confirm: (c) => (isInteractive() ? inquirerConfirm(c) : Promise.resolve(false)),
  checkbox: ({ nonInteractiveHint, ...c }) => {
    if (!isInteractive()) {
      return Promise.reject(nonInteractiveError(c.message, nonInteractiveHint, c.choices.map((choice) => `#${choice.value}`)));
    }
    return inquirerCheckbox(c);
  },
};

export interface LinkOptions {
  ids: string[];
  primary?: string;
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  json?: string | boolean;
  color: ChalkInstance;
  cwd?: string;
  runner?: Runner;
  prompts?: LinkPrompts;
}

export interface LinkWorkItemSummary {
  id: number;
  title: string;
  type: string;
  primary: boolean;
}

export interface LinkResult {
  branch: string;
  switchedToExisting: boolean;
  workItems: LinkWorkItemSummary[];
  warnings: string[];
}

function itemTitle(item: AzWorkItem): string {
  return fieldValue(item, 'System.Title') ?? `#${item.id}`;
}
function itemType(item: AzWorkItem): string {
  return fieldValue(item, 'System.WorkItemType') ?? 'Unknown';
}
function itemState(item: AzWorkItem): string {
  return fieldValue(item, 'System.State') ?? 'Unknown';
}

/**
 * `dova link` — the whole of dova's involvement in "begin work on a
 * ticket." dova is not a replacement for git: creating and naming the
 * branch, checking it out, doing the work — that's git, already the
 * agent's or developer's own job, before this ever runs. This command's
 * entire responsibility is the one thing git has no concept of:
 * recording that the branch you're already standing on corresponds to
 * these ticket(s), so `dova pr create` can read that back out and link
 * them automatically. See README.md's "Context linkage, not workflow"
 * section for the full scenario this implements.
 */
export async function runLink(opts: LinkOptions): Promise<LinkResult> {
  const runner = opts.runner ?? defaultRunner;
  const prompts = opts.prompts ?? defaultLinkPrompts;
  const cwd = opts.cwd;
  const warnings: string[] = [];

  const seedIds = [...new Set(opts.ids.map((s) => Number(s)))];
  if (seedIds.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new UserError(`One or more ids are not valid work item ids: ${opts.ids.join(', ')}`);
  }

  const ctx = await resolveContext(
    runner,
    { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo },
    { cwd }
  );

  const currentBranch = await tryGit(runner, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (!currentBranch || currentBranch === 'HEAD') {
    throw new UserError('Not currently on a branch (detached HEAD?).', [
      'dova link records which branch you\'re already on — check one out first.',
    ]);
  }

  // Call: fetch the seed items in one batch — also validates they exist.
  const seedItems = await fetchWorkItemsByIds(runner, ctx.orgUrl, seedIds);
  const seedById = new Map(seedItems.map((i) => [i.id, i]));
  for (const id of seedIds) {
    if (!seedById.has(id)) throw new UserError(`Work item #${id} was not found.`);
  }
  const workItemById = new Map<number, AzWorkItem>(seedItems.map((i) => [i.id, i]));

  const statesByType = new Map<string, Awaited<ReturnType<typeof fetchWorkItemTypeStates>>>();
  async function isCompletedOrRemoved(item: AzWorkItem): Promise<boolean> {
    const type = itemType(item);
    if (!statesByType.has(type)) {
      statesByType.set(type, await fetchWorkItemTypeStates(runner, ctx.orgUrl, ctx.project, type));
    }
    const category = categoryOf(statesByType.get(type)!, itemState(item));
    return category === 'Completed' || category === 'Removed';
  }

  // Any id with open children (whatever it's called — Epic, Feature, or
  // just a Bug someone's been using as a checklist) expands into a
  // multi-select of them, straight off the ticket's own hierarchy.
  const childrenWiql = buildWiql({
    fields: ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.Parent'],
    where: [{ field: 'System.Parent', op: 'IN', value: seedIds }],
  });
  const children = (await runAzJson<AzWorkItem[] | null>(runner, [
    'boards', 'query', '--wiql', childrenWiql, '--organization', ctx.orgUrl,
  ])) ?? [];
  for (const child of children) workItemById.set(child.id, child);

  let finalIds: number[] = [];
  for (const seedId of seedIds) {
    const ownChildren = children.filter((c) => c.fields['System.Parent'] === seedId);
    if (ownChildren.length === 0) {
      finalIds.push(seedId);
      continue;
    }

    const openChildren: AzWorkItem[] = [];
    for (const child of ownChildren) {
      if (!(await isCompletedOrRemoved(child))) openChildren.push(child);
    }
    if (openChildren.length === 0) {
      warnings.push(`#${seedId} (${itemTitle(seedById.get(seedId)!)}) has children, but none are open — nothing to link from it.`);
      continue;
    }

    const selected = await prompts.checkbox({
      message: `#${seedId} "${itemTitle(seedById.get(seedId)!)}" has open children — pick which to link:`,
      choices: openChildren.map((c) => ({
        name: `#${c.id} [${itemType(c)}/${itemState(c)}] ${itemTitle(c)}`,
        value: String(c.id),
        checked: true,
      })),
      nonInteractiveHint: ['Pass the ids you want directly, e.g. `dova link ' + openChildren.map((c) => c.id).join(' ') + '`.'],
    });
    finalIds.push(...selected.map(Number));
  }
  finalIds = [...new Set(finalIds)];

  if (finalIds.length === 0) {
    throw new UserError('Nothing to link — every item resolved to zero open children.');
  }

  // Is any of this work already linked to a *different* branch? Offer to
  // switch there instead of double-tracking the same ticket in two
  // places. Checking out an existing branch isn't branch lifecycle
  // management (nothing is created or named) — it's the same kind of
  // navigation `gh pr checkout` does.
  const existing = await tryGit(runner, ['config', '--get-regexp', '^branch\\..*\\.dova-workitems$'], { cwd });
  if (existing) {
    for (const line of existing.split('\n')) {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) continue;
      const key = line.slice(0, spaceIdx);
      const value = line.slice(spaceIdx + 1);
      const branchName = key.slice('branch.'.length, key.length - '.dova-workitems'.length);
      if (branchName === currentBranch) continue;
      const trackedIds = value.split(',').map((s) => Number(s.trim()));
      if (trackedIds.some((id) => finalIds.includes(id))) {
        const shouldSwitch = await prompts.confirm({
          message: `Branch "${branchName}" already links this work — switch to it instead of linking here too?`,
          default: true,
        });
        if (shouldSwitch) {
          await runGit(runner, ['checkout', branchName], { cwd });
          const otherPrimary = await gitConfigGet(runner, `branch.${branchName}.dova-primary`, { cwd });
          return {
            branch: branchName,
            switchedToExisting: true,
            workItems: finalIds.map((id) => ({
              id,
              title: itemTitle(workItemById.get(id)!),
              type: itemType(workItemById.get(id)!),
              primary: otherPrimary ? id === Number(otherPrimary) : id === finalIds[0],
            })),
            warnings,
          };
        }
      }
    }
  }

  // Best-effort, non-authoritative check against locally-known remote
  // branches (no network call — whatever's already been fetched).
  const remoteBranches = await tryGit(runner, ['branch', '-r'], { cwd });
  if (remoteBranches) {
    for (const id of finalIds) {
      const hit = remoteBranches.split('\n').map((s) => s.trim()).find((b) => new RegExp(`[/-]${id}(\\D|$)`).test(b));
      if (hit) {
        warnings.push(`Found remote branch "${hit}" that might already track #${id} (best-effort match, unverified — check manually).`);
      }
    }
  }

  // Merge with whatever's already linked to this branch — `dova link`
  // run again just adds more tickets to the same branch, it doesn't
  // clobber what was there.
  const existingOnCurrent = await gitConfigGet(runner, `branch.${currentBranch}.dova-workitems`, { cwd });
  const existingPrimary = await gitConfigGet(runner, `branch.${currentBranch}.dova-primary`, { cwd });
  const mergedIds = [...new Set([...(existingOnCurrent ? existingOnCurrent.split(',').map(Number) : []), ...finalIds])];

  let primaryId: number;
  if (opts.primary) {
    primaryId = Number(opts.primary);
    if (!mergedIds.includes(primaryId)) {
      throw new UserError(`--primary ${opts.primary} is not in the linked work item set.`, [
        `Linked set: ${mergedIds.join(', ')}`,
      ]);
    }
  } else if (existingPrimary && mergedIds.includes(Number(existingPrimary))) {
    primaryId = Number(existingPrimary);
  } else {
    primaryId = mergedIds[0]!;
  }

  await gitConfigSet(runner, `branch.${currentBranch}.dova-workitems`, mergedIds.join(','), { cwd });
  await gitConfigSet(runner, `branch.${currentBranch}.dova-primary`, String(primaryId), { cwd });

  // Hydrate any merged-in ids that weren't part of this call's own fetch.
  const missingIds = mergedIds.filter((id) => !workItemById.has(id));
  if (missingIds.length > 0) {
    const hydrated = await fetchWorkItemsByIds(runner, ctx.orgUrl, missingIds);
    for (const item of hydrated) workItemById.set(item.id, item);
  }

  return {
    branch: currentBranch,
    switchedToExisting: false,
    workItems: mergedIds.map((id) => ({
      id,
      title: itemTitle(workItemById.get(id)!),
      type: itemType(workItemById.get(id)!),
      primary: id === primaryId,
    })),
    warnings,
  };
}

export function renderLinkHuman(result: LinkResult, color: ChalkInstance): void {
  const lines: string[] = [];
  if (result.switchedToExisting) {
    lines.push(color.yellow('Already linked elsewhere — switched to that branch.'));
  }
  lines.push(`${color.bold('Branch:')} ${result.branch}`);
  lines.push('');
  lines.push(color.bold('Linked work items:'));
  for (const wi of result.workItems) {
    const marker = wi.primary ? color.cyan(' (primary)') : '';
    lines.push(`  #${wi.id} [${wi.type}] ${wi.title}${marker}`);
  }
  if (result.warnings.length > 0) {
    lines.push('');
    for (const w of result.warnings) lines.push(color.yellow(`Warning: ${w}`));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

export interface UnlinkOptions {
  /** Ids to remove. Ignored (may be empty) when `all` is set. */
  ids: string[];
  /** Remove every linked id from this branch, instead of just the given ones. */
  all?: boolean;
  /** Which id to keep as primary among what remains, if not implied. */
  primary?: string;
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  json?: string | boolean;
  color: ChalkInstance;
  cwd?: string;
  runner?: Runner;
}

export interface UnlinkResult {
  branch: string;
  removedIds: number[];
  workItems: LinkWorkItemSummary[];
  warnings: string[];
}

/**
 * `dova unlink` — the undo for a bad `dova link`. Same git-config-only
 * scope as `link`: removes id(s) from the branch you're already on,
 * picks a new primary if the old one got removed, and clears the config
 * entirely once nothing's left linked. No az calls beyond hydrating
 * titles for the remaining items, for a confirmation that reads the
 * same way `link`'s own output does.
 */
export async function runUnlink(opts: UnlinkOptions): Promise<UnlinkResult> {
  const runner = opts.runner ?? defaultRunner;
  const cwd = opts.cwd;
  const warnings: string[] = [];

  if (!opts.all && opts.ids.length === 0) {
    throw new UserError('Nothing to unlink — pass one or more ids, or --all.');
  }

  const currentBranch = await tryGit(runner, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (!currentBranch || currentBranch === 'HEAD') {
    throw new UserError('Not currently on a branch (detached HEAD?).', [
      "dova unlink removes ids from the branch you're already on — check one out first.",
    ]);
  }

  const existingRaw = await gitConfigGet(runner, `branch.${currentBranch}.dova-workitems`, { cwd });
  const existingIds = existingRaw ? existingRaw.split(',').map(Number) : [];
  if (existingIds.length === 0) {
    throw new NotFoundError(`Branch "${currentBranch}" has no linked work items.`);
  }
  const existingPrimary = await gitConfigGet(runner, `branch.${currentBranch}.dova-primary`, { cwd });

  let removedIds: number[];
  if (opts.all) {
    removedIds = existingIds;
  } else {
    const requestedIds = [...new Set(opts.ids.map((s) => Number(s)))];
    if (requestedIds.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new UserError(`One or more ids are not valid work item ids: ${opts.ids.join(', ')}`);
    }
    removedIds = requestedIds.filter((id) => existingIds.includes(id));
    const notFound = requestedIds.filter((id) => !existingIds.includes(id));
    if (notFound.length > 0) {
      warnings.push(`Not currently linked to this branch, nothing to remove: ${notFound.map((id) => `#${id}`).join(', ')}`);
    }
    if (removedIds.length === 0) {
      throw new UserError(`None of the given ids are linked to branch "${currentBranch}".`, [
        `Currently linked: ${existingIds.map((id) => `#${id}`).join(', ')}`,
      ]);
    }
  }

  const remainingIds = existingIds.filter((id) => !removedIds.includes(id));

  if (remainingIds.length === 0) {
    await tryGit(runner, ['config', '--unset', `branch.${currentBranch}.dova-workitems`], { cwd });
    await tryGit(runner, ['config', '--unset', `branch.${currentBranch}.dova-primary`], { cwd });
    return { branch: currentBranch, removedIds, workItems: [], warnings };
  }

  let primaryId: number;
  if (opts.primary) {
    primaryId = Number(opts.primary);
    if (!remainingIds.includes(primaryId)) {
      throw new UserError(`--primary ${opts.primary} is not among the remaining linked ids.`, [
        `Remaining: ${remainingIds.map((id) => `#${id}`).join(', ')}`,
      ]);
    }
  } else if (existingPrimary && remainingIds.includes(Number(existingPrimary))) {
    primaryId = Number(existingPrimary);
  } else {
    primaryId = remainingIds[0]!;
  }

  await gitConfigSet(runner, `branch.${currentBranch}.dova-workitems`, remainingIds.join(','), { cwd });
  await gitConfigSet(runner, `branch.${currentBranch}.dova-primary`, String(primaryId), { cwd });

  const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo }, { cwd });
  const hydrated = await fetchWorkItemsByIds(runner, ctx.orgUrl, remainingIds);
  const byId = new Map(hydrated.map((i) => [i.id, i]));

  return {
    branch: currentBranch,
    removedIds,
    workItems: remainingIds.map((id) => {
      const item = byId.get(id);
      return {
        id,
        title: item ? itemTitle(item) : `#${id}`,
        type: item ? itemType(item) : 'Unknown',
        primary: id === primaryId,
      };
    }),
    warnings,
  };
}

export function renderUnlinkHuman(result: UnlinkResult, color: ChalkInstance): void {
  const lines: string[] = [
    `${color.bold('Removed:')} ${result.removedIds.map((id) => `#${id}`).join(', ')}`,
    `${color.bold('Branch:')} ${result.branch}`,
    '',
  ];
  if (result.workItems.length === 0) {
    lines.push(color.dim('No work items linked to this branch anymore.'));
  } else {
    lines.push(color.bold('Still linked:'));
    for (const wi of result.workItems) {
      const marker = wi.primary ? color.cyan(' (primary)') : '';
      lines.push(`  #${wi.id} [${wi.type}] ${wi.title}${marker}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push('');
    for (const w of result.warnings) lines.push(color.yellow(`Warning: ${w}`));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
