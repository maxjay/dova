import type { Runner } from './exec.js';
import { adoJson, adoUrl, projectBase } from './ado.js';

/**
 * Work item state -> category. "category" is the fixed, process-agnostic
 * bucket every process template's states map onto (Proposed / InProgress /
 * Resolved / Completed / Removed) — the state *names* are process-specific
 * and never hardcoded here, but the category vocabulary itself is a fixed
 * Azure DevOps concept, so comparing against it (unlike comparing against
 * a literal state name) doesn't assume anything about the process template.
 *
 *   GET {orgUrl}/{project}/_apis/wit/workitemtypes/{type}/states?api-version=7.1
 */
export interface WorkItemState {
  name: string;
  category: string;
  color: string;
}

export async function fetchWorkItemTypeStates(
  runner: Runner,
  orgUrl: string,
  project: string,
  type: string
): Promise<WorkItemState[]> {
  const url = adoUrl(projectBase(orgUrl, project), `_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`);
  const result = await adoJson<{ value?: WorkItemState[] }>(runner, { method: 'GET', url });
  return result?.value ?? [];
}

export function categoryOf(states: WorkItemState[], stateName: string): string | null {
  const match = states.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
  return match?.category ?? null;
}
