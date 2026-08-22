import { select as inquirerSelect, confirm as inquirerConfirm, checkbox as inquirerCheckbox } from '@inquirer/prompts';
import type { ChalkInstance } from 'chalk';
import type { Runner } from './exec.js';
import { defaultRunner, runAzJson, tryGit, runGit } from './exec.js';
import { resolveContext } from './context.js';
import { resolveProject, resolveTeam } from './team-resolver.js';
import { gitConfigSet } from './config.js';
import { fetchWorkItemsByIds, buildWiWebUrl, fieldValue } from './work-items.js';
import { buildWiql } from './wiql.js';
import { fetchBacklogConfiguration, isPortfolioType } from './backlog.js';
import { fetchWorkItemTypeStates, decideStartTransition } from './work-item-types.js';
import { slugify, resolveBranchPrefix, buildBranchName } from './branch-naming.js';
import { UserError } from './errors.js';
import type { AzWorkItem } from '../types/azure-devops.js';

export interface StartPrompts {
  select(config: { message: string; choices: Array<{ name: string; value: string }> }): Promise<string>;
  confirm(config: { message: string; default?: boolean }): Promise<boolean>;
  checkbox(config: {
    message: string;
    choices: Array<{ name: string; value: string; checked?: boolean }>;
  }): Promise<string[]>;
}

const defaultStartPrompts: StartPrompts = {
  select: (c) => inquirerSelect(c),
  confirm: (c) => inquirerConfirm(c),
  checkbox: (c) => inquirerCheckbox(c),
};

export interface StartOptions {
  ids: string[];
  primary?: string;
  /** true = --assign, false = --no-assign, undefined = ask (once) when there's anything unassigned. */
  assign?: boolean;
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  team?: string;
  reresolve?: boolean;
  json?: string | boolean;
  color: ChalkInstance;
  cwd?: string;
  runner?: Runner;
  prompts?: StartPrompts;
}

export interface StartWorkItemSummary {
  id: number;
  title: string;
  type: string;
  primary: boolean;
}

