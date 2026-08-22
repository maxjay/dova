import type { Command } from 'commander';
import { addContextOptions, addJsonOption, addTeamOptions, notImplemented } from '../../lib/command-helpers.js';

/** NOT YET IMPLEMENTED. General form of `dova bug`: `dova wi quick <type> <title>`. */
export function registerWiQuickCommand(wi: Command): void {
  const cmd = wi
    .command('quick <type> <title>')
    .description('Fast work item filing for any type — `dova bug` is sugar over this with type defaulted to Bug')
    .option('--at <location>', 'file:line to build a "Found in:" permalink from')
    .option('--start', 'chain into `dova start` with the newly created id');

  addContextOptions(cmd);
  addTeamOptions(cmd);
  addJsonOption(cmd);

  cmd.action(() => notImplemented('dova wi quick'));
}
