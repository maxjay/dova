import type { Runner } from './exec.js';
import { adoJson, adoText, adoUrl, projectBase } from './ado.js';
import { NotFoundError } from './errors.js';
import type { AzBuild } from '../types/azure-devops.js';

/** Web URL for a pipeline run: `{orgUrl}/{project}/_build/results?buildid={id}`. */
export function buildRunWebUrl(orgUrl: string, project: string, id: number): string {
  return `${orgUrl}/${encodeURIComponent(project)}/_build/results?buildid=${id}`;
}

/** `refs/heads/x` for a bare name; already-qualified refs pass through. */
export function toHeadRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

/**
 * The ref a PR's build-validation runs report. Azure DevOps builds a
 * temporary merge commit — the target branch as it would look after the
 * merge — so these never appear under the source branch's own ref.
 * `toHeadRef` passes `refs/pull/...` through untouched, so this can be
 * handed to `fetchRecentRuns` directly.
 */
export function prMergeRef(pullRequestId: number): string {
  return `refs/pull/${pullRequestId}/merge`;
}

/**
 * Recent pipeline runs **for this branch**.
 *
 * The request already filters by `branchName`, but the answer is
 * filtered again here against each run's own `sourceBranch`. A run for
 * another ref showing up in a branch's status is worse than showing
 * nothing: it reads as this branch's CI and isn't.
 *
 * Over-fetches so the filter has something to trim rather than
 * returning fewer than asked for. Same single request either way.
 */
export async function fetchRecentRuns(
  runner: Runner,
  orgUrl: string,
  project: string,
  branch: string,
  top = 3
): Promise<AzBuild[]> {
  const wanted = toHeadRef(branch);
  const res = await adoJson<{ value?: AzBuild[] }>(runner, {
    method: 'GET',
    url: adoUrl(projectBase(orgUrl, project), '_apis/build/builds', {
      branchName: wanted,
      $top: Math.max(top * 4, 20),
      queryOrder: 'queueTimeDescending',
    }),
  });
  const runs = res?.value ?? [];
  return runs.filter((run) => run.sourceBranch === undefined || run.sourceBranch === wanted).slice(0, top);
}

export async function fetchRun(runner: Runner, orgUrl: string, project: string, id: number): Promise<AzBuild> {
  try {
    return await adoJson<AzBuild>(runner, { method: 'GET', url: adoUrl(projectBase(orgUrl, project), `_apis/build/builds/${id}`) });
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError(`Pipeline run #${id} was not found.`);
    throw err;
  }
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
 * fail".
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
  return adoUrl(projectBase(orgUrl, project), `_apis/build/builds/${runId}/timeline`);
}

function logUri(orgUrl: string, project: string, runId: number, logId: number): string {
  return adoUrl(projectBase(orgUrl, project), `_apis/build/builds/${runId}/logs/${logId}`);
}

export async function fetchTimeline(runner: Runner, orgUrl: string, project: string, runId: number): Promise<AzTimelineRecord[]> {
  try {
    const result = await adoJson<{ records: AzTimelineRecord[] } | null>(runner, {
      method: 'GET',
      url: timelineUri(orgUrl, project, runId),
    });
    return result?.records ?? [];
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new NotFoundError(`Pipeline run #${runId} was not found.`);
    }
    throw err;
  }
}

export async function fetchLogText(runner: Runner, orgUrl: string, project: string, runId: number, logId: number): Promise<string> {
  return adoText(runner, { method: 'GET', url: logUri(orgUrl, project, runId, logId) });
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
