import type { Command } from 'commander';
import { addContextOptions, addJsonOption, addTeamOptions, notImplemented } from '../lib/command-helpers.js';

/**
 * NOT YET IMPLEMENTED. Scaffolded so the command tree, --help, and shell
 * completions are complete; wire up the real logic against
 * lib/context.ts + lib/team-resolver.ts next.
 *
 * Planned behavior (see project brief):
 *   - Portfolio-level ids (Epic/Feature/etc, by state category not literal
 *     type name) expand to a multi-select of their non-completed children.
 *   - First id is primary unless --primary given; only the primary drives
 *     the branch name via the user's type->prefix map.
 *   - Checks branch.<name>.dova-workitems across local branches before
 *     creating a duplicate; best-effort remote-branch-name scan as a
 *     secondary check.
 *   - Transitions each item to its next InProgress-category state
 *     (resolved from process metadata, never a literal state string);
 *     skips + warns instead of regressing an item already past InProgress.
 *   - Offers to assign unassigned items to the current user.
 *   - Tracks the linked set via branch.<name>.dova-workitems /
 *     branch.<name>.dova-primary (local git config, never pushed).
 */
export function registerStartCommand(program: Command): void {
  const cmd = program
    .command('start')
    .description('Begin work on one or more work items: branch, transition state, assign, and track them')
    .argument('<ids...>', 'work item id(s) to start work on')
    .option('--primary <id>', 'which id drives the branch name (default: the first)')
    .option('--assign', 'assign unassigned items to the current user (default: prompt)')
    .option('--no-assign', 'never assign items to the current user');

  addContextOptions(cmd);
  addTeamOptions(cmd);
  addJsonOption(cmd);

  cmd.action(() => notImplemented('dova start'));
}
