import type { Runner } from './exec.js';
import { runAzJson, runAzRestJson, runAzRestText } from './exec.js';
import { NotFoundError, looksLikeAzNotFoundError } from './errors.js';
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

/* ------------------------------------------------------------------ *
 * Timeline (stage/job/task breakdown) + logs, for "why did this run
 * fail". There's no `az pipelines` command for either — confirmed
 * absent from the extension's command registry (the `pipelines runs`
 * group is only list/show/tag/artifact) — so both go through `az rest`
 * against the Build REST API directly.
 * ------------------------------------------------------------------ */

export interface AzTimelineRecord {
  id: string;
  parentId: string | null;
  /** "Stage" | "Phase" | "Job" | "Task" | "Checkpoint" — fixed system vocabulary, not process-specific. */
  type: string;
  name: string;
  state: string;
  /** "succeeded" | "failed" | "canceled" | "skipped" | "succeededWithIssues" | null while running. */
  result: string | null;
  startTime?: string | null;
  log?: { id: number; url?: string } | null;
}

function timelineUri(orgUrl: string, project: string, runId: number): string {
  return `${orgUrl}/${encodeURIComponent(project)}/_apis/build/builds/${runId}/timeline?api-version=7.1`;
}

function logUri(orgUrl: string, project: string, runId: number, logId: number): string {
  return `${orgUrl}/${encodeURIComponent(project)}/_apis/build/builds/${runId}/logs/${logId}?api-version=7.1`;
}

export async function fetchTimeline(runner: Runner, orgUrl: string, project: string, runId: number): Promise<AzTimelineRecord[]> {
  try {
    const result = await runAzRestJson<{ records: AzTimelineRecord[] } | null>(runner, {
      method: 'get',
      uri: timelineUri(orgUrl, project, runId),
    });
    return result?.records ?? [];
  } catch (err) {
    if (err instanceof Error && looksLikeAzNotFoundError(err.message)) {
      throw new NotFoundError(`Pipeline run #${runId} was not found.`);
    }
    throw err;
  }
}

export async function fetchLogText(runner: Runner, orgUrl: string, project: string, runId: number, logId: number): Promise<string> {
  return runAzRestText(runner, { method: 'get', uri: logUri(orgUrl, project, runId, logId) });
}

/**
 * Records that actually failed and produced their own log (a failing
 * Task, not the Stage/Phase rollup above it, which is also marked
 * failed but has nothing of its own worth showing) — ordered by start
 * time, so "the first one" is a reasonable root-cause guess.
 */
export function failedRecords(records: AzTimelineRecord[]): AzTimelineRecord[] {
  return records
    .filter((r) => r.result === 'failed' && r.log)
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
}
