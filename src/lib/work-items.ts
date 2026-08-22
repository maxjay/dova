import type { ChalkInstance } from 'chalk';
import type { Runner } from './exec.js';
import { runAzJson } from './exec.js';
import { buildWiql } from './wiql.js';
import { renderTable } from './output.js';
import { NotFoundError, looksLikeAzNotFoundError } from './errors.js';
import type { AzWorkItem } from '../types/azure-devops.js';

/**
 * Web URL for a single work item. Format confirmed from the
 * azure-devops-cli-extension source (`_open_work_item` in
 * dev/boards/work_item.py): `{orgUrl}/{project}/_workitems?id={id}`.
 */
export function buildWiWebUrl(orgUrl: string, project: string, id: number): string {
  return `${orgUrl}/${encodeURIComponent(project)}/_workitems?id=${id}`;
}

export async function fetchWorkItem(runner: Runner, orgUrl: string, id: number): Promise<AzWorkItem> {
  let result: AzWorkItem | null;
  try {
    result = await runAzJson<AzWorkItem | null>(runner, [
      'boards', 'work-item', 'show',
      '--id', String(id),
      '--organization', orgUrl,
    ]);
  } catch (err) {
    // A nonexistent id fails the az call outright (nonzero exit), rather
    // than succeeding with an empty result — see looksLikeAzNotFoundError.
    if (err instanceof Error && looksLikeAzNotFoundError(err.message)) {
      throw new NotFoundError(`Work item #${id} was not found.`);
    }
    throw err;
  }
  if (!result) {
    throw new NotFoundError(`Work item #${id} was not found.`);
  }
  return result;
}

/**
 * Batch-fetches several work items by id in a single call. There's no
 * native "show many" command (`work-item show` takes one --id), so this
 * goes through `az boards query --wiql` instead — one call for N ids.
 * Returns [] for an empty `ids` array without making a call.
 */
export async function fetchWorkItemsByIds(
  runner: Runner,
  orgUrl: string,
  ids: number[],
  fields: string[] = ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo']
): Promise<AzWorkItem[]> {
  if (ids.length === 0) return [];
  const wiql = buildWiql({ fields, where: [{ field: 'System.Id', op: 'IN', value: ids }] });
  const result = await runAzJson<AzWorkItem[] | null>(runner, [
    'boards', 'query',
    '--wiql', wiql,
    '--organization', orgUrl,
  ]);
  return result ?? [];
}

/** Direct children of a work item (via System.Parent — a queryable reference field on every process template). */
export async function fetchChildren(runner: Runner, orgUrl: string, parentId: number): Promise<AzWorkItem[]> {
  const wiql = buildWiql({
    fields: ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType'],
    where: [{ field: 'System.Parent', op: '=', value: parentId }],
  });
  const result = await runAzJson<AzWorkItem[] | null>(runner, ['boards', 'query', '--wiql', wiql, '--organization', orgUrl]);
  return result ?? [];
}

export function fieldValue(item: AzWorkItem, field: string): string | null {
  const value = item.fields[field];
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && 'displayName' in (value as Record<string, unknown>)) {
    return (value as { displayName: string }).displayName;
  }
  return String(value);
}

export interface WorkItemRef {
  id: number;
  title: string | null;
  type: string | null;
  state: string | null;
}

export interface WorkItemDetail extends WorkItemRef {
  assignedTo: string | null;
  areaPath: string | null;
  iterationPath: string | null;
  description: string | null;
  parent: WorkItemRef | null;
  /** Direct children (e.g. a Feature's User Stories) — populated for any type, not just portfolio levels. */
  children: WorkItemRef[];
  url: string;
}

function toRef(item: AzWorkItem): WorkItemRef {
  return {
    id: item.id,
    title: fieldValue(item, 'System.Title'),
    type: fieldValue(item, 'System.WorkItemType'),
    state: fieldValue(item, 'System.State'),
  };
}

/**
 * Full detail for a single work item, the way both `dova wi view` and
 * `dova view` render it: the item itself, its parent (by id, hydrated
 * with title/type/state when the fetch succeeds), and its direct children
 * — generic across every work item type, so a Feature's User Stories (or
 * an Epic's Features, or a bug's linked tasks) all come back the same
 * shape without dova knowing anything process-specific about any of them.
 */
export async function gatherWorkItemDetail(
  runner: Runner,
  orgUrl: string,
  id: number,
  fallbackProject?: string
): Promise<WorkItemDetail> {
  const item = await fetchWorkItem(runner, orgUrl, id);
  const project = fieldValue(item, 'System.TeamProject') ?? fallbackProject ?? '';
  const parentIdRaw = item.fields['System.Parent'];
  const parentId = typeof parentIdRaw === 'number' ? parentIdRaw : undefined;

  const [children, parentItem] = await Promise.all([
    fetchChildren(runner, orgUrl, id),
    parentId ? fetchWorkItem(runner, orgUrl, parentId).catch(() => null) : Promise.resolve(null),
  ]);

  return {
    ...toRef(item),
    assignedTo: fieldValue(item, 'System.AssignedTo'),
    areaPath: fieldValue(item, 'System.AreaPath'),
    iterationPath: fieldValue(item, 'System.IterationPath'),
    description: fieldValue(item, 'System.Description'),
    parent: parentItem ? toRef(parentItem) : parentId ? { id: parentId, title: null, type: null, state: null } : null,
    children: children.map(toRef),
    url: buildWiWebUrl(orgUrl, project, item.id),
  };
}

/** Human rendering of `WorkItemDetail`, shared by `dova wi view` and `dova view`. */
export function renderWorkItemDetailHuman(detail: WorkItemDetail, color: ChalkInstance): void {
  const lines: string[] = [
    `${color.bold(`#${detail.id}`)} ${detail.title ?? color.dim('(no title)')}`,
    `${color.dim(String(detail.type))} · ${color.dim(String(detail.state))}${detail.assignedTo ? ` · ${color.dim(`assigned to ${detail.assignedTo}`)}` : color.dim(' · unassigned')}`,
    '',
    `Area:      ${detail.areaPath ?? color.dim('(none)')}`,
    `Iteration: ${detail.iterationPath ?? color.dim('(none)')}`,
  ];
  if (detail.parent) {
    const p = detail.parent;
    lines.push(`Parent:    #${p.id}${p.title ? ` ${p.title}` : ''}${p.type ? color.dim(` [${p.type}]`) : ''}`);
  }
  lines.push('', color.dim(detail.url));

  if (detail.children.length > 0) {
    lines.push('', color.bold(`Children (${detail.children.length})`));
    lines.push(
      renderTable(
        ['ID', 'Type', 'Title', 'State'],
        detail.children.map((c) => [`#${c.id}`, c.type ?? '?', c.title ?? '(no title)', c.state ?? '?'])
      )
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}
