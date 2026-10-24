import { needBranch, needRepo, type App } from '../../app.js';
import type { AdoClient } from '../../ado/client.js';
import { truncate } from '../../core/text.js';
import type { PullRequest, Thread, ThreadLocation, ThreadStatus, WorkItemRef } from '../../core/types.js';
import { looksLikeUrl, parseId, parsePullRequestLink } from '../../core/urls.js';
import { NotFoundError, UserError } from '../../errors.js';
import { command, group, type Out } from '../framework.js';

export interface ThreadSummary {
  id: number;
  status: string;
  unresolved: boolean;
  location: ThreadLocation | null;
  commentCount: number;
  lastAuthor: string | null;
  lastComment: string | null;
}

/** Open threads first. */
export function summarizeThreads(threads: Thread[]): ThreadSummary[] {
  return threads
    .map((t) => ({
      id: t.id,
      status: t.status,
      unresolved: t.unresolved,
      location: t.location,
      commentCount: t.comments.length,
      lastAuthor: t.comments.at(-1)?.author ?? null,
      lastComment: t.comments.at(-1)?.text ?? null,
    }))
    .sort((a, b) => Number(b.unresolved) - Number(a.unresolved));
}

/** The UI's "Resolved" is the API's `fixed`. */
const STATUSES: Record<string, ThreadStatus> = { active: 'active', open: 'active', resolved: 'fixed', resolve: 'fixed', fixed: 'fixed', wontfix: 'wontFix', closed: 'closed', close: 'closed', pending: 'pending' };

export function parseThreadStatus(input: string): ThreadStatus {
  const status = STATUSES[input.toLowerCase().replace(/[^a-z]/g, '')];
  if (!status) throw new UserError(`Unknown thread status "${input}".`, ['Use one of: resolved, active, wontfix, closed, pending.']);
  return status;
}

/** A PR from an id, a link, or (with neither) the current branch's active PR — and the client for its org. */
export async function findPullRequest(app: App, idOrUrl?: string): Promise<{ pr: PullRequest; ado: AdoClient }> {
  const link = idOrUrl && looksLikeUrl(idOrUrl) ? parsePullRequestLink(idOrUrl) : null;
  if (idOrUrl && looksLikeUrl(idOrUrl) && !link) throw new UserError(`"${idOrUrl}" isn't a pull request link.`);
  const id = link?.id ?? (idOrUrl ? parseId(idOrUrl) : null);
  if (idOrUrl && !id) throw new UserError(`"${idOrUrl}" isn't a pull request id or link.`);
  const scope = await app.scope(link ?? {});
  const ado = app.ado(scope.orgUrl);
  if (id) return { pr: await ado.pullRequest(id), ado };
  const s = needBranch(needRepo(scope, 'pr'));
  const pr = await ado.activePullRequest(s.project, s.repo, s.branch);
  if (!pr) throw new NotFoundError(`No active pull request for branch "${s.branch}".`);
  return { pr, ado };
}

/** Threads as indented blocks, so long paths and real comment text survive; a table cell cut them to nothing. */
export function threadBlocks(out: Out, prId: number, threads: ThreadSummary[], full: boolean): string[] {
  const c = out.color;
  return threads.flatMap((t) => {
    const head = [c.bold(`#${t.id}`), t.unresolved ? c.yellow('open') : c.dim('resolved'), t.location ? `${t.location.file}:${t.location.line}` : c.dim('(general)'), t.lastAuthor ?? '?'];
    const shown = full ? { text: (t.lastComment ?? '').trim(), truncated: false } : truncate((t.lastComment ?? '').trim(), 600);
    const more = [shown.truncated && 'truncated', t.commentCount > 1 && `${t.commentCount - 1} earlier`].filter(Boolean);
    return ['', head.join('  '), ...shown.text.split('\n').map((l) => `  ${l}`), more.length > 0 && c.dim(`  … ${more.join(', ')} — dova pr thread ${prId} ${t.id}`)].filter(
      (l): l is string => typeof l === 'string'
    );
  });
}

