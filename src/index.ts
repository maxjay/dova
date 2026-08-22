import { CommanderError } from 'commander';
import { buildProgram } from './cli.js';
import { DovaError, ExitCode } from './lib/errors.js';
import { getColor, printError } from './lib/output.js';

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  // commander already prints --help / usage-error output itself when
  // exitOverride() is set; just adopt its exit code.
  if (err instanceof CommanderError) {
    process.exit(err.exitCode);
  }

  const noColor = process.argv.includes('--no-color');
  const color = getColor(noColor);
  printError(err, color);

  if (err instanceof DovaError) {
    process.exit(err.exitCode);
  }
  process.exit(ExitCode.Unexpected);
});
