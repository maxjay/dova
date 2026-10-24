import { needBranch, needRepo, type App } from '../../app.js';
import type { PullRequest, Run, WorkItemRef } from '../../core/types.js';
import { command } from '../framework.js';
import { summarizeThreads, threadBlocks, workItemTable, type ThreadSummary } from './pr.js';

export interface Status {
  branch: string;
  pr: PullRequest | null;
  /** The PR's, or with no PR, the ones `dova link` recorded. */
  workItems: Array<WorkItemRef & { primary: boolean }>;
  runs: Run[];
  threads: ThreadSummary[];
}

/** Two rounds of parallel requests: everything that doesn't need the PR, then everything that does. */
export async function branchStatus(app: App): Promise<Status> {
  const s = needBranch(needRepo(await app.scope(), 'status'));
  const ado = app.ado(s.orgUrl);
  const [pr, branchRuns, link] = await Promise.all([ado.activePullRequest(s.project, s.repo, s.branch), ado.runs(s.project, s.branch, 3), app.links.get(s.branch)]);
  const [items, threads, prRuns] = await Promise.all([
    pr ? ado.pullRequestWorkItems(pr) : ado.workItems(link.ids),
    pr ? ado.threads(pr) : [],
    // PR validation builds run on the merge commit, under refs/pull/<id>/merge, and gate the merge — so they come first.
    pr ? ado.runs(s.project, `refs/pull/${pr.id}/merge`, 3) : [],
  ]);
  const seen = new Set<number>();
  const byId = new Map(items.map((w) => [w.id, w]));
  return {
    branch: s.branch,
    pr,
    workItems: (pr ? items.map((w) => w.id) : link.ids).map((id) => {
      const w = byId.get(id);
      return { id, title: w?.title ?? null, type: w?.type ?? null, state: w?.state ?? null, primary: !pr && id === link.primary };
    }),
    runs: [...prRuns, ...branchRuns].filter((r) => !seen.has(r.id) && seen.add(r.id)).slice(0, 3),
    threads: summarizeThreads(threads),
  };
}

export const status = command<never, never, Status>({
  name: 'status',
  description: "The branch you're on: its PR, work items, latest pipeline runs and review threads",
  run: (app) => branchStatus(app),
  web: (r) => r.pr?.url ?? null,
  render(r, out) {
    const c = out.color;
    const open = r.threads.filter((t) => t.unresolved).length;
    out.print(
      c.bold(`Branch: ${r.branch}`),
      '',
      ...(r.pr
        ? [c.bold('Pull Request'), `  #${r.pr.id} ${r.pr.title}${r.pr.isDraft ? c.dim(' [draft]') : ''}`, c.dim(`  ${r.pr.status} · ${r.pr.author} · into ${r.pr.targetBranch}`), c.dim(`  ${r.pr.url}`)]
        : [c.dim('No active pull request.')]),
      '',
      c.bold('Work Items'),
      r.workItems.length > 0 ? workItemTable(out, r.workItems) : c.dim('  (none — see `dova link`)'),
      '',
      c.bold('Pipeline Runs'),
      r.runs.length > 0 ? out.table(['Pipeline', 'Result', 'Queued', 'URL'], r.runs.map((x) => [x.name, out.outcome(x.result ?? x.status), x.queuedAt ?? '?', c.dim(x.url)])) : c.dim('  (none)'),
      ...(r.pr ? ['', c.bold('Threads') + c.dim(` (${open} open, ${r.threads.length - open} resolved)`), ...threadBlocks(out, r.pr.id, r.threads, false)] : [])
    );
  },
});
