import type { Runner } from './exec.js';
import { runAzRestJson } from './exec.js';

/**
 * Team backlog configuration — this is how `dova start` tells "is this id
 * a portfolio-level type (Epic/Feature/whatever this process calls them)"
 * without hardcoding a type name: the process's backlog *levels* are data,
 * not a fixed vocabulary. There's no CLI wrapper for this (it's REST-only),
 * so this goes through `az rest`:
 *   GET {orgUrl}/{project}/{team}/_apis/work/backlogconfiguration?api-version=7.1
 */
export interface BacklogLevel {
  id: string;
  name: string;
  workItemTypes: Array<{ name: string }>;
}

export interface BacklogConfiguration {
  portfolioBacklogs?: BacklogLevel[];
  requirementBacklog?: BacklogLevel;
  taskBacklog?: BacklogLevel;
}

export async function fetchBacklogConfiguration(
  runner: Runner,
  orgUrl: string,
  project: string,
  team: string
): Promise<BacklogConfiguration> {
  const uri = `${orgUrl}/${encodeURIComponent(project)}/${encodeURIComponent(team)}/_apis/work/backlogconfiguration?api-version=7.1`;
  return runAzRestJson<BacklogConfiguration>(runner, { method: 'get', uri });
}

/** Is `typeName` one of this team's portfolio-level backlog types (Epic/Feature/etc, whatever this process calls them)? */
export function isPortfolioType(config: BacklogConfiguration, typeName: string): boolean {
  const normalized = typeName.toLowerCase();
  return (config.portfolioBacklogs ?? []).some((level) =>
    level.workItemTypes.some((t) => t.name.toLowerCase() === normalized)
  );
}
