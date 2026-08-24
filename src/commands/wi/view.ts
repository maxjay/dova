import type { Command } from 'commander';
import { defaultRunner } from '../../lib/exec.js';
import { resolveContext } from '../../lib/context.js';
import { gatherWorkItemDetail, renderWorkItemDetailHuman } from '../../lib/work-items.js';
import { parseWorkItemUrl, parseIdArgument, looksLikeUrl } from '../../lib/urls.js';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption, addWebOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
import { openInBrowser } from '../../lib/browser.js';
import { UserError } from '../../lib/errors.js';

interface WiViewFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  json?: string | boolean;
  jq?: string;
  web?: boolean;
  full?: boolean;
  color: boolean;
}

export function registerWiViewCommand(wi: Command): void {
  const cmd = wi
    .command('view <id-or-url>')
    .description("View a work item's detail (parent + children), given its id or a link to it");

  cmd.option('--full', "show the ticket's description/acceptance criteria in full, not truncated");

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);
  addWebOption(cmd);

  cmd.action(async (idArg: string, opts: WiViewFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);

    const fromUrl = looksLikeUrl(idArg) ? parseWorkItemUrl(idArg) : null;
    if (looksLikeUrl(idArg) && !fromUrl) {
      throw new UserError(`"${idArg}" looks like a URL, but not one dova recognizes as a work item link.`);
    }
    const bareId = fromUrl ? null : parseIdArgument(idArg);
    if (!fromUrl && bareId === null) {
      throw new UserError(`"${idArg}" is not a valid work item id or link.`);
    }

    const ctx = await resolveContext(runner, {
      org: opts.org ?? fromUrl?.org,
      orgUrl: opts.orgUrl ?? fromUrl?.orgUrl,
      project: opts.project ?? fromUrl?.project,
      repo: opts.repo,
    });

    const id = fromUrl?.id ?? bareId!;
    const detail = await gatherWorkItemDetail(runner, ctx.orgUrl, id, ctx.project);

    if (opts.web) {
      await openInBrowser(detail.url);
      return;
    }

    await emit(detail, opts, () => renderWorkItemDetailHuman(detail, color, Boolean(opts.full)));
  });
}
