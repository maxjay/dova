import type { Command } from 'commander';
import { UserError } from './errors.js';

/** --org / --org-url / --project / --repo — the flags that win over context resolution. */
export function addContextOptions(cmd: Command): Command {
  return cmd
    .option('--org <org>', 'Azure DevOps organization name (overrides context resolution)')
    .option('--org-url <url>', 'Azure DevOps organization URL, e.g. https://dev.azure.com/contoso')
    .option('--project <project>', 'Azure DevOps project name (overrides context resolution)')
    .option('--repo <repo>', 'Azure Repos repository name (overrides context resolution)');
}

/** --team / --like / --save / --reresolve — for commands that need team-level (area/iteration) resolution. */
export function addTeamOptions(cmd: Command): Command {
  return cmd
    .option('--team <team>', 'team name (overrides team resolution)')
    .option('--like <id>', 'copy area/iteration from an existing work item instead of resolving a team')
    .option('--save', "--like only: persist that area/iteration as this repo's default")
    .option('--reresolve', 'ignore cached/saved team & area/iteration resolution and re-resolve');
}

/**
 * `--json [fields]`, mirroring gh: a bare `--json` means "all fields",
 * `--json a,b` restricts to those. Commander gives us `true` for the bare
 * form and a string for the value form — see lib/output.ts's `emit()`.
 */
export function addJsonOption(cmd: Command, description = 'output JSON, optionally restricted to a comma-separated field list'): Command {
  return cmd.option('--json [fields]', description);
}

/** `--jq <expr>` — requires --json; enforced in lib/output.ts's `emit()`. */
export function addJqOption(cmd: Command): Command {
  return cmd.option('--jq <expression>', 'filter --json output through a jq expression');
}

/** `--web` — opens the resolved resource's URL in the browser instead of printing. */
export function addWebOption(cmd: Command): Command {
  return cmd.option('-w, --web', 'open in the browser instead of printing');
}

/** `--no-color` on every command, in addition to $NO_COLOR — see lib/output.ts's `getColor()`. */
export function addNoColorOption(cmd: Command): Command {
  return cmd.option('--no-color', 'disable colored output (also respects $NO_COLOR)');
}

/** Everything a typical read command needs: context + json/jq + web + color. */
export function addReadCommandOptions(cmd: Command, opts: { web?: boolean } = { web: true }): Command {
  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);
  if (opts.web) addWebOption(cmd);
  return cmd;
}

/** Shared placeholder for commands whose surface is scaffolded but not yet implemented. */
export function notImplemented(commandPath: string): never {
  throw new UserError(`"${commandPath}" is not implemented yet.`, [
    'This command is scaffolded (see --help) but v1 has not wired up its logic yet.',
  ]);
}
