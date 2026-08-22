import type { Command } from 'commander';
import { addContextOptions, addJsonOption, notImplemented } from '../../lib/command-helpers.js';

/** NOT YET IMPLEMENTED. Posts a comment; `resolve` changes a thread's status. */
export function registerPrCommentCommand(pr: Command): void {
  const comment = pr
    .command('comment <id> <text>')
    .description('Post a comment on a pull request');

  addContextOptions(comment);
  addJsonOption(comment);
  comment.action(() => notImplemented('dova pr comment'));

  comment
    .command('resolve <id> <thread-id>')
    .description('Change a comment thread\'s status to resolved')
    .action(() => notImplemented('dova pr comment resolve'));
}