export interface StartResult {
  branch: string;
  base: string;
  switchedToExisting: boolean;
  workItems: StartWorkItemSummary[];
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
function itemAssignee(item: AzWorkItem): string | null {
  return fieldValue(item, 'System.AssignedTo');
}

/** `dova start` — see the project brief for the full behavior this implements. */
export async function runStart(opts: StartOptions): Promise<StartResult> {
  const runner = opts.runner ?? defaultRunner;
  const prompts = opts.prompts ?? defaultStartPrompts;
  const color = opts.color;
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
  const projectResult = await resolveProject(runner, ctx.project, { project: opts.project }, { cwd });
  const teamResult = await resolveTeam(runner, ctx.orgUrl, projectResult.project, { team: opts.team }, { cwd, reresolve: opts.reresolve });

  // Call: fetch the seed items in one batch.
  const seedItems = await fetchWorkItemsByIds(runner, ctx.orgUrl, seedIds);
  const seedById = new Map(seedItems.map((i) => [i.id, i]));
  for (const id of seedIds) {
    if (!seedById.has(id)) throw new UserError(`Work item #${id} was not found.`);
  }

  // Portfolio-level ids (Epic/Feature/whatever this process calls them,
  // determined from the team's backlog configuration, never a hardcoded
  // type name) expand into a multi-select of their non-completed children.
  const backlogConfig = await fetchBacklogConfiguration(runner, ctx.orgUrl, projectResult.project, teamResult.team);
  const actualPortfolioIds = seedIds.filter((id) => isPortfolioType(backlogConfig, itemType(seedById.get(id)!)));

  const workItemById = new Map<number, AzWorkItem>(seedItems.map((i) => [i.id, i]));
  let finalIds: number[] = [];

  if (actualPortfolioIds.length > 0) {
    const childrenWiql = buildWiql({
      fields: ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo', 'System.Parent'],
      where: [{ field: 'System.Parent', op: 'IN', value: actualPortfolioIds }],
    });
    const children = (await runAzJson<AzWorkItem[] | null>(runner, [
      'boards', 'query', '--wiql', childrenWiql, '--organization', ctx.orgUrl,
    ])) ?? [];
    for (const child of children) workItemById.set(child.id, child);

    // Need each distinct child type's state categories to drop Completed/Removed items.
    const childTypesToCheck = [...new Set(children.map(itemType))];
    const statesByType = new Map<string, Awaited<ReturnType<typeof fetchWorkItemTypeStates>>>();
    for (const type of childTypesToCheck) {
      statesByType.set(type, await fetchWorkItemTypeStates(runner, ctx.orgUrl, projectResult.project, type));
    }
    const isCompletedOrRemoved = (child: AzWorkItem): boolean => {
      const states = statesByType.get(itemType(child)) ?? [];
      const category = states.find((s) => s.name.toLowerCase() === itemState(child).toLowerCase())?.category;
      return category === 'Completed' || category === 'Removed';
    };

    for (const parentId of actualPortfolioIds) {
      const candidates = children.filter((c) => c.fields['System.Parent'] === parentId).filter((c) => !isCompletedOrRemoved(c));
      const parent = workItemById.get(parentId)!;
      if (candidates.length === 0) {
        warnings.push(`#${parentId} (${itemTitle(parent)}) has no open children — nothing to start from it.`);
        continue;
      }
      const selected = await prompts.checkbox({
        message: `#${parentId} "${itemTitle(parent)}" is a portfolio item — pick which children to start:`,
        choices: candidates.map((c) => ({
          name: `#${c.id} [${itemType(c)}/${itemState(c)}] ${itemTitle(c)}`,
          value: String(c.id),
          checked: true,
        })),
      });
      finalIds.push(...selected.map(Number));
    }
    // Non-portfolio seed ids pass through untouched, in their original order.
    finalIds.push(...seedIds.filter((id) => !actualPortfolioIds.includes(id)));
  } else {
    finalIds = [...seedIds];
  }
  finalIds = [...new Set(finalIds)];

  if (finalIds.length === 0) {
    throw new UserError('Nothing to start — every portfolio item resolved to zero open children.');
  }

  // Primary: explicit --primary, else the first id in the resolved set
  // that traces back to the first id the user actually typed.
  let primaryId: number;
  if (opts.primary) {
    primaryId = Number(opts.primary);
    if (!finalIds.includes(primaryId)) {
      throw new UserError(`--primary ${opts.primary} is not in the resolved work item set.`, [
        `Resolved set: ${finalIds.join(', ')}`,
      ]);
    }
  } else {
    primaryId = finalIds[0]!;
  }
  const primaryItem = workItemById.get(primaryId)!;

  // Duplicate-tracking check: has any local branch already got this exact
  // work linked? `--get-regexp` reads every branch's dova-workitems config
  // in one call, rather than one `git config` call per local branch.
  const existing = await tryGit(runner, ['config', '--get-regexp', '^branch\\..*\\.dova-workitems$'], { cwd });
  if (existing) {
    for (const line of existing.split('\n')) {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) continue;
      const key = line.slice(0, spaceIdx);
      const value = line.slice(spaceIdx + 1);
      const branchName = key.slice('branch.'.length, key.length - '.dova-workitems'.length);
      const trackedIds = value.split(',').map((s) => Number(s.trim()));
      if (trackedIds.some((id) => finalIds.includes(id))) {
        const shouldSwitch = await prompts.confirm({
          message: `Branch "${branchName}" already tracks this work — switch to it instead of creating a new branch?`,
          default: true,
        });
        if (shouldSwitch) {
          await runGit(runner, ['checkout', branchName], { cwd });
          return {
            branch: branchName,
            base: branchName,
            switchedToExisting: true,
            workItems: finalIds.map((id) => ({
              id,
              title: itemTitle(workItemById.get(id)!),
              type: itemType(workItemById.get(id)!),
              primary: id === primaryId,
            })),
            warnings,
          };
        }
      }
    }
  }

