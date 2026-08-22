import type { Command } from 'commander';
import { addContextOptions, addJsonOption, addTeamOptions, notImplemented } from '../lib/command-helpers.js';

/**
 * NOT YET IMPLEMENTED. Sugar over `dova wi quick bug <title>` — see
 * commands/wi/quick.ts for the shared implementation once it lands.
 */
export function registerBugCommand(program: Command): void {
  const cmd = program
    .command('bug <title>')
    .description('Quickly file a Bug work item — resolves team/area/iteration silently from cache when possible')
    .option('--at <location>', 'file:line to build a "Found in:" permalink from (uses the resolved remote + current HEAD)')
    .option('--start', 'chain into `dova start` with the newly created id');

  addContextOptions(cmd);
  addTeamOptions(cmd);
  addJsonOption(cmd);

  cmd.action(() => notImplemented('dova bug'));
}
