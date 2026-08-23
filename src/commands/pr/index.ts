import type { Command } from 'commander';
import { registerPrCreateCommand } from './create.js';
import { registerPrViewCommand } from './view.js';
import { registerPrCommentCommand } from './comment.js';

export function registerPrCommand(program: Command): void {
  const pr = program.command('pr').description('Pull request commands: create, view, and comment');
  registerPrCreateCommand(pr);
  registerPrViewCommand(pr);
  registerPrCommentCommand(pr);
}
