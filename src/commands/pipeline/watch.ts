import type { Command } from 'commander';
import { addContextOptions, addJsonOption, notImplemented } from '../../lib/command-helpers.js';

/**
 * NOT YET IMPLEMENTED. Polls `az pipelines runs show --id <run-id>` until
 * the run finishes, similar to `gh run watch`. The only long-lived
 * behavior in dova — it still polls-and-exits, no daemon.
 */
export function registerPipelineWatchCommand(pipeline: Command): void {
  const cmd = pipeline
    .command('watch [run-id]')
    .description('Poll a pipeline run until it finishes (default: most recent run for current branch)');

  addContextOptions(cmd);
  addJsonOption(cmd);

  cmd.action(() => notImplemented('dova pipeline watch'));
}
