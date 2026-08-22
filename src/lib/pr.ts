import type { Runner } from './exec.js';
import { runAzJson } from './exec.js';
import type { AzPullRequest, AzWorkItem, AzCommentThread } from '../types/azure-devops.js';

export async function fetchActivePrForBranch(
  runner: Runner,
  orgUrl: string,
  project: string,
  repo: string,
  branch: string
): Promise<AzPullRequest | null> {
  const prs = await runAzJson<AzPullRequest[]>(runner, [
    'repos', 'pr', 'list',
    '--organization', orgUrl,
    '--project', project,
    '--repository', repo,
    '--source-branch', branch,
    '--status', 'active',
  ]);
  return prs[0] ?? null;
}

export async function fetchPrById(runner: Runner, orgUrl: string, id: number): Promise<AzPullRequest> {
  return runAzJson<AzPullRequest>(runner, ['repos', 'pr', 'show', '--id', String(id), '--organization', orgUrl]);
}

/** Full work items (not just refs) linked to a PR — [] (not null) when there are none. */
export async function fetchPrWorkItems(runner: Runner, orgUrl: string, prId: number): Promise<AzWorkItem[]> {
  const raw = await runAzJson<AzWorkItem[] | null>(runner, [
    'repos', 'pr', 'work-item', 'list',
    '--id', String(prId),
    '--organization', orgUrl,
  ]);
  return raw ?? [];
}

/** A thread whose every comment is system-authored ("X created the PR", "X pushed N commits") isn't a real discussion. */
export function isDiscussionThread(thread: AzCommentThread): boolean {
  return !thread.isDeleted && (thread.comments ?? []).some((c) => c.commentType !== 'system' && (c.content ?? '').trim().length > 0);
}

export function isUnresolvedThreadStatus(status: string): boolean {
  return status === 'active' || status === 'pending';
}

/**
 * The azure-devops CLI extension has no native `pr thread` command, so
 * this goes through `az rest` against the PR threads endpoint directly.
 * Returns only real discussion threads (see `isDiscussionThread`), most
 * recently active first.
 */
export async function fetchDiscussionThreads(
  runner: Runner,
  orgUrl: string,
  project: string,
  repo: string,
  prId: number
): Promise<AzCommentThread[]> {
  const uri = `${orgUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/threads?api-version=7.1`;
  const res = await runAzJson<{ value: AzCommentThread[] }>(runner, ['rest', '--method', 'get', '--uri', uri]);
  return (res.value ?? []).filter(isDiscussionThread);
}

/** Posts a new top-level comment thread on a PR. */
export async function postPrComment(
  runner: Runner,
  orgUrl: string,
  project: string,
  repo: string,
  prId: number,
  text: string
): Promise<AzCommentThread> {
  const uri = `${orgUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/threads?api-version=7.1`;
  const body = JSON.stringify({ comments: [{ parentCommentId: 0, content: text, commentType: 'text' }], status: 'active' });
  return runAzJson<AzCommentThread>(runner, ['rest', '--method', 'post', '--uri', uri, '--body', body, '--headers', 'Content-Type=application/json']);
}

/** Changes a thread's status. "resolved" maps to the API's "fixed" — that's what Azure DevOps's own UI calls "Resolved" under the hood. */
export async function setPrThreadStatus(
  runner: Runner,
  orgUrl: string,
  project: string,
  repo: string,
  prId: number,
  threadId: number,
  status: 'active' | 'fixed' | 'wontFix' | 'closed' | 'pending'
): Promise<AzCommentThread> {
  const uri = `${orgUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/threads/${threadId}?api-version=7.1`;
  const body = JSON.stringify({ status });
  return runAzJson<AzCommentThread>(runner, ['rest', '--method', 'patch', '--uri', uri, '--body', body, '--headers', 'Content-Type=application/json']);
}
