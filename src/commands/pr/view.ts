import type { Command } from 'commander';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption, addWebOption, notImplemented } from '../../lib/command-helpers.js';

/**
 * NOT YET IMPLEMENTED. Defaults to the PR for the current branch (same
 * lookup as `dova status`'s call 1). Full detail including comment
 * threads — reuses the same threads fallback as `dova status`.
 */
export function registerPrViewCommand(pr: Command): void {
  const cmd = pr
    .command('view [id]')
    .description('View a pull request\'s full detail, including comment threads (default: PR for current branch)');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);
  addWebOption(cmd);

  cmd.action(() => notImplemented('dova pr view'));
}
