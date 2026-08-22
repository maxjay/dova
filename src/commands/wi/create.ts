import type { Command } from 'commander';
import { addContextOptions, addJsonOption, addTeamOptions, notImplemented } from '../../lib/command-helpers.js';

/**
 * NOT YET IMPLEMENTED. Work item types must come from `az boards
 * work-item-type list --project <p>` (or the process API) — never
 * hardcoded, since v1 must work on any process template.
 */
export function registerWiCreateCommand(wi: Command): void {
  const cmd = wi
    .command('create')
    .description('Create a work item (the fuller version of `dova bug` / `dova wi quick`)')
    .requiredOption('--type <type>', 'work item type, as defined by this project\'s process')
    .requiredOption('--title <title>', 'title')
    .option('--assign-to <user>', 'assign to a user (default: unassigned)')
    .option('--parent <id>', 'link as a child of this work item id');

  addContextOptions(cmd);
  addTeamOptions(cmd);
  addJsonOption(cmd);

  cmd.action(() => notImplemented('dova wi create'));
}
