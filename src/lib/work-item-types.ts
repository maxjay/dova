import type { Runner } from './exec.js';
import { runAzJson } from './exec.js';

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
  const result = await runAzJson<{ value: WorkItemState[] }>(runner, ['rest', '--method', 'get', '--uri', uri]);
  return result.value ?? [];
}

export function categoryOf(states: WorkItemState[], stateName: string): string | null {
  const match = states.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
  return match?.category ?? null;
}

export function pickNextInProgressState(states: WorkItemState[]): WorkItemState | null {
  return states.find((s) => s.category === 'InProgress') ?? null;
}

export type StartTransitionDecision =
  | { action: 'transition'; toState: string }
  | { action: 'skip'; reason: string };

/**
 * `dova start`'s transition rule: only move an item forward out of the
 * "Proposed" category (New/To Do/etc — whatever this process calls it)
 * into the InProgress category. Anything already at or past InProgress is
 * skipped, never regressed.
 */
export function decideStartTransition(states: WorkItemState[], currentState: string): StartTransitionDecision {
  const category = categoryOf(states, currentState);
  if (category === null) {
    return {
      action: 'skip',
      reason: `Could not determine the category of state "${currentState}" for this work item type.`,
    };
  }
  if (category !== 'Proposed') {
    return {
      action: 'skip',
      reason: `Already past the "start" point (currently "${currentState}", category "${category}") — not regressing it.`,
    };
  }
  const next = pickNextInProgressState(states);
  if (!next) {
    return {
      action: 'skip',
      reason: 'This work item type has no state in the "InProgress" category to transition into.',
    };
  }
  return { action: 'transition', toState: next.name };
}
