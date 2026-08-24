import type { Command } from 'commander';
import { addContextOptions, addJsonOption, addNoColorOption, addNoInputOption } from '../lib/command-helpers.js';
import { emit, getColor } from '../lib/output.js';
import { runLink, renderLinkHuman } from '../lib/link.js';

interface LinkFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  primary?: string;
  json?: string | boolean;
  color: boolean;
}

/**
 * dova's only involvement in "begin work on a ticket": records that the
 * branch you're already on corresponds to these work item(s), so
 * `dova pr create` can link them automatically. Doesn't create, name, or
 * check out a branch — that's git, already done before this runs. See
 * lib/link.ts for the implementation.
 */
export function registerLinkCommand(program: Command): void {
  const cmd = program
    .command('link')
    .description("Link the current branch to one or more work items, so `dova pr create` picks them up automatically")
    .argument('<ids...>', 'work item id(s) to link to the current branch')
    .option('--primary <id>', 'which id drives PR title/description defaults (default: the first, or whatever was already primary)');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addNoColorOption(cmd);
  addNoInputOption(cmd);

  cmd.action(async (ids: string[], opts: LinkFlags) => {
    const color = getColor(opts.color === false);
    const result = await runLink({
      ids,
      primary: opts.primary,
      org: opts.org,
      orgUrl: opts.orgUrl,
      project: opts.project,
      repo: opts.repo,
      json: opts.json,
      color,
    });

    await emit(result, opts, () => renderLinkHuman(result, color));
  });
}
