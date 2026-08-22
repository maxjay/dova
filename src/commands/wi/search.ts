import type { Command } from 'commander';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption, notImplemented } from '../../lib/command-helpers.js';

/**
 * NOT YET IMPLEMENTED. Builds WIQL from the flags below — the user should
 * never need to write WIQL by hand. Runs via `az boards query --wiql`.
 */
export function registerWiSearchCommand(wi: Command): void {
  const cmd = wi
    .command('search <query>')
    .description('Search work items by free-text title match plus filters (builds WIQL for you)')
    .option('--state <state>', 'filter by state (as defined by this project\'s process)')
    .option('--assigned-to <user>', 'filter by assignee')
    .option('--type <type>', 'filter by work item type')
    .option('--tag <tag>', 'filter by tag');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);

  cmd.action(() => notImplemented('dova wi search'));
}
