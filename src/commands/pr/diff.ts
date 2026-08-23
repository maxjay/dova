import type { Command } from 'commander';
import { defaultRunner } from '../../lib/exec.js';
import { resolveContext } from '../../lib/context.js';
import { fetchActivePrForBranch, fetchPrById, gatherPrDiff, renderPrDiffHuman } from '../../lib/pr.js';
import { parsePrUrl, parseIdArgument, looksLikeUrl } from '../../lib/urls.js';
import { addContextOptions, addJsonOption, addNoColorOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
import { NotFoundError, UserError } from '../../lib/errors.js';

interface PrDiffFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  stat?: boolean;
  json?: string | boolean;
  color: boolean;
}

/**
 * The actual code diff of a PR — yours or someone else's. Same
 * id-or-url-or-current-branch resolution as `dova pr view`.
 */
export function registerPrDiffCommand(pr: Command): void {
  const cmd = pr
    .command('diff [id-or-url]')
    .description("Show a pull request's actual code diff (default: PR for current branch)")
    .option('--stat', 'show the diff stat only, not the full patch');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addNoColorOption(cmd);

  cmd.action(async (idArg: string | undefined, opts: PrDiffFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);

    const fromUrl = idArg && looksLikeUrl(idArg) ? parsePrUrl(idArg) : null;
    if (idArg && looksLikeUrl(idArg) && !fromUrl) {
      throw new UserError(`"${idArg}" looks like a URL, but not one dova recognizes as a pull request link.`);
    }
    const bareId = !idArg || fromUrl ? null : parseIdArgument(idArg);
    if (idArg && !fromUrl && bareId === null) {
      throw new UserError(`"${idArg}" is not a valid pull request id or link.`);
    }

    const ctx = await resolveContext(runner, {
      org: opts.org ?? fromUrl?.org,
      orgUrl: opts.orgUrl ?? fromUrl?.orgUrl,
      project: opts.project ?? fromUrl?.project,
      repo: opts.repo ?? fromUrl?.repo,
    });

    const pullRequest =
      fromUrl || bareId !== null
        ? await fetchPrById(runner, ctx.orgUrl, fromUrl?.id ?? bareId!)
        : await (async () => {
            if (!ctx.repo) throw new UserError('"dova pr diff" needs a repo in context.', ['Pass --repo, or run this inside the repo.']);
            if (!ctx.branch) throw new UserError('Not currently on a branch (detached HEAD?).');
            const found = await fetchActivePrForBranch(runner, ctx.orgUrl, ctx.project, ctx.repo, ctx.branch);
            if (!found) throw new NotFoundError(`No active PR found for branch "${ctx.branch}" in repo "${ctx.repo}".`);
            return found;
          })();

    const diff = await gatherPrDiff(runner, pullRequest, { full: !opts.stat });

    await emit(diff, opts, () => renderPrDiffHuman(diff, !opts.stat, color));
  });
}
