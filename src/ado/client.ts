import type { PullRequest, Run, TeamAreas, Thread, ThreadStatus, TimelineRecord, WorkItem, WorkItemState } from '../core/types.js';
import { ExternalError, NotFoundError, PrereqError } from '../errors.js';
import type { AdoHttp, AdoResponse, HttpMethod } from './http.js';
import { WORK_ITEM_FIELDS, isDiscussion, toPullRequest, toRun, toThread, toTimelineRecord, toWorkItem, type Raw } from './map.js';

/** Azure DevOps as typed calls against one organization (REST api-version 7.1). */

const BATCH = 200; // the most ids the work items batch endpoint takes
const enc = encodeURIComponent;
const headRef = (b: string) => (b.startsWith('refs/') ? b : `refs/heads/${b}`);

export interface NewWorkItem {
  project: string;
  type: string;
  title: string;
  areaPath?: string;
  iterationPath?: string;
  description?: string;
  assignedTo?: string;
  parentId?: number;
}

export interface NewPullRequest {
  project: string;
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  isDraft?: boolean;
  workItemIds: number[];
}

export class AdoClient {
  constructor(
    private readonly http: AdoHttp,
    readonly orgUrl: string
  ) {}

  /* work items */

  async workItem(id: number): Promise<WorkItem> {
    const [item] = await this.workItems([id]);
    if (!item) throw new NotFoundError(`Work item #${id} was not found.`);
    return item;
  }

  /** In the order asked; ids that don't exist or can't be seen are left out. */
  async workItems(ids: number[]): Promise<WorkItem[]> {
    const unique = [...new Set(ids)];
    const pages = await Promise.all(
      Array.from({ length: Math.ceil(unique.length / BATCH) }, (_, i) =>
        this.json('POST', '_apis/wit/workitemsbatch', {}, { ids: unique.slice(i * BATCH, (i + 1) * BATCH), fields: WORK_ITEM_FIELDS, errorPolicy: 'omit' })
      )
    );
    const byId = new Map<number, WorkItem>(pages.flatMap((p) => (p?.value ?? []).filter(Boolean).map((w: Raw) => [w.id, toWorkItem(w, this.orgUrl)])));
    return unique.flatMap((id) => byId.get(id) ?? []);
  }

  async query(wiql: string): Promise<WorkItem[]> {
    const res = await this.json('POST', '_apis/wit/wiql', { $top: 1000 }, { query: wiql });
    return this.workItems((res?.workItems ?? []).map((w: Raw) => w.id));
  }

