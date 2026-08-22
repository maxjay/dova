import type { Command } from 'commander';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption, notImplemented } from '../../lib/command-helpers.js';

/** NOT YET IMPLEMENTED. `az pipelines runs list --branch <branch>` under the hood — see commands/status.ts for the same call. */
export function registerPipelineStatusCommand(pipeline: Command): void {
  const cmd = pipeline
    .command('status')
    .description('Recent pipeline runs for a branch (default: current branch)')
    .option('--branch <branch>', 'branch to show runs for (default: current branch)');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);

  cmd.action(() => notImplemented('dova pipeline status'));
}
