import type { Command } from 'commander';
import type { Runner } from '../../lib/exec.js';
import { defaultRunner, runAzJson, tryGit } from '../../lib/exec.js';
import { readTextArg } from '../../lib/stdin.js';
import { gitConfigGet } from '../../lib/config.js';
import { resolveContext, buildPrWebUrl } from '../../lib/context.js';
import { addContextOptions, addJsonOption, addNoColorOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
import { UserError } from '../../lib/errors.js';
import type { AzPullRequest } from '../../types/azure-devops.js';

interface PrCreateFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  workItems?: string[];
  title?: string;
  draft?: boolean;
  json?: string | boolean;
  color: boolean;
}

/** Recent commit subjects on this branch that reference a work item as `#<id>`, most recent first, deduped. */
async function workItemsFromCommitMessages(runner: Runner, cwd?: string): Promise<string[]> {
  const log = await tryGit(runner, ['log', '-50', '--format=%s'], { cwd });
  if (!log) return [];
  const seen = new Set<string>();
  for (const line of log.split('\n')) {
    for (const match of line.matchAll(/#(\d+)/g)) {
      seen.add(match[1]!);
    }
  }
  return [...seen];
}

export function registerPrCreateCommand(pr: Command): void {
  const cmd = pr
    .command('create')
    .description('Create a pull request from the current branch')
    .option(
      '--work-items <ids...>',
      "work item ids to link (default: tracked ids from `dova link`, or #id refs in this branch's commit messages)"
    )
    .option('--title <title>', "title (default: last commit subject; use '-' to read it from stdin)")
    .option('--draft', 'create as a draft PR');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addNoColorOption(cmd);

  cmd.action(async (opts: PrCreateFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);
    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });

    if (!ctx.repo) throw new UserError('"dova pr create" needs a repo in context.', ['Pass --repo, or run this inside the repo.']);
    if (!ctx.branch) throw new UserError('Not currently on a branch (detached HEAD?).');

    let workItems = opts.workItems;
    if (!workItems || workItems.length === 0) {
      const tracked = await gitConfigGet(runner, `branch.${ctx.branch}.dova-workitems`);
      workItems = tracked ? tracked.split(',').map((s) => s.trim()).filter(Boolean) : await workItemsFromCommitMessages(runner);
    }

    // `--title -` reads stdin; omitting --title entirely still falls back
    // to the last commit subject, so it can't mean "read stdin" here.
    const title =
      opts.title === '-'
        ? await readTextArg('-', { what: 'title' })
        : opts.title ?? (await tryGit(runner, ['log', '-1', '--format=%s'])) ?? `Merge ${ctx.branch}`;

    const args = [
      'repos', 'pr', 'create',
      '--organization', ctx.orgUrl,
      '--project', ctx.project,
      '--repository', ctx.repo,
      '--source-branch', ctx.branch,
      '--title', title,
      '--transition-work-items', 'true',
    ];
    if (workItems.length > 0) args.push('--work-items', ...workItems);
    if (opts.draft) args.push('--draft', 'true');

    const created = await runAzJson<AzPullRequest>(runner, args);

    const result = {
      id: created.pullRequestId,
      title: created.title,
      status: created.status,
      isDraft: Boolean(created.isDraft),
      url: buildPrWebUrl(ctx, created.pullRequestId),
      workItems: workItems.map(Number),
    };

    await emit(result, opts, () => {
      const draftTag = result.isDraft ? color.dim(' [draft]') : '';
      process.stdout.write(
        [
          `${color.green('Created')} PR ${color.bold(`#${result.id}`)}${draftTag} — ${result.title}`,
          `  ${color.dim(result.url)}`,
          result.workItems.length > 0 ? `  Work items: ${result.workItems.map((id) => `#${id}`).join(', ')}` : undefined,
        ]
          .filter((l): l is string => l !== undefined)
          .join('\n') + '\n'
      );
    });
  });
}
