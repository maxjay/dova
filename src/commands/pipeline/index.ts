import type { Command } from 'commander';
import { registerPipelineStatusCommand } from './status.js';
import { registerPipelineWatchCommand } from './watch.js';
import { registerPipelineLogCommand } from './log.js';

export function registerPipelineCommand(program: Command): void {
  const pipeline = program.command('pipeline').description('Pipeline run commands: status, watch, and log');
  registerPipelineStatusCommand(pipeline);
  registerPipelineWatchCommand(pipeline);
  registerPipelineLogCommand(pipeline);
}
