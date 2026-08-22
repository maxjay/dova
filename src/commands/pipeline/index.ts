import type { Command } from 'commander';
import { registerPipelineStatusCommand } from './status.js';
import { registerPipelineWatchCommand } from './watch.js';

export function registerPipelineCommand(program: Command): void {
  const pipeline = program.command('pipeline').description('Pipeline run commands: status and watch');
  registerPipelineStatusCommand(pipeline);
  registerPipelineWatchCommand(pipeline);
}
