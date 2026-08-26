import type { Command } from 'commander';
import { defaultRunner, runAzJson } from '../../lib/exec.js';
import { readTextArg, stdinHasData } from '../../lib/stdin.js';
import { resolveContext, buildPrWebUrl } from '../../lib/context.js';
import { fetchActivePrForBranch } from '../../lib/pr.js';
import { parseIdArgument } from '../../lib/urls.js';
import { addContextOptions, addJsonOption, addNoColorOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
import { NotFoundError, UserError } from '../../lib/errors.js';
import { describeLostDescription } from './create.js';
import type { AzPullRequest } from '../../types/azure-devops.js';

interface PrEditFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  title?: string;
  description?: string;
  draft?: boolean | string;
  json?: string | boolean;
  color: boolean;
}

export function registerPrEditCommand(pr: Command): void {
  const cmd = pr
    .command('edit [id]')
    .description("Change a pull request's title or description (default: PR for current branch)")
    .option('--title <title>', "new title (use '-' to read it from stdin)")
    .option('--description <text>', "new description (use '-' to read it from stdin)")
    .option('--draft [value]', 'mark as draft, or --draft false to publish');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addNoColorOption(cmd);

  cmd.action(async (idArg: string | undefined, opts: PrEditFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);

    if (opts.title === undefined && opts.description === undefined && opts.draft === undefined) {
      throw new UserError('Nothing to change.', ['Pass --title, --description or --draft.']);
    }
    if (opts.title === '-' && opts.description === '-') {
      throw new UserError('Only one of --title and --description can read stdin.', [
        "Pass the short one inline: --title '...' --description -",
      ]);
    }
    if (stdinHasData() && opts.title !== '-' && opts.description !== '-') {
      throw new UserError('Something is piped into `dova pr edit`, but nothing was told to read it.', [
        'Pass --description - to use it as the description (or --title - for the title).',
      ]);
    }

    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });

    const bareId = idArg ? parseIdArgument(idArg) : null;
    if (idArg && bareId === null) throw new UserError(`"${idArg}" is not a valid pull request id.`);

    const id =
      bareId ??
      (await (async () => {
        if (!ctx.repo) throw new UserError('"dova pr edit" needs a repo in context.', ['Pass --repo, or run this inside the repo.']);
        if (!ctx.branch) throw new UserError('Not currently on a branch (detached HEAD?).');
        const found = await fetchActivePrForBranch(runner, ctx.orgUrl, ctx.project, ctx.repo, ctx.branch);
        if (!found) throw new NotFoundError(`No active PR found for branch "${ctx.branch}" in repo "${ctx.repo}".`);
        return found.pullRequestId;
      })());

    const title = opts.title === '-' ? await readTextArg('-', { what: 'title' }) : opts.title;
    const description =
      opts.description === '-' ? await readTextArg('-', { what: 'description' }) : opts.description;

    const args = ['repos', 'pr', 'update', '--id', String(id), '--organization', ctx.orgUrl];
    if (title !== undefined) args.push('--title', title);
    if (description !== undefined) args.push('--description', description);
    if (opts.draft !== undefined) {
      args.push('--draft', opts.draft === false || opts.draft === 'false' ? 'false' : 'true');
    }

    const updated = await runAzJson<AzPullRequest>(runner, args);

    // Same shell-mangling check `pr create` makes — a description passed
    // inline on Windows can arrive empty, and az reports success either way.
    const lost = describeLostDescription(description, updated.description);
    if (lost) {
      process.stderr.write(
        `${color.yellow('Warning')}: the description ${lost}.\n` +
          `  Send it on stdin rather than inline — see \`dova pr edit --help\`.\n`
      );
    }

    const result = {
      id: updated.pullRequestId,
      title: updated.title,
      isDraft: Boolean(updated.isDraft),
      url: buildPrWebUrl(ctx, updated.pullRequestId),
    };

    await emit(result, opts, () => {
      const changed = [
        title !== undefined ? 'title' : undefined,
        description !== undefined ? 'description' : undefined,
        opts.draft !== undefined ? 'draft' : undefined,
      ].filter(Boolean);
      process.stdout.write(
        `${color.green('Updated')} PR ${color.bold(`#${result.id}`)} (${changed.join(', ')})\n  ${color.dim(result.url)}\n`
      );
    });
  });
}