  // Best-effort, non-authoritative secondary check against locally-known
  // remote branches (no network call — whatever's already been fetched).
  const remoteBranches = await tryGit(runner, ['branch', '-r'], { cwd });
  if (remoteBranches) {
    for (const id of finalIds) {
      const hit = remoteBranches.split('\n').map((s) => s.trim()).find((b) => new RegExp(`[/-]${id}(\\D|$)`).test(b));
      if (hit) {
        warnings.push(`Found remote branch "${hit}" that might already track #${id} (best-effort match, unverified — check manually).`);
      }
    }
  }

  const base = (await tryGit(runner, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })) ?? 'HEAD';
  const prefix = await resolveBranchPrefix(runner, itemType(primaryItem));
  const slug = slugify(itemTitle(primaryItem));
  const branchName = buildBranchName(prefix, primaryId, slug);
  await runGit(runner, ['checkout', '-b', branchName], { cwd });

  // Track locally right after the branch exists — never pushed, same
  // mechanism git itself uses for branch.<name>.merge — so the tracking
  // survives even if a transition/assignment call below fails or is
  // interrupted partway through a multi-item batch.
  await gitConfigSet(runner, `branch.${branchName}.dova-workitems`, finalIds.join(','), { cwd });
  await gitConfigSet(runner, `branch.${branchName}.dova-primary`, String(primaryId), { cwd });

  // Transition each item forward out of "Proposed" category, never regressing one already past it.
  const statesByType = new Map<string, Awaited<ReturnType<typeof fetchWorkItemTypeStates>>>();
  const unassignedIds: number[] = [];
  for (const id of finalIds) {
    const item = workItemById.get(id)!;
    const type = itemType(item);
    if (!statesByType.has(type)) {
      statesByType.set(type, await fetchWorkItemTypeStates(runner, ctx.orgUrl, projectResult.project, type));
    }
    const decision = decideStartTransition(statesByType.get(type)!, itemState(item));
    if (decision.action === 'transition') {
      await runAzJson(runner, ['boards', 'work-item', 'update', '--id', String(id), '--state', decision.toState, '--organization', ctx.orgUrl]);
    } else {
      warnings.push(`#${id}: ${decision.reason}`);
    }
    if (!itemAssignee(item)) unassignedIds.push(id);
  }

  // Assignment: one confirm for the whole batch, unless --assign/--no-assign already decided it.
  if (unassignedIds.length > 0) {
    const shouldAssign =
      opts.assign !== undefined
        ? opts.assign
        : await prompts.confirm({
            message:
              unassignedIds.length === 1
                ? `Assign #${unassignedIds[0]} to you?`
                : `Assign ${unassignedIds.length} unassigned item(s) to you?`,
            default: true,
          });
    if (shouldAssign) {
      for (const id of unassignedIds) {
        await runAzJson(runner, ['boards', 'work-item', 'update', '--id', String(id), '--assigned-to', 'me', '--organization', ctx.orgUrl]);
      }
    }
  }

  return {
    branch: branchName,
    base,
    switchedToExisting: false,
    workItems: finalIds.map((id) => ({
      id,
      title: itemTitle(workItemById.get(id)!),
      type: itemType(workItemById.get(id)!),
      primary: id === primaryId,
    })),
    warnings,
  };
}

export function renderStartHuman(result: StartResult, color: ChalkInstance): void {
  const lines: string[] = [];
  if (result.switchedToExisting) {
    lines.push(color.yellow(`Already tracked — switched to existing branch.`));
  }
  lines.push(`${color.bold('Branch:')} ${result.branch}`);
  lines.push(`${color.bold('Base:')} ${result.base}`);
  lines.push('');
  lines.push(color.bold('Work items:'));
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
