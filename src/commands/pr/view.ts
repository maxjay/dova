import type { Command } from 'commander';
import { defaultRunner } from '../../lib/exec.js';
import { resolveContext } from '../../lib/context.js';
import { fetchActivePrForBranch, fetchPrById, gatherPrDetail, renderPrDetailHuman } from '../../lib/pr.js';
import { parsePrUrl, parseIdArgument, looksLikeUrl } from '../../lib/urls.js';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption, addWebOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
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
    .command('view [id-or-url]')
    .description("View a pull request's full detail, including comment threads (default: PR for current branch)");

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);
  addWebOption(cmd);

  cmd.action(async (idArg: string | undefined, opts: PrViewFlags) => {
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
            if (!ctx.repo) throw new UserError('"dova pr view" needs a repo in context.', ['Pass --repo, or run this inside the repo.']);
            if (!ctx.branch) throw new UserError('Not currently on a branch (detached HEAD?).');
            const found = await fetchActivePrForBranch(runner, ctx.orgUrl, ctx.project, ctx.repo, ctx.branch);
            if (!found) throw new NotFoundError(`No active PR found for branch "${ctx.branch}" in repo "${ctx.repo}".`);
            return found;
          })();

    const detail = await gatherPrDetail(runner, ctx.orgUrl, pullRequest, ctx.project, ctx.repo);

    if (opts.web) {
      await openInBrowser(detail.url);
      return;
    }

    await emit(detail, opts, () => renderPrDetailHuman(detail, color));
  });
}
