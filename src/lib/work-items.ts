import type { Runner } from './exec.js';
import { runAzJson } from './exec.js';
import { buildWiql } from './wiql.js';
import { NotFoundError } from './errors.js';
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
  const result = await runAzJson<AzWorkItem | null>(runner, [
    'boards', 'work-item', 'show',
    '--id', String(id),
    '--organization', orgUrl,
  ]);
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

export function fieldValue(item: AzWorkItem, field: string): string | null {
  const value = item.fields[field];
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && 'displayName' in (value as Record<string, unknown>)) {
    return (value as { displayName: string }).displayName;
  }
  return String(value);
}
