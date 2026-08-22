import { Command } from 'commander';
import { registerStatusCommand } from './commands/status.js';
import { registerStartCommand } from './commands/start.js';
import { registerBugCommand } from './commands/bug.js';
import { registerViewCommand } from './commands/view.js';
import { registerWiCommand } from './commands/wi/index.js';
import { registerPrCommand } from './commands/pr/index.js';
import { registerPipelineCommand } from './commands/pipeline/index.js';
import { registerApiCommand } from './commands/api.js';
import { registerCompletionCommand } from './commands/completion.js';

/**
 * Assembles the full dova command tree. This is the single source of
 * truth `dova completion <shell>` introspects — there is no separate,
 * hand-maintained list of commands to keep in sync with this one.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('dova')
    .description(
      'A CLI for Azure DevOps that wraps az + git, inferring org/project/repo/team from the current directory.'
    )
    .version('0.1.0')
    .showHelpAfterError(true)
    // Throw instead of calling process.exit directly, so index.ts owns exit-code mapping.
    .exitOverride();

  registerStatusCommand(program);
  registerStartCommand(program);
  registerBugCommand(program);
  registerViewCommand(program);
  registerWiCommand(program);
  registerPrCommand(program);
  registerPipelineCommand(program);
  registerApiCommand(program);
  registerCompletionCommand(program);

  return program;
}