  async createWorkItem(item: NewWorkItem): Promise<WorkItem> {
    const fields = {
      'System.Title': item.title,
      'System.AreaPath': item.areaPath,
      'System.IterationPath': item.iterationPath,
      'System.Description': item.description,
      'System.AssignedTo': item.assignedTo,
    };
    const patch: Raw[] = Object.entries(fields).flatMap(([f, value]) => (value === undefined ? [] : [{ op: 'add', path: `/fields/${f}`, value }]));
    if (item.parentId !== undefined) {
      patch.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${this.orgUrl}/_apis/wit/workItems/${item.parentId}` } });
    }
    const raw = await this.json('POST', `${enc(item.project)}/_apis/wit/workitems/$${enc(item.type)}`, {}, patch, 'application/json-patch+json');
    return toWorkItem(raw, this.orgUrl);
  }

  async states(project: string, type: string): Promise<WorkItemState[]> {
    const res = await this.json('GET', `${enc(project)}/_apis/wit/workitemtypes/${enc(type)}/states`);
    return (res?.value ?? []).map((s: Raw) => ({ name: s.name, category: s.category }));
  }

  /* teams */

  async teams(project: string): Promise<string[]> {
    const res = await this.json('GET', `_apis/projects/${enc(project)}/teams`, { $top: 1000 });
    return (res?.value ?? []).map((t: Raw) => t.name);
  }

  async teamAreas(project: string, team: string): Promise<TeamAreas> {
    const res = await this.json('GET', `${enc(project)}/${enc(team)}/_apis/work/teamsettings/teamfieldvalues`);
    return { defaultArea: res?.defaultValue ?? '', areas: (res?.values ?? []).map((v: Raw) => v.value) };
  }

  /** Null for a Kanban-only team, or one between sprints. */
  async currentIteration(project: string, team: string): Promise<string | null> {
    const res = await this.json('GET', `${enc(project)}/${enc(team)}/_apis/work/teamsettings/iterations`, { $timeframe: 'current' });
    return res?.value?.[0]?.path ?? null;
  }

  /* repos and pull requests */

  async defaultBranch(project: string, repo: string): Promise<string | null> {
    const res = await this.json('GET', `${enc(project)}/_apis/git/repositories/${enc(repo)}`);
    return res?.defaultBranch?.replace(/^refs\/heads\//, '') ?? null;
  }

  async pullRequest(id: number): Promise<PullRequest> {
    return toPullRequest(await this.json('GET', `_apis/git/pullrequests/${id}`, {}, undefined, undefined, `Pull request #${id} was not found.`), this.orgUrl);
  }

  async activePullRequest(project: string, repo: string, branch: string): Promise<PullRequest | null> {
    const res = await this.json('GET', `${enc(project)}/_apis/git/repositories/${enc(repo)}/pullrequests`, {
      'searchCriteria.sourceRefName': headRef(branch),
      'searchCriteria.status': 'active',
    });
    return res?.value?.[0] ? toPullRequest(res.value[0], this.orgUrl, { project, repo }) : null;
  }

  async createPullRequest(pr: NewPullRequest): Promise<PullRequest> {
    const raw = await this.json('POST', `${enc(pr.project)}/_apis/git/repositories/${enc(pr.repo)}/pullrequests`, {}, {
      sourceRefName: headRef(pr.sourceBranch),
      targetRefName: headRef(pr.targetBranch),
      title: pr.title,
      description: pr.description,
      isDraft: Boolean(pr.isDraft),
      workItemRefs: pr.workItemIds.map((id) => ({ id: String(id) })),
      completionOptions: { transitionWorkItems: true },
    });
    return toPullRequest(raw, this.orgUrl, pr);
  }

  async pullRequestWorkItems(pr: PullRequest): Promise<WorkItem[]> {
    const res = await this.json('GET', this.prPath(pr, 'workitems'));
    return this.workItems((res?.value ?? []).map((r: Raw) => Number(r.id)));
  }

  async threads(pr: PullRequest): Promise<Thread[]> {
    const res = await this.json('GET', this.prPath(pr, 'threads'));
    return (res?.value ?? []).filter(isDiscussion).map(toThread);
  }

  async thread(pr: PullRequest, id: number): Promise<Thread> {
    return toThread(await this.json('GET', this.prPath(pr, `threads/${id}`), {}, undefined, undefined, `Thread #${id} was not found on PR #${pr.id}.`));
  }

  async addComment(pr: PullRequest, text: string): Promise<Thread> {
    return toThread(await this.json('POST', this.prPath(pr, 'threads'), {}, { comments: [{ parentCommentId: 0, content: text, commentType: 'text' }], status: 'active' }));
  }

  /** Nested under the thread's last comment, so it lands in the actual conversation. */
  async reply(pr: PullRequest, threadId: number, text: string): Promise<number> {
    const thread = await this.thread(pr, threadId);
    const parentCommentId = thread.comments.at(-1)?.id ?? 1;
    return (await this.json('POST', this.prPath(pr, `threads/${threadId}/comments`), {}, { content: text, commentType: 'text', parentCommentId })).id;
  }

  async setThreadStatus(pr: PullRequest, threadId: number, status: ThreadStatus): Promise<void> {
    await this.json('PATCH', this.prPath(pr, `threads/${threadId}`), {}, { status });
  }

  /* pipelines */

  /**
   * Most recent first, for a branch or a full ref (`refs/pull/12/merge`).
   * Re-filtered on each run's own branch — another ref's run shown as this
   * branch's CI is worse than none — so it over-fetches.
   */
  async runs(project: string, ref: string, top: number): Promise<Run[]> {
    const wanted = headRef(ref);
    const res = await this.json('GET', `${enc(project)}/_apis/build/builds`, { branchName: wanted, $top: Math.max(top * 4, 20), queryOrder: 'queueTimeDescending' });
    return (res?.value ?? [])
      .filter((b: Raw) => !b.sourceBranch || b.sourceBranch === wanted)
      .slice(0, top)
      .map((b: Raw) => toRun(b, this.orgUrl, project));
  }

  async run(project: string, id: number): Promise<Run> {
    return toRun(await this.json('GET', `${enc(project)}/_apis/build/builds/${id}`, {}, undefined, undefined, `Pipeline run #${id} was not found.`), this.orgUrl, project);
  }

  async timeline(project: string, runId: number): Promise<TimelineRecord[]> {
    const res = await this.json('GET', `${enc(project)}/_apis/build/builds/${runId}/timeline`, {}, undefined, undefined, `Pipeline run #${runId} was not found.`);
    return (res?.records ?? []).map(toTimelineRecord);
  }

  async log(project: string, runId: number, logId: number): Promise<string> {
    return (await this.send({ method: 'GET', url: this.url(`${enc(project)}/_apis/build/builds/${runId}/logs/${logId}`), accept: 'text' })).body;
  }

  /* identity, and the escape hatch */

  /** The signed-in user as `System.AssignedTo` accepts it. */
  async me(): Promise<string | null> {
    const res = await this.json('GET', '_apis/connectionData', { 'api-version': '7.1-preview' });
    const user = res?.authenticatedUser;
    return user?.properties?.Account?.$value ?? user?.providerDisplayName ?? null;
  }

  /** `dova api`: any request; the body comes back as sent. */
  async raw(method: HttpMethod, url: string, body?: string, contentType = 'application/json'): Promise<AdoResponse> {
    return this.send({ method, url, body, contentType: body === undefined ? undefined : contentType });
  }

  /* plumbing */

  url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const url = new URL(path, `${this.orgUrl}/`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', '7.1');
    return url.toString();
  }

  private prPath(pr: PullRequest, path: string): string {
    return `${enc(pr.project)}/_apis/git/repositories/${enc(pr.repo)}/pullRequests/${pr.id}/${path}`;
  }

  private async json(method: HttpMethod, path: string, query = {}, body?: unknown, contentType = 'application/json', notFound?: string): Promise<Raw> {
    const req = { method, url: this.url(path, query), body: body === undefined ? undefined : JSON.stringify(body), contentType: body === undefined ? undefined : contentType };
    let res: AdoResponse;
    try {
      res = await this.send(req);
    } catch (err) {
      throw notFound && err instanceof NotFoundError ? new NotFoundError(notFound) : err;
    }
    if (!res.body.trim()) return null;
    try {
      return JSON.parse(res.body);
    } catch {
      throw new ExternalError(`Azure DevOps answered ${method} ${path} with something that isn't JSON.`);
    }
  }

  private async send(req: Parameters<AdoHttp>[0]): Promise<AdoResponse> {
    const res = await this.http(req);
    checkStatus(res, req.method, req.url);
    return res;
  }
}

/**
 * A 401, or a 203 bouncing to a sign-in page, arrives here only after the
 * transport already retried with a fresh token for the org's own tenant —
 * so it means no access, not "log in again".
 */
export function checkStatus(res: AdoResponse, method: string, url: string): void {
  if (res.status >= 200 && res.status < 300 && res.status !== 203) return;
  let message: string | undefined;
  try {
    message = JSON.parse(res.body).message;
  } catch {
    // not JSON
  }
  const path = new URL(url).pathname;
  if (res.status === 401 || res.status === 203) {
    throw new PrereqError(`Azure DevOps refused the request: ${message ?? `HTTP ${res.status}`}`, [
      'The account az is signed in as may lack access to this organization — check: dova auth status',
    ]);
  }
  if (res.status === 404) throw new NotFoundError(message ?? `Not found: ${path}`);
  throw new ExternalError(`Azure DevOps returned ${res.status} for ${method} ${path}${message ? `: ${message}` : ''}`);
}
