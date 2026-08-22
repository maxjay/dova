import type { Command } from 'commander';
import { defaultRunner } from '../lib/exec.js';
import { resolveContext } from '../lib/context.js';
import { gatherWorkItemDetail, renderWorkItemDetailHuman } from '../lib/work-items.js';
import { fetchPrById, gatherPrDetail, renderPrDetailHuman } from '../lib/pr.js';
import { parseWorkItemUrl, parsePrUrl, parseIdArgument, looksLikeUrl } from '../lib/urls.js';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption, addWebOption } from '../lib/command-helpers.js';
import { emit, getColor } from '../lib/output.js';
import { openInBrowser } from '../lib/browser.js';
import { NotFoundError, UserError } from '../lib/errors.js';
import type { Runner } from '../lib/exec.js';
import type { ResolvedContext } from '../lib/context.js';

interface ViewFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  json?: string | boolean;
  jq?: string;
  web?: boolean;
  color: boolean;
}

async function showWorkItem(runner: Runner, orgUrl: string, id: number, fallbackProject: string | undefined, opts: ViewFlags, color: ReturnType<typeof getColor>): Promise<void> {
  const detail = await gatherWorkItemDetail(runner, orgUrl, id, fallbackProject);
  if (opts.web) {
    await openInBrowser(detail.url);
    return;
  }
  await emit({ kind: 'work-item', ...detail }, opts, () => renderWorkItemDetailHuman(detail, color));
}

async function showPr(runner: Runner, orgUrl: string, id: number, ctx: ResolvedContext, opts: ViewFlags, color: ReturnType<typeof getColor>): Promise<void> {
  const pr = await fetchPrById(runner, orgUrl, id);
  const detail = await gatherPrDetail(runner, orgUrl, pr, ctx.project, ctx.repo);
  if (opts.web) {
    await openInBrowser(detail.url);
    return;
  }
  await emit({ kind: 'pull-request', ...detail }, opts, () => renderPrDetailHuman(detail, color));
}

/**
 * The generic "read anything" entrypoint: given a work item or PR link,
 * or a bare id, view its full detail. A link unambiguously says which
 * kind of resource it is; a bare id doesn't (work item ids and PR ids are
 * separate namespaces), so a bare id tries as a work item first, falling
 * back to a PR — work items are the far more common thing to look up by
 * bare id (a PR is almost always reached via `dova pr view` with no id,
 * or a pasted link).
 */
export function registerViewCommand(program: Command): void {
  const cmd = program
    .command('view <id-or-url>')
    .description('View a PR or work item, given its id or a link to it — auto-detects which');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);
  addWebOption(cmd);

  cmd.action(async (idArg: string, opts: ViewFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);

    if (looksLikeUrl(idArg)) {
      const wiUrl = parseWorkItemUrl(idArg);
      if (wiUrl) {
        const ctx = await resolveContext(runner, { org: opts.org ?? wiUrl.org, orgUrl: opts.orgUrl ?? wiUrl.orgUrl, project: opts.project ?? wiUrl.project, repo: opts.repo });
        await showWorkItem(runner, ctx.orgUrl, wiUrl.id, ctx.project, opts, color);
        return;
      }
      const prUrl = parsePrUrl(idArg);
      if (prUrl) {
        const ctx = await resolveContext(runner, { org: opts.org ?? prUrl.org, orgUrl: opts.orgUrl ?? prUrl.orgUrl, project: opts.project ?? prUrl.project, repo: opts.repo ?? prUrl.repo });
        await showPr(runner, ctx.orgUrl, prUrl.id, ctx, opts, color);
        return;
      }
      throw new UserError(`"${idArg}" looks like a URL, but not one dova recognizes as a work item or pull request link.`);
    }

    const bareId = parseIdArgument(idArg);
    if (bareId === null) {
      throw new UserError(`"${idArg}" is not a valid id or link.`);
    }

    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });

    try {
      await showWorkItem(runner, ctx.orgUrl, bareId, ctx.project, opts, color);
      return;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }

    // Not a work item — try it as a PR id instead. A PR lookup failure
    // here could be "doesn't exist" or something else entirely (az isn't
    // precise enough server-side to tell apart reliably), but since we
    // already know it isn't a work item, any failure means dova has
    // nothing left to try.
    try {
      await showPr(runner, ctx.orgUrl, bareId, ctx, opts, color);
    } catch {
      throw new NotFoundError(`#${bareId} was not found as a work item or a pull request.`);
    }
  });
}
