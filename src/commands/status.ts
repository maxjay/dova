import type { Command } from 'commander';
import { defaultRunner, runAzJson } from '../lib/exec.js';
import { gitConfigGet } from '../lib/config.js';
import { resolveContext, buildPrWebUrl } from '../lib/context.js';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption, addWebOption } from '../lib/command-helpers.js';
import { emit, getColor, renderTable } from '../lib/output.js';
import { openInBrowser } from '../lib/browser.js';
import { NotFoundError, UserError } from '../lib/errors.js';
import type { AzPullRequest, AzWorkItem, AzBuild, AzCommentThread } from '../types/azure-devops.js';

export interface StatusFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  json?: string | boolean;
  jq?: string;
  web?: boolean;
  color: boolean;
}

interface WorkItemSummary {
  id: number;
  title: string | null;
  state: string | null;
  type: string | null;
  primary: boolean;
}

interface PipelineRunSummary {
  id: number;
  name: string;
  status: string;
  result: string | null;
  queueTime: string | null;
  url: string;
}

interface ThreadSummary {
  id: number;
  status: string;
  unresolved: boolean;
  commentCount: number;
  lastAuthor: string | null;
  lastComment: string | null;
}

export interface StatusResult {
  branch: string;
  pr: {
    id: number;
    title: string;
    status: string;
    isDraft: boolean;
    author: string;
    url: string;
  } | null;
  workItems: WorkItemSummary[];
  pipelineRuns: PipelineRunSummary[];
  threads: ThreadSummary[];
  warnings: string[];
}

function webUrlForRun(run: AzBuild, orgUrl: string, project: string): string {
  return run._links?.web?.href ?? `${orgUrl}/${encodeURIComponent(project)}/_build/results?buildId=${run.id}`;
}

/** Real thread-vs-noise heuristic: a thread whose every comment is system-authored ("X created the PR", "X pushed N commits") isn't a discussion. */
function isDiscussionThread(thread: AzCommentThread): boolean {
  return !thread.isDeleted && (thread.comments ?? []).some((c) => c.commentType !== 'system' && (c.content ?? '').trim().length > 0);
}

function isUnresolved(status: string): boolean {
  return status === 'active' || status === 'pending';
}

export async function gatherStatus(flags: StatusFlags, cwd?: string): Promise<StatusResult> {
  const runner = defaultRunner;
  const ctx = await resolveContext(runner, {
    org: flags.org,
    orgUrl: flags.orgUrl,
    project: flags.project,
    repo: flags.repo,
  }, { cwd });

  if (!ctx.repo) {
    throw new UserError('"dova status" needs a repo in context.', [
      'Run this inside a git repo cloned from Azure Repos, or pass --repo explicitly.',
    ]);
  }
  if (!ctx.branch) {
    throw new UserError('Not currently on a branch (detached HEAD?).');
  }
  const { orgUrl, project, repo, branch } = { ...ctx, repo: ctx.repo, branch: ctx.branch };

  // Call 1: the active PR for this branch, if any.
  const prs = await runAzJson<AzPullRequest[]>(runner, [
    'repos', 'pr', 'list',
    '--organization', orgUrl,
    '--project', project,
    '--repository', repo,
    '--source-branch', branch,
    '--status', 'active',
  ]);
  const pr = prs[0] ?? null;

  // Call 2: work items — from the PR when one exists, otherwise from what
  // `dova start` tracked locally (see lib/config.ts's branch.<name>.dova-workitems).
  let workItems: WorkItemSummary[];
  if (pr) {
    const raw = await runAzJson<AzWorkItem[] | null>(runner, [
      'repos', 'pr', 'work-item', 'list',
      '--id', String(pr.pullRequestId),
      '--organization', orgUrl,
    ]);
    workItems = (raw ?? []).map((w) => ({
      id: w.id,
      title: w.fields?.['System.Title'] ?? null,
      state: w.fields?.['System.State'] ?? null,
      type: w.fields?.['System.WorkItemType'] ?? null,
      primary: false,
    }));
  } else {
    const tracked = await gitConfigGet(runner, `branch.${branch}.dova-workitems`, { cwd });
    const primary = await gitConfigGet(runner, `branch.${branch}.dova-primary`, { cwd });
    workItems = (tracked ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => ({ id: Number(id), title: null, state: null, type: null, primary: id === primary }));
  }

  // Call 3: last 3 pipeline runs for this branch.
  const runs = await runAzJson<AzBuild[]>(runner, [
    'pipelines', 'runs', 'list',
    '--organization', orgUrl,
    '--project', project,
    '--branch', branch,
    '--top', '3',
  ]);
  const pipelineRuns: PipelineRunSummary[] = runs.map((r) => ({
    id: r.id,
    name: r.definition?.name ?? `#${r.buildNumber}`,
    status: r.status,
    result: r.result,
    queueTime: r.queueTime ?? null,
    url: webUrlForRun(r, orgUrl, project),
  }));

  // Call 4: comment threads (only meaningful once there's a PR). The
  // azure-devops CLI extension has no native `pr thread list` command, so
  // this goes through `az rest` against the PR threads endpoint.
  let threads: ThreadSummary[] = [];
  if (pr) {
    const uri = `${orgUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${pr.pullRequestId}/threads?api-version=7.1`;
    const res = await runAzJson<{ value: AzCommentThread[] }>(runner, ['rest', '--method', 'get', '--uri', uri]);
    threads = (res.value ?? [])
      .filter(isDiscussionThread)
      .map((t) => {
        const last = t.comments[t.comments.length - 1];
        return {
          id: t.id,
          status: t.status,
          unresolved: isUnresolved(t.status),
          commentCount: t.comments.length,
          lastAuthor: last?.author?.displayName ?? null,
          lastComment: last?.content ?? null,
        };
      })
      .sort((a, b) => Number(b.unresolved) - Number(a.unresolved));
  }

  return {
    branch,
    pr: pr && {
      id: pr.pullRequestId,
      title: pr.title,
      status: pr.status,
      isDraft: Boolean(pr.isDraft),
      author: pr.createdBy.displayName,
      url: buildPrWebUrl({ orgUrl, project, repo }, pr.pullRequestId),
    },
    workItems,
    pipelineRuns,
    threads,
    warnings: [],
  };
}

