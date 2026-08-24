import type { Command } from 'commander';
import { defaultRunner, tryGit } from '../lib/exec.js';
import { addJsonOption, addJqOption, addNoColorOption } from '../lib/command-helpers.js';
import { emit, getColor } from '../lib/output.js';
import { runInstructionsInstall, TARGETS } from '../lib/instructions-install.js';
import { UserError } from '../lib/errors.js';

interface InstructionsInitFlags {
  repo?: boolean;
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
    .description('Set up coding agents (Devin Desktop/Windsurf, GitHub Copilot) to use dova correctly');

  const init = instructions
    .command('init')
    .description("Write dova's usage rules where your coding agents will read them (default: globally, for every repo)")
    .option(
      '--repo',
      `install into this repo instead, as ${TARGETS.map((t) => t.file).join(' and ')} — commit them so teammates get them too`
    )
    .option('--dry-run', 'report what would be written without writing anything');

  addJsonOption(init);
  addJqOption(init);
  addNoColorOption(init);

  init.action(async (opts: InstructionsInitFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);

    let root: string | undefined;
    if (opts.repo) {
      // Repo-scoped files are only read from the repo root, so writing
      // them into a subdirectory would look installed and never load.
      root = (await tryGit(runner, ['rev-parse', '--show-toplevel'])) ?? undefined;
      if (!root) {
        throw new UserError('`dova instructions init --repo` needs to run inside a git repository.', [
          'AGENTS.md and .github/copilot-instructions.md are only read from the repo root.',
          'Drop --repo to install globally instead, which works from anywhere.',
        ]);
      }
    }

    const result = runInstructionsInstall({
      scope: opts.repo ? 'repo' : 'global',
      root,
      dryRun: opts.dryRun,
    });

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
        color.dim(
          result.scope === 'repo'
            ? 'Commit these so everyone on the repo gets them. Re-run after upgrading dova to refresh the block.'
            : 'These apply in every repo on this machine. Re-run after upgrading dova to refresh them, or use --repo to commit them into a repo for your teammates.'
        )
      );
      process.stdout.write(`${lines.join('\n')}\n`);
    });
  });
}
