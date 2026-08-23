import type { ChalkInstance } from 'chalk';
import type { Runner } from './exec.js';
import { runAzJson, runAzRestJson, resolveOrFetchBranchRef, tryGit } from './exec.js';
import { buildPrWebUrl } from './context.js';
import { renderTable, colorizeDiff, colorizeDiffStat } from './output.js';
import { UserError, NotFoundError, looksLikeAzNotFoundError } from './errors.js';
import type { AzPullRequest, AzWorkItem, AzCommentThread, AzComment } from '../types/azure-devops.js';

export interface ThreadLocation {
  file: string;
  /** 1-based. The PR's proposed version of the file when available, otherwise the base version's. */
  line: number;
}

/** null for a general PR comment not anchored to any file. */
export function threadLocation(thread: AzCommentThread): ThreadLocation | null {
  const ctx = thread.threadContext;
  if (!ctx) return null;
  const line = ctx.rightFileStart?.line ?? ctx.leftFileStart?.line;
  if (line === undefined) return null;
  return { file: ctx.filePath, line };
}

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
  try {
    return await runAzJson<AzPullRequest>(runner, ['repos', 'pr', 'show', '--id', String(id), '--organization', orgUrl]);
  } catch (err) {
    if (err instanceof Error && looksLikeAzNotFoundError(err.message)) {
      throw new NotFoundError(`Pull request #${id} was not found.`);
    }
    throw err;
  }
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

function pullRequestApiBase(orgUrl: string, project: string, repo: string, prId: number): string {
  return `${orgUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}`;
}
function threadsUri(orgUrl: string, project: string, repo: string, prId: number): string {
  return `${pullRequestApiBase(orgUrl, project, repo, prId)}/threads?api-version=7.1`;
}
function threadUri(orgUrl: string, project: string, repo: string, prId: number, threadId: number): string {
  return `${pullRequestApiBase(orgUrl, project, repo, prId)}/threads/${threadId}?api-version=7.1`;
}
function threadCommentsUri(orgUrl: string, project: string, repo: string, prId: number, threadId: number): string {
  return `${pullRequestApiBase(orgUrl, project, repo, prId)}/threads/${threadId}/comments?api-version=7.1`;
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
  const res = await runAzRestJson<{ value: AzCommentThread[] }>(runner, { method: 'get', uri: threadsUri(orgUrl, project, repo, prId) });
  return (res.value ?? []).filter(isDiscussionThread);
}

export async function fetchThreadById(
  runner: Runner,
  orgUrl: string,
  project: string,
  repo: string,
  prId: number,
  threadId: number
): Promise<AzCommentThread> {
  const uri = threadUri(orgUrl, project, repo, prId, threadId);
  return runAzRestJson<AzCommentThread>(runner, { method: 'get', uri });
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
  const body = { comments: [{ parentCommentId: 0, content: text, commentType: 'text' }], status: 'active' };
  return runAzRestJson<AzCommentThread>(runner, {
    method: 'post',
    uri: threadsUri(orgUrl, project, repo, prId),
    body,
    headers: ['Content-Type=application/json'],
  });
}

/**
 * Replies within an existing thread — a genuine response, not a new
 * top-level thread. Needs one extra GET to find the thread's last
 * comment (so the reply nests under the actual conversation rather than
 * guessing a comment id).
 */
export async function replyToPrThread(
  runner: Runner,
  orgUrl: string,
  project: string,
  repo: string,
  prId: number,
  threadId: number,
  text: string
): Promise<AzComment> {
  const thread = await fetchThreadById(runner, orgUrl, project, repo, prId, threadId);
  const parentCommentId = thread.comments[thread.comments.length - 1]?.id ?? 1;
  const uri = threadCommentsUri(orgUrl, project, repo, prId, threadId);
  const body = { content: text, commentType: 'text', parentCommentId };
  return runAzRestJson<AzComment>(runner, { method: 'post', uri, body, headers: ['Content-Type=application/json'] });
}

/** The API's raw thread status values. "resolved" isn't one of them — see `resolveThreadStatusInput`. */
export type AzThreadStatusApi = 'active' | 'fixed' | 'wontFix' | 'closed' | 'pending';

const THREAD_STATUS_ALIASES: Record<string, AzThreadStatusApi> = {
  active: 'active',
  resolved: 'fixed',
  resolve: 'fixed',
  fixed: 'fixed',
  wontfix: 'wontFix',
  closed: 'closed',
  close: 'closed',
  pending: 'pending',
};

/**
 * Maps a friendly, human-typed status ("resolved", "won't fix", "wontfix",
 * "Won't Fix") to the API's actual enum value. "resolved" is deliberately
 * not a 1:1 passthrough — it's what Azure DevOps's own UI calls the
 * "fixed" status internally.
 */
