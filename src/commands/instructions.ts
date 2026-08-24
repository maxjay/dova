import type { Command } from 'commander';
import { defaultRunner, tryGit } from '../lib/exec.js';
import { addJsonOption, addJqOption, addNoColorOption } from '../lib/command-helpers.js';
import { emit, getColor } from '../lib/output.js';
import { runInstructionsInstall, TARGETS } from '../lib/instructions-install.js';
import { UserError } from '../lib/errors.js';

interface AgentsInitFlags {
  dryRun?: boolean;
  json?: string | boolean;
  jq?: string;
  color: boolean;
}

export function registerInstructionsCommand(program: Command): void {
  // `agents` stays as an alias: AGENTS.md is the filename people know,
  // so it's what they'll reach for — but the command's own name says
  // "instructions", which is what both files actually are.
  const instructions = program
    .command('instructions')
    .alias('agents')
    .description('Set up coding agents (Windsurf, GitHub Copilot) to use dova correctly');

  const init = instructions
    .command('init')
    .description(`Write dova's usage rules into ${TARGETS.map((t) => t.file).join(' and ')}`)
    .option('--dry-run', 'report what would be written without writing anything');

  addJsonOption(init);
  addJqOption(init);
  addNoColorOption(init);

  init.action(async (opts: AgentsInitFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);

    // Written at the repo root, not the working directory: both files
    // are only read from there, so writing them into a subdirectory
    // would produce something that looks installed and never loads.
    const root = await tryGit(runner, ['rev-parse', '--show-toplevel']);
    if (!root) {
      throw new UserError('`dova instructions init` needs to run inside a git repository.', [
        'AGENTS.md and .github/copilot-instructions.md are only read from the repo root.',
      ]);
    }

    const result = runInstructionsInstall({ root, dryRun: opts.dryRun });

    await emit(result, opts, () => {
      const lines: string[] = [];
      lines.push(opts.dryRun ? color.bold('Would write:') : color.bold('Wrote:'));
      for (const file of result.files) {
        const mark = file.action === 'unchanged' ? color.dim('=') : color.green('✓');
        lines.push(`  ${mark} ${file.file}${color.dim(`  — ${file.read_by}`)}`);
        lines.push(`      ${color.dim(file.action)}`);
      }
      for (const warning of result.warnings) {
        lines.push('', color.yellow(`Warning: ${warning}`));
      }
      lines.push(
        '',
        color.dim('Commit these so everyone on the repo gets them. Re-run after upgrading dova to refresh the block.')
      );
      process.stdout.write(`${lines.join('\n')}\n`);
    });
  });
}
