import type { Runner } from './exec.js';
import { runAzJson } from './exec.js';
import type { AzBuild } from '../types/azure-devops.js';

/**
 * Web URL for a pipeline run. Format confirmed from the
 * azure-devops-cli-extension source (`_open_pipeline_run` in
 * dev/pipelines/pipeline_run.py): `{orgUrl}/{project}/_build/results?buildid={id}`.
 */
export function buildRunWebUrl(orgUrl: string, project: string, id: number): string {
  return `${orgUrl}/${encodeURIComponent(project)}/_build/results?buildid=${id}`;
}

export async function fetchRecentRuns(
  runner: Runner,
  orgUrl: string,
  project: string,
  branch: string,
  top = 3
): Promise<AzBuild[]> {
  return runAzJson<AzBuild[]>(runner, [
    'pipelines', 'runs', 'list',
    '--organization', orgUrl,
    '--project', project,
    '--branch', branch,
    '--top', String(top),
  ]);
}

export async function fetchRun(runner: Runner, orgUrl: string, project: string, id: number): Promise<AzBuild> {
  return runAzJson<AzBuild>(runner, [
    'pipelines', 'runs', 'show',
    '--id', String(id),
    '--organization', orgUrl,
    '--project', project,
  ]);
}

export function isRunFinished(run: AzBuild): boolean {
  return run.status === 'completed';
}

/** The result if the run has one, otherwise its in-flight status (e.g. "inProgress"). */
export function describeOutcome(run: AzBuild): string {
  return run.result ?? run.status;
}