export function resolveThreadStatusInput(input: string): AzThreadStatusApi {
  const key = input.trim().toLowerCase().replace(/[^a-z]/g, '');
  const mapped = THREAD_STATUS_ALIASES[key];
  if (!mapped) {
    throw new UserError(`Unknown thread status "${input}".`, [
      `Supported: ${[...new Set(Object.values(THREAD_STATUS_ALIASES))].join(', ')} (also accepts aliases like "resolve", "won't fix")`,
    ]);
  }
  return mapped;
}

/** Changes a thread's status — active/resolved/won't-fix/closed/pending. */
export async function setPrThreadStatus(
  runner: Runner,
  orgUrl: string,
  project: string,
  repo: string,
  prId: number,
  threadId: number,
  status: AzThreadStatusApi
): Promise<AzCommentThread> {
  const uri = threadUri(orgUrl, project, repo, prId, threadId);
  return runAzRestJson<AzCommentThread>(runner, { method: 'patch', uri, body: { status }, headers: ['Content-Type=application/json'] });
}

/* ------------------------------------------------------------------ *
 * Full PR detail — shared by `dova pr view` and `dova view`.
 * ------------------------------------------------------------------ */

export interface ThreadSummary {
  id: number;
  status: string;
  unresolved: boolean;
  location: ThreadLocation | null;
  commentCount: number;
  lastAuthor: string | null;
  lastComment: string | null;
}

export interface WorkItemRefSummary {
  id: number;
  title: string | null;
  state: string | null;
  type: string | null;
}

export interface PrDetail {
  id: number;
  title: string;
  status: string;
  isDraft: boolean;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  workItems: WorkItemRefSummary[];
  threads: ThreadSummary[];
}

