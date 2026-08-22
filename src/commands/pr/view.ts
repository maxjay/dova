import type { Command } from 'commander';
import { defaultRunner } from '../../lib/exec.js';
import { resolveContext, buildPrWebUrl } from '../../lib/context.js';
import { fetchActivePrForBranch, fetchPrById, fetchPrWorkItems, fetchDiscussionThreads, isUnresolvedThreadStatus } from '../../lib/pr.js';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption, addWebOption } from '../../lib/command-helpers.js';
import { emit, getColor, renderTable } from '../../lib/output.js';
import { openInBrowser } from '../../lib/browser.js';
import { NotFoundError, UserError } from '../../lib/errors.js';

interface PrViewFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  json?: string | boolean;
  jq?: string;
  web?: boolean;
  color: boolean;
}

export function registerPrViewCommand(pr: Command): void {
  const cmd = pr
    .command('view [id]')
    .description("View a pull request's full detail, including comment threads (default: PR for current branch)");

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);
  addWebOption(cmd);

  cmd.action(async (idArg: string | undefined, opts: PrViewFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);
    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });

    const pullRequest = idArg
      ? await fetchPrById(runner, ctx.orgUrl, Number(idArg))
      : await (async () => {
          if (!ctx.repo) throw new UserError('"dova pr view" needs a repo in context.', ['Pass --repo, or run this inside the repo.']);
          if (!ctx.branch) throw new UserError('Not currently on a branch (detached HEAD?).');
          const found = await fetchActivePrForBranch(runner, ctx.orgUrl, ctx.project, ctx.repo, ctx.branch);
          if (!found) throw new NotFoundError(`No active PR found for branch "${ctx.branch}" in repo "${ctx.repo}".`);
          return found;
        })();

    const repoName = pullRequest.repository?.name ?? ctx.repo;
    const project = pullRequest.repository?.project?.name ?? ctx.project;
    if (!repoName) {
      throw new UserError(`Could not determine which repo PR #${pullRequest.pullRequestId} belongs to.`);
    }
    const url = buildPrWebUrl({ orgUrl: ctx.orgUrl, project, repo: repoName }, pullRequest.pullRequestId);

    if (opts.web) {
      await openInBrowser(url);
      return;
    }

    const [workItems, threads] = await Promise.all([
      fetchPrWorkItems(runner, ctx.orgUrl, pullRequest.pullRequestId),
      fetchDiscussionThreads(runner, ctx.orgUrl, project, repoName, pullRequest.pullRequestId),
    ]);

    const result = {
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
            commentCount: t.comments.length,
            lastAuthor: last?.author?.displayName ?? null,
            lastComment: last?.content ?? null,
          };
        })
        .sort((a, b) => Number(b.unresolved) - Number(a.unresolved)),
    };

    await emit(result, opts, () => {
      const draftTag = result.isDraft ? color.dim(' [draft]') : '';
      const lines: string[] = [
        `${color.bold(`#${result.id}`)} ${result.title}${draftTag}`,
        color.dim(`${result.status} · opened by ${result.author} · ${result.sourceBranch} -> ${result.targetBranch}`),
        color.dim(result.url),
        '',
        color.bold('Work Items'),
      ];
      if (result.workItems.length === 0) {
        lines.push(color.dim('  (none linked)'));
      } else {
        lines.push(
          renderTable(
            ['ID', 'Type', 'Title', 'State'],
            result.workItems.map((w) => [`#${w.id}`, w.type ?? '?', w.title ?? '(no title)', w.state ?? '?'])
          )
        );
      }
      lines.push('', color.bold('Comment Threads'));
      if (result.threads.length === 0) {
        lines.push(color.dim('  (no comment threads)'));
      } else {
        lines.push(
          renderTable(
            ['Status', 'Last author', 'Last comment'],
            result.threads.map((t) => [t.unresolved ? color.yellow('open') : color.dim('resolved'), t.lastAuthor ?? '?', (t.lastComment ?? '').slice(0, 60)])
          )
        );
      }
      process.stdout.write(`${lines.join('\n')}\n`);
    });
  });
}
