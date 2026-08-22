import type { Command } from 'commander';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption, addWebOption, notImplemented } from '../../lib/command-helpers.js';

/** NOT YET IMPLEMENTED. `az boards work-item show --id <id>` under the hood. */
export function registerWiViewCommand(wi: Command): void {
  const cmd = wi
    .command('view <id>')
    .description('View a work item\'s detail');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);
  addWebOption(cmd);

  cmd.action(() => notImplemented('dova wi view'));
}