export function workItemTable(out: Out, items: Array<WorkItemRef & { primary?: boolean }>): string {
  const c = out.color;
  return out.table(['ID', 'Type', 'Title', 'State'], items.map((w) => [w.primary ? c.cyan(`#${w.id} *`) : `#${w.id}`, w.type ?? '?', w.title ?? c.dim('(unknown)'), w.state ?? '?']));
}

/* ---------------- create ---------------- */

interface CreateFlags {
  title?: string;
  body?: string;
  target?: string;
  draft?: boolean;
  workItems?: string[];
}

export async function createPullRequest(app: App, flags: CreateFlags) {
  if (flags.title === '-' && flags.body === '-') throw new UserError('Only one of --title and --body can read stdin.');
  // Piped text nothing asked for would vanish: the PR gets created without it.
  if (app.stdin.hasData() && flags.title !== '-' && flags.body !== '-') {
    throw new UserError('Something is piped in, but nothing was told to read it.', ['Pass --body - to use it as the description.']);
  }
  const s = needBranch(needRepo(await app.scope(), 'pr create'));
  const ado = app.ado(s.orgUrl);
  const title = flags.title === '-' ? await app.stdin.text('-', 'title') : flags.title ?? (await app.git.try(['log', '-1', '--format=%s'])) ?? s.branch;
  const description = flags.body === '-' ? await app.stdin.text('-', 'body') : flags.body;

  // Linked by `dova link`, or else #123 references in this branch's commits.
  let ids = (flags.workItems ?? []).map((v) => parseId(v) ?? Number.NaN);
  if (ids.some(Number.isNaN)) throw new UserError(`Not work item ids: ${flags.workItems!.join(' ')}`);
  if (ids.length === 0) ids = (await app.links.get(s.branch)).ids;
  if (ids.length === 0) ids = [...new Set([...((await app.git.try(['log', '-50', '--format=%s'])) ?? '').matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];

  const target = flags.target ?? (await app.git.originHead()) ?? (await ado.defaultBranch(s.project, s.repo));
  if (!target) throw new UserError('Could not tell which branch to merge into.', ['Pass --target <branch>.']);
  return ado.createPullRequest({ project: s.project, repo: s.repo, sourceBranch: s.branch, targetBranch: target, title, description, isDraft: flags.draft, workItemIds: ids });
}

/* ---------------- view ---------------- */

export async function pullRequestDetail({ pr, ado }: { pr: PullRequest; ado: AdoClient }) {
  const [workItems, threads] = await Promise.all([ado.pullRequestWorkItems(pr), ado.threads(pr)]);
  return { ...pr, workItems: workItems.map(({ id, title, type, state }) => ({ id, title, type, state })), threads: summarizeThreads(threads) };
}

export function renderPullRequest(d: Awaited<ReturnType<typeof pullRequestDetail>>, out: Out, full: boolean): void {
  const c = out.color;
  const open = d.threads.filter((t) => t.unresolved).length;
  out.print(
    `${c.bold(`#${d.id}`)} ${d.title}${d.isDraft ? c.dim(' [draft]') : ''}`,
    c.dim(`${d.status} · opened by ${d.author} · ${d.sourceBranch} -> ${d.targetBranch}`),
    c.dim(d.url),
    '',
    c.bold('Work Items'),
    d.workItems.length > 0 ? workItemTable(out, d.workItems) : c.dim('  (none linked)'),
    '',
    c.bold('Threads') + c.dim(` (${open} open, ${d.threads.length - open} resolved)`),
    ...threadBlocks(out, d.id, d.threads, full)
  );
}

/* ---------------- commands ---------------- */

function threadId(value: string): number {
  const id = parseId(value);
  if (!id) throw new UserError(`"${value}" isn't a thread id.`);
  return id;
}

export const pr = group('pr', 'Pull requests', [
  command<never, CreateFlags, PullRequest>({
    name: 'create',
    description: 'Open a PR from the current branch, linking its work items',
    options: [
      ['--title <title>', "title (default: the last commit's subject; '-' reads stdin)"],
      ['--body <text>', "description ('-' reads stdin)"],
      ['--target <branch>', 'branch to merge into (default: the repo’s default branch)'],
      ['--draft', 'open as a draft'],
      ['--work-items <ids...>', 'work items to link (default: from `dova link`, else #ids in commit messages)'],
    ],
    run: (app, _, flags) => createPullRequest(app, flags),
    web: (r) => r.url,
    render: (r, out) => out.print(`${out.color.green('Created')} PR ${out.color.bold(`#${r.id}`)}${r.isDraft ? ' [draft]' : ''} — ${r.title}`, out.color.dim(`  ${r.url}`)),
  }),
  command<{ idOrUrl?: string }, { full?: boolean }, Awaited<ReturnType<typeof pullRequestDetail>>>({
    name: 'view [id-or-url]',
    description: 'A PR with its work items and review threads (default: the current branch’s)',
    options: [['--full', 'show whole comments']],
    run: async (app, { idOrUrl }) => pullRequestDetail(await findPullRequest(app, idOrUrl)),
    web: (r) => r.url,
    render: (r, out, flags) => renderPullRequest(r, out, Boolean(flags.full)),
  }),
  command<{ pr: string; text?: string }, never, { prId: number; threadId: number }>({
    name: 'comment <pr> [text]',
    description: "Start a review thread ('-' or no text reads stdin)",
    run: async (app, args) => {
      const { pr, ado } = await findPullRequest(app, args.pr);
      const thread = await ado.addComment(pr, await app.stdin.text(args.text, 'comment'));
      return { prId: pr.id, threadId: thread.id };
    },
    render: (r, out) => out.print(`${out.color.green('Posted')} thread #${r.threadId} on PR #${r.prId}.`),
  }),
  command<{ pr: string; thread: string }, never, Thread & { prId: number }>({
    name: 'thread <pr> <thread>',
    description: 'Every comment in one review thread',
    run: async (app, args) => {
      const { pr, ado } = await findPullRequest(app, args.pr);
      return { prId: pr.id, ...(await ado.thread(pr, threadId(args.thread))) };
    },
    render(t, out) {
      const c = out.color;
      out.print(
        `${c.bold(`Thread #${t.id}`)} on PR #${t.prId} · ${t.unresolved ? c.yellow(t.status) : c.dim(t.status)}`,
        t.location ? `${t.location.file}:${t.location.line}` : c.dim('(general comment)'),
        ...t.comments.flatMap((cm) => ['', c.bold([cm.author ?? 'unknown', cm.publishedAt].filter(Boolean).join(' · ')), ...cm.text.split('\n').map((l) => `  ${l}`)])
      );
    },
  }),
  command<{ pr: string; thread: string; text?: string }, { resolve?: string | true }, { prId: number; threadId: number; status: ThreadStatus | null }>({
    name: 'reply <pr> <thread> [text]',
    description: "Reply in a review thread ('-' or no text reads stdin)",
    options: [['--resolve [status]', 'also set the thread’s status (default: resolved)']],
    run: async (app, args, flags) => {
      const { pr, ado } = await findPullRequest(app, args.pr);
      const id = threadId(args.thread);
      await ado.reply(pr, id, await app.stdin.text(args.text, 'reply'));
      const status = flags.resolve ? parseThreadStatus(flags.resolve === true ? 'resolved' : flags.resolve) : null;
      if (status) await ado.setThreadStatus(pr, id, status);
      return { prId: pr.id, threadId: id, status };
    },
    render: (r, out) => out.print(`${out.color.green('Replied')} in thread #${r.threadId} on PR #${r.prId}${r.status ? `, now ${r.status}` : ''}.`),
  }),
  command<{ pr: string; thread: string; status?: string }, never, { prId: number; threadId: number; status: ThreadStatus }>({
    name: 'resolve <pr> <thread> [status]',
    description: "Set a review thread's status (default: resolved; also active, wontfix, closed, pending)",
    run: async (app, args) => {
      const { pr, ado } = await findPullRequest(app, args.pr);
      const status = parseThreadStatus(args.status ?? 'resolved');
      await ado.setThreadStatus(pr, threadId(args.thread), status);
      return { prId: pr.id, threadId: threadId(args.thread), status };
    },
    render: (r, out) => out.print(`${out.color.green('Set')} thread #${r.threadId} on PR #${r.prId} to ${r.status}.`),
  }),
]);
