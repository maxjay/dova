import type { BodySection, PullRequest, Run, Thread, TimelineRecord, WorkItem } from '../core/types.js';
import { stripHtml } from '../core/text.js';
import { webUrl } from '../core/urls.js';

/* REST response shapes → dova's types. Raw shapes are typed only as far as they're read. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Raw = any;

export const WORK_ITEM_FIELDS = [
  'System.Title', 'System.WorkItemType', 'System.State', 'System.TeamProject', 'System.AssignedTo',
  'System.AreaPath', 'System.IterationPath', 'System.Parent',
  'System.Description', 'Microsoft.VSTS.Common.AcceptanceCriteria', 'Microsoft.VSTS.TCM.ReproSteps',
];

/** A Bug's substance is in its repro steps, a Story's in its acceptance criteria — each present one becomes a section. */
const BODY: Array<[string, string]> = [
  ['System.Description', 'Description'],
  ['Microsoft.VSTS.Common.AcceptanceCriteria', 'Acceptance Criteria'],
  ['Microsoft.VSTS.TCM.ReproSteps', 'Repro Steps'],
];

const str = (v: unknown): string | null =>
  v === undefined || v === null || v === '' ? null : typeof v === 'object' ? String((v as { displayName?: unknown }).displayName ?? '') || null : String(v);
const branch = (ref: string) => ref.replace(/^refs\/heads\//, '');

export function toWorkItem(raw: Raw, orgUrl: string): WorkItem {
  const f = raw.fields ?? {};
  const project = str(f['System.TeamProject']);
  const body: BodySection[] = BODY.flatMap(([field, label]) => {
    const text = stripHtml(str(f[field]) ?? '');
    return text ? [{ label, text }] : [];
  });
  return {
    id: raw.id,
    title: str(f['System.Title']),
    type: str(f['System.WorkItemType']),
    state: str(f['System.State']),
    project,
    assignedTo: str(f['System.AssignedTo']),
    areaPath: str(f['System.AreaPath']),
    iterationPath: str(f['System.IterationPath']),
    parentId: typeof f['System.Parent'] === 'number' ? f['System.Parent'] : null,
    body,
    url: webUrl.workItem(orgUrl, project ?? '', raw.id),
  };
}

export function toPullRequest(raw: Raw, orgUrl: string, fallback: { project?: string; repo?: string } = {}): PullRequest {
  const project = raw.repository?.project?.name ?? fallback.project ?? '';
  const repo = raw.repository?.name ?? fallback.repo ?? '';
  return {
    id: raw.pullRequestId,
    title: raw.title,
    status: raw.status,
    isDraft: Boolean(raw.isDraft),
    author: raw.createdBy?.displayName ?? 'unknown',
    description: raw.description ?? '',
    sourceBranch: branch(raw.sourceRefName),
    targetBranch: branch(raw.targetRefName),
    project,
    repo,
    url: webUrl.pullRequest(orgUrl, project, repo, raw.pullRequestId),
  };
}

/** Threads people wrote in — not the ones made only of system notes ("X pushed 2 commits"). */
export function isDiscussion(raw: Raw): boolean {
  return !raw.isDeleted && (raw.comments ?? []).some((c: Raw) => c.commentType !== 'system' && (c.content ?? '').trim());
}

export function toThread(raw: Raw): Thread {
  const ctx = raw.threadContext;
  const line = ctx?.rightFileStart?.line ?? ctx?.leftFileStart?.line;
  const status = raw.status ?? 'unknown';
  return {
    id: raw.id,
    status,
    unresolved: status === 'active' || status === 'pending',
    location: ctx && line !== undefined ? { file: ctx.filePath, line } : null,
    comments: (raw.comments ?? []).map((c: Raw) => ({
      id: c.id,
      author: c.author?.displayName ?? null,
      publishedAt: c.publishedDate ?? null,
      text: c.content ?? '',
      kind: c.commentType ?? 'text',
    })),
  };
}

export function toRun(raw: Raw, orgUrl: string, project: string): Run {
  return {
    id: raw.id,
    name: raw.definition?.name ?? `#${raw.buildNumber ?? raw.id}`,
    status: raw.status,
    result: raw.result ?? null,
    queuedAt: raw.queueTime ?? null,
    sourceBranch: raw.sourceBranch ?? null,
    url: raw._links?.web?.href ?? webUrl.run(orgUrl, project, raw.id),
  };
}

export function toTimelineRecord(raw: Raw): TimelineRecord {
  return {
    id: raw.id,
    parentId: raw.parentId ?? null,
    type: raw.type,
    name: raw.name,
    result: raw.result ?? null,
    startTime: raw.startTime ?? null,
    logId: raw.log?.id ?? null,
  };
}
