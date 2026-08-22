import type { Command } from 'commander';
import { addContextOptions, addJsonOption, notImplemented } from '../../lib/command-helpers.js';

/**
 * NOT YET IMPLEMENTED. Wraps `az repos pr create --transition-work-items
 * true`. Source branch comes from the current branch; --work-items
 * defaults to branch.<name>.dova-workitems (see `dova start`), then falls
 * back to `#<id>` references in this branch's commit messages; explicit
 * --work-items overrides both. --title defaults to the last commit subject.
 */
export function registerPrCreateCommand(pr: Command): void {
  const cmd = pr
    .command('create')
    .description('Create a pull request from the current branch')
    .option('--work-items <ids...>', 'work item ids to link (default: tracked ids from `dova start`, or #id refs in commit messages)')
    .option('--title <title>', 'title (default: last commit subject)')
    .option('--draft', 'create as a draft PR');

  addContextOptions(cmd);
  addJsonOption(cmd);

  cmd.action(() => notImplemented('dova pr create'));
}
