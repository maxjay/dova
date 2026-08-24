import type { Command } from 'commander';
import type { Runner } from '../../lib/exec.js';
import { defaultRunner, runAzJson, tryGit } from '../../lib/exec.js';
import { readTextArg, stdinHasData } from '../../lib/stdin.js';
import { gitConfigGet } from '../../lib/config.js';
import { resolveContext, buildPrWebUrl, resolveDefaultBranch } from '../../lib/context.js';
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
  description?: string;
  target?: string;
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
    .option('--description <text>', "description/body (use '-' to read it from stdin)")
    .option('--target <branch>', "branch to merge into (default: resolved from the repo — you shouldn't need this)")
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

    // Only one of these can read stdin, and piping without asking for it
    // would silently drop the text — see the guard below.
    if (opts.title === '-' && opts.description === '-') {
      throw new UserError('Only one of --title and --description can read stdin.', [
        'Pass the short one inline: --title \'...\' --description -',
      ]);
    }

    // `--title -` reads stdin; omitting --title entirely still falls back
    // to the last commit subject, so it can't mean "read stdin" here.
    const title =
      opts.title === '-'
        ? await readTextArg('-', { what: 'title' })
        : opts.title ?? (await tryGit(runner, ['log', '-1', '--format=%s'])) ?? `Merge ${ctx.branch}`;

    const description =
      opts.description === '-' ? await readTextArg('-', { what: 'description' }) : opts.description;

    // Text piped in that nothing asked for is text that would vanish: the
    // PR gets created, looks fine, and has no description. Catch it here
    // rather than let it succeed emptily.
    if (stdinHasData() && opts.title !== '-' && opts.description !== '-') {
      throw new UserError('Something is piped into `dova pr create`, but nothing was told to read it.', [
        "Pass --description - to use it as the PR description (or --title - for the title).",
        'Example: cat body.md | dova pr create --title \'...\' --description -',
      ]);
    }

    const args = [
      'repos', 'pr', 'create',
      '--organization', ctx.orgUrl,
      '--project', ctx.project,
      '--repository', ctx.repo,
      '--source-branch', ctx.branch,
      '--title', title,
      '--transition-work-items', 'true',
    ];
    // az's --description takes a list, one argument per line, joined with
    // newlines on its side — but a single argument containing newlines
    // survives that join unchanged, so pass it whole.
    if (description) args.push('--description', description);

    // Resolved, not asked for. `origin/HEAD` already says what this repo
    // merges into — `dova summarize` has always read it to pick a diff
    // base — so a PR has no business making the caller name it. Left to
    // az's own default this silently targets the repo default branch,
    // which is wrong wherever a team integrates into `develop`.
    const target = opts.target ?? (await resolveDefaultBranch(runner, ctx))?.branch;
    if (target) args.push('--target-branch', target);

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
