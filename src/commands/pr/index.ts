import type { Command } from 'commander';
import { registerPrCreateCommand } from './create.js';
import { registerPrViewCommand } from './view.js';
import { registerPrDiffCommand } from './diff.js';
import { registerPrCommentCommand } from './comment.js';

export function registerPrCommand(program: Command): void {
  const pr = program.command('pr').description('Pull request commands: create, view, diff, and comment');
  registerPrCreateCommand(pr);
  registerPrViewCommand(pr);
  registerPrDiffCommand(pr);
  registerPrCommentCommand(pr);
}
