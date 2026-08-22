import type { Command } from 'commander';
import { introspectCommand } from '../lib/completions/introspect.js';
import { generateBashCompletion } from '../lib/completions/bash.js';
import { generateZshCompletion } from '../lib/completions/zsh.js';
import { generateFishCompletion } from '../lib/completions/fish.js';
import { generatePowerShellCompletion } from '../lib/completions/powershell.js';
import { UserError } from '../lib/errors.js';

const GENERATORS = {
  bash: generateBashCompletion,
  zsh: generateZshCompletion,
  fish: generateFishCompletion,
  powershell: generatePowerShellCompletion,
} as const;

type Shell = keyof typeof GENERATORS;

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion <shell>')
    .description(`Generate shell completion script (${Object.keys(GENERATORS).join('|')}), from the live command tree`)
    .action((shell: string) => {
      if (!(shell in GENERATORS)) {
        throw new UserError(`Unknown shell "${shell}".`, [`Supported: ${Object.keys(GENERATORS).join(', ')}`]);
      }
      const root = introspectCommand(program);
      const generate = GENERATORS[shell as Shell];
      process.stdout.write(generate(root));
    });
}