function renderStatusHuman(result: StatusResult, color: ReturnType<typeof getColor>): void {
  const lines: string[] = [];
  lines.push(color.bold(`Branch: ${result.branch}`));
  lines.push('');

  if (result.pr) {
    const draftTag = result.pr.isDraft ? color.dim(' [draft]') : '';
    lines.push(color.bold('Pull Request'));
    lines.push(`  #${result.pr.id} ${result.pr.title}${draftTag}`);
    lines.push(`  ${color.dim(`${result.pr.status} · opened by ${result.pr.author}`)}`);
    lines.push(`  ${color.dim(result.pr.url)}`);
  } else {
    lines.push(color.dim('No active pull request for this branch.'));
  }
  lines.push('');

  lines.push(color.bold('Work Items'));
  if (result.workItems.length === 0) {
    lines.push(color.dim('  (none linked)'));
  } else {
    const rows = result.workItems.map((wi) => [
      wi.primary ? color.cyan(`#${wi.id} *`) : `#${wi.id}`,
      wi.type ?? color.dim('?'),
      wi.title ?? color.dim('(title unknown — no PR yet; run `dova wi view` for detail)'),
      wi.state ?? color.dim('?'),
    ]);
    lines.push(renderTable(['ID', 'Type', 'Title', 'State'], rows));
  }
  lines.push('');

  lines.push(color.bold('Pipeline Runs'));
  if (result.pipelineRuns.length === 0) {
    lines.push(color.dim('  (no runs found for this branch)'));
  } else {
    const rows = result.pipelineRuns.map((r) => {
      const outcome = r.result ?? r.status;
      const colored =
        outcome === 'succeeded' ? color.green(outcome)
        : outcome === 'failed' ? color.red(outcome)
        : color.yellow(outcome);
      return [r.name, colored, r.queueTime ?? color.dim('?'), color.dim(r.url)];
    });
    lines.push(renderTable(['Pipeline', 'Result', 'Queued', 'URL'], rows));
  }

  if (result.pr) {
    lines.push('');
    lines.push(color.bold('Comment Threads'));
    if (result.threads.length === 0) {
      lines.push(color.dim('  (no comment threads)'));
    } else {
      const rows = result.threads.map((t) => [
        t.unresolved ? color.yellow('open') : color.dim('resolved'),
        t.lastAuthor ?? color.dim('?'),
        (t.lastComment ?? '').slice(0, 60),
      ]);
      lines.push(renderTable(['Status', 'Last author', 'Last comment'], rows));
    }
  }

  if (result.warnings.length > 0) {
    lines.push('');
    for (const w of result.warnings) lines.push(color.yellow(`Warning: ${w}`));
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

export function registerStatusCommand(program: Command): void {
  const cmd = program
    .command('status')
    .description('Show the current branch: active PR, linked work items, recent pipeline runs, and comment threads');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);
  addWebOption(cmd);

  cmd.action(async (opts: StatusFlags) => {
    const color = getColor(opts.color === false);
    const result = await gatherStatus(opts);

    if (opts.web) {
      if (!result.pr) {
        throw new NotFoundError(`No active PR found for branch "${result.branch}" — nothing to open.`);
      }
      await openInBrowser(result.pr.url);
      return;
    }

    await emit(result as unknown as Record<string, unknown>, opts, () => renderStatusHuman(result, color));
  });
}