export async function gatherPrDetail(
  runner: Runner,
  orgUrl: string,
  pullRequest: AzPullRequest,
  fallbackProject?: string,
  fallbackRepo?: string
): Promise<PrDetail> {
  const repo = pullRequest.repository?.name ?? fallbackRepo;
  const project = pullRequest.repository?.project?.name ?? fallbackProject;
  if (!repo || !project) {
    throw new UserError(`Could not determine which repo/project PR #${pullRequest.pullRequestId} belongs to.`);
  }
  const url = buildPrWebUrl({ orgUrl, project, repo }, pullRequest.pullRequestId);

  const [workItems, threads] = await Promise.all([
    fetchPrWorkItems(runner, orgUrl, pullRequest.pullRequestId),
    fetchDiscussionThreads(runner, orgUrl, project, repo, pullRequest.pullRequestId),
  ]);

  return {
    id: pullRequest.pullRequestId,
    title: pullRequest.title,
    status: pullRequest.status,
    isDraft: Boolean(pullRequest.isDraft),
    author: pullRequest.createdBy.displayName,
    sourceBranch: pullRequest.sourceRefName.replace(/^refs\/heads\//, ''),
    targetBranch: pullRequest.targetRefName.replace(/^refs\/heads\//, ''),
    url,
    workItems: workItems.map((w) => ({
      id: w.id,
      title: w.fields?.['System.Title'] ?? null,
      state: w.fields?.['System.State'] ?? null,
      type: w.fields?.['System.WorkItemType'] ?? null,
    })),
    threads: threads
      .map((t) => {
        const last = t.comments[t.comments.length - 1];
        return {
          id: t.id,
          status: t.status,
          unresolved: isUnresolvedThreadStatus(t.status),
          location: threadLocation(t),
          commentCount: t.comments.length,
          lastAuthor: last?.author?.displayName ?? null,
          lastComment: last?.content ?? null,
        };
      })
      .sort((a, b) => Number(b.unresolved) - Number(a.unresolved)),
  };
}

/* ------------------------------------------------------------------ *
 * Full thread detail — every comment in one thread, in order. The
 * summary tables above only ever show the last comment; this is for
 * actually reading a thread's conversation before acting on it (e.g. a
 * quality-gate finding a human already replied to).
 * ------------------------------------------------------------------ */

export interface ThreadCommentDetail {
  id: number;
  author: string | null;
  publishedDate: string | null;
  content: string | null;
  /** "text" | "codeChange" | "system" */
  commentType: string | null;
}

export interface ThreadDetail {
  id: number;
  prId: number;
  status: string;
  unresolved: boolean;
  location: ThreadLocation | null;
  comments: ThreadCommentDetail[];
}

export async function gatherThreadDetail(
  runner: Runner,
  orgUrl: string,
  project: string,
  repo: string,
  prId: number,
  threadId: number
): Promise<ThreadDetail> {
  const thread = await fetchThreadById(runner, orgUrl, project, repo, prId, threadId);
  return {
    id: thread.id,
    prId,
    status: thread.status,
    unresolved: isUnresolvedThreadStatus(thread.status),
    location: threadLocation(thread),
    comments: thread.comments.map((c) => ({
      id: c.id,
      author: c.author?.displayName ?? null,
      publishedDate: c.publishedDate ?? null,
      content: c.content ?? null,
      commentType: c.commentType ?? null,
    })),
  };
}

export function renderThreadDetailHuman(detail: ThreadDetail, color: ChalkInstance): void {
  const lines: string[] = [
    `${color.bold(`Thread #${detail.id}`)} on PR #${detail.prId}`,
    detail.location ? `${detail.location.file}:${detail.location.line}` : color.dim('(general comment, not anchored to a file)'),
    `Status: ${detail.unresolved ? color.yellow(detail.status) : color.dim(detail.status)}`,
    '',
  ];
  for (const c of detail.comments) {
    const header = [c.author ?? 'Unknown', c.publishedDate].filter(Boolean).join(' · ');
    lines.push(color.bold(header));
    lines.push(`  ${(c.content ?? '').split('\n').join('\n  ')}`);
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n').replace(/\n+$/, '')}\n`);
}

export function renderPrDetailHuman(detail: PrDetail, color: ChalkInstance): void {
  const draftTag = detail.isDraft ? color.dim(' [draft]') : '';
  const lines: string[] = [
    `${color.bold(`#${detail.id}`)} ${detail.title}${draftTag}`,
    color.dim(`${detail.status} · opened by ${detail.author} · ${detail.sourceBranch} -> ${detail.targetBranch}`),
    color.dim(detail.url),
    '',
    color.bold('Work Items'),
  ];
  if (detail.workItems.length === 0) {
    lines.push(color.dim('  (none linked)'));
  } else {
    lines.push(
      renderTable(
        ['ID', 'Type', 'Title', 'State'],
        detail.workItems.map((w) => [`#${w.id}`, w.type ?? '?', w.title ?? '(no title)', w.state ?? '?'])
      )
    );
  }
  lines.push('', color.bold('Comment Threads'));
  if (detail.threads.length === 0) {
    lines.push(color.dim('  (no comment threads)'));
  } else {
    lines.push(
      renderTable(
        ['ID', 'Status', 'Location', 'Last author', 'Last comment'],
        detail.threads.map((t) => [
          String(t.id),
          t.unresolved ? color.yellow('open') : color.dim('resolved'),
          t.location ? `${t.location.file}:${t.location.line}` : color.dim('—'),
          t.lastAuthor ?? '?',
          (t.lastComment ?? '').slice(0, 60),
        ])
      )
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/* ------------------------------------------------------------------ *
 * PR diff — the actual code change, not just metadata. `az repos pr`
 * has no diff command at all (confirmed absent from the extension's
 * command registry — the group is create/update/show/list/checkout/
 * reviewer/work-item/set-vote/policy, nothing diff-shaped). `az repos
 * pr checkout` itself just fetches the PR's own sourceRefName and
 * checks it out (confirmed from source — no special merge ref
 * involved), so reading the diff is the same fetch, minus the
 * checkout: resolveOrFetchBranchRef() on both source and target,
 * then a plain local `git diff` between them. Works for a PR you
 * opened as readily as one you didn't — nothing here assumes the
 * source branch was ever checked out locally before this call.
 * ------------------------------------------------------------------ */

export interface PrDiffResult {
  id: number;
  sourceBranch: string;
  targetBranch: string;
  stat: string;
  /** Only populated when the full patch was requested. */
  patch?: string;
}

export async function gatherPrDiff(
  runner: Runner,
  pullRequest: AzPullRequest,
  opts: { cwd?: string; full?: boolean } = {}
): Promise<PrDiffResult> {
  const sourceBranch = pullRequest.sourceRefName.replace(/^refs\/heads\//, '');
  const targetBranch = pullRequest.targetRefName.replace(/^refs\/heads\//, '');

  const [headRef, baseRef] = await Promise.all([
    resolveOrFetchBranchRef(runner, sourceBranch, opts.cwd),
    resolveOrFetchBranchRef(runner, targetBranch, opts.cwd),
  ]);

  const result: PrDiffResult = {
    id: pullRequest.pullRequestId,
    sourceBranch,
    targetBranch,
    stat: (await tryGit(runner, ['diff', '--stat', `${baseRef}...${headRef}`], { cwd: opts.cwd })) ?? '',
  };
  if (opts.full) {
    result.patch = (await tryGit(runner, ['diff', `${baseRef}...${headRef}`], { cwd: opts.cwd })) ?? '';
  }
  return result;
}

export function renderPrDiffHuman(result: PrDiffResult, full: boolean, color: ChalkInstance): void {
  const lines: string[] = [color.bold(`#${result.id}`) + ` ${result.sourceBranch} -> ${result.targetBranch}`, ''];
  if (full && result.patch !== undefined) {
    lines.push(colorizeDiff(result.patch, color) || color.dim('(no changes)'));
  } else {
    lines.push(colorizeDiffStat(result.stat.trim(), color) || color.dim('(no changes)'));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
