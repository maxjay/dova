import type { Command } from 'commander';
import { addContextOptions, addJsonOption, addNoColorOption } from '../lib/command-helpers.js';
import { emit, getColor } from '../lib/output.js';
import { runUnlink, renderUnlinkHuman } from '../lib/link.js';

interface UnlinkFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  all?: boolean;
  primary?: string;
  json?: string | boolean;
  color: boolean;
}

/** The undo for a bad `dova link` — see lib/link.ts's runUnlink. */
export function registerUnlinkCommand(program: Command): void {
  const cmd = program
    .command('unlink [ids...]')
    .description("Remove work item(s) from the branch you're on (undo a bad `dova link`)")
    .option('--all', 'remove every linked work item from this branch')
    .option('--primary <id>', 'which id stays primary among what remains (default: keep the existing primary if still linked, else the first remaining id)');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addNoColorOption(cmd);

  cmd.action(async (ids: string[], opts: UnlinkFlags) => {
    const color = getColor(opts.color === false);
    const result = await runUnlink({
      ids,
      all: opts.all,
      primary: opts.primary,
      org: opts.org,
      orgUrl: opts.orgUrl,
      project: opts.project,
      repo: opts.repo,
      json: opts.json,
      color,
    });

    await emit(result, opts, () => renderUnlinkHuman(result, color));
  });
}
