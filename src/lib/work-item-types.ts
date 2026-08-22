import type { Runner } from './exec.js';
import { runAzRestJson } from './exec.js';

/**
 * Work item state -> category. "category" is the fixed, process-agnostic
 * bucket every process template's states map onto (Proposed / InProgress /
 * Resolved / Completed / Removed) — the state *names* are process-specific
 * and never hardcoded here, but the category vocabulary itself is a fixed
 * Azure DevOps concept, so comparing against it (unlike comparing against
 * a literal state name) doesn't assume anything about the process template.
 *
 * There is no `az boards work-item-type` command group in the
 * azure-devops-cli-extension (confirmed absent from its command registry),
 * so this goes through `az rest` against the REST API directly:
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
  const uri = `${orgUrl}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?api-version=7.1`;
  const result = await runAzRestJson<{ value: WorkItemState[] }>(runner, { method: 'get', uri });
  return result.value ?? [];
}

export function categoryOf(states: WorkItemState[], stateName: string): string | null {
  const match = states.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
  return match?.category ?? null;
}
