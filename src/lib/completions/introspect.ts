import type { Command } from 'commander';

export interface CompletionOption {
  long?: string;
  short?: string;
  description: string;
  takesValue: boolean;
}

export interface CommandNode {
  name: string;
  description: string;
  options: CompletionOption[];
  subcommands: CommandNode[];
}

/**
 * Walks a live commander `Command` graph into a plain tree. This is the
 * single source of truth completions are generated from — there is no
 * separate, hand-maintained list of commands/flags to keep in sync.
 */
/**
 * commander registers `-h, --help` as a special-cased help option, not as
 * a regular entry in `cmd.options` — so it has to be added back in here
 * for completions to offer it like any other flag.
 */
const HELP_OPTION: CompletionOption = {
  long: '--help',
  short: '-h',
  description: 'display help for command',
  takesValue: false,
};

export function introspectCommand(cmd: Command): CommandNode {
  return {
    name: cmd.name(),
    description: cmd.description(),
    options: [
      ...cmd.options.map((opt) => ({
        long: opt.long,
        short: opt.short,
        description: opt.description,
        takesValue: opt.required || opt.optional,
      })),
      HELP_OPTION,
    ],
    subcommands: cmd.commands.map(introspectCommand),
  };
}
