import type { Command } from 'commander';
import { addContextOptions, addJsonOption, addTeamOptions, addNoColorOption } from '../lib/command-helpers.js';
import { emit, getColor } from '../lib/output.js';
import { runStart, renderStartHuman } from '../lib/start.js';

interface StartFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  team?: string;
  reresolve?: boolean;
  primary?: string;
  assign?: boolean;
  json?: string | boolean;
  color: boolean;
}

/**
 * The daily entry point for beginning work: branch, transition state,
 * assign, and track one or more work items. See lib/start.ts for the
 * implementation — this file is just the commander wiring.
 */
export function registerStartCommand(program: Command): void {
  const cmd = program
    .command('start')
    .description('Begin work on one or more work items: branch, transition state, assign, and track them')
    .argument('<ids...>', 'work item id(s) to start work on')
    .option('--primary <id>', 'which id drives the branch name (default: the first)')
    .option('--assign', 'assign unassigned items to the current user (default: prompt)')
    .option('--no-assign', 'never assign items to the current user');

  addContextOptions(cmd);
  addTeamOptions(cmd);
  addJsonOption(cmd);
  addNoColorOption(cmd);

  cmd.action(async (ids: string[], opts: StartFlags) => {
    const color = getColor(opts.color === false);
    const result = await runStart({
      ids,
      primary: opts.primary,
      assign: opts.assign,
      org: opts.org,
      orgUrl: opts.orgUrl,
      project: opts.project,
      repo: opts.repo,
      team: opts.team,
      reresolve: opts.reresolve,
      json: opts.json,
      color,
    });

    await emit(result, opts, () => renderStartHuman(result, color));
  });
}
