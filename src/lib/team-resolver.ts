import { select as inquirerSelect, confirm as inquirerConfirm } from '@inquirer/prompts';
import type { Runner } from './exec.js';
import { runAzJson } from './exec.js';
import { gitConfigGet, gitConfigSet } from './config.js';
import { fetchWorkItem, fieldValue } from './work-items.js';
import { NotFoundError, UserError } from './errors.js';

/* ------------------------------------------------------------------ *
 * az output shapes.
 *
 * Verified against the azure-devops-cli-extension source (not just the
 * docs, since `az boards area team list`'s JSON shape isn't spelled out
 * on learn.microsoft.com):
 *   - `az devops team list`            -> core_client.get_teams(...)          -> WebApiTeam[]
 *   - `az boards area team list`       -> work_client.get_team_field_values() -> TeamFieldValues (one object, not a list!)
 *   - `az boards iteration team list`  -> work_client.get_team_iterations()   -> TeamSettingsIteration[]
 * ------------------------------------------------------------------ */

export interface AzTeam {
  id: string;
  name: string;
  description?: string;
  url: string;
  projectName?: string;
  projectId?: string;
}

export interface AzTeamFieldValues {
  field?: { referenceName: string; url: string };
  defaultValue: string;
  values: Array<{ value: string; includeChildren: boolean }>;
}

export interface AzTeamIteration {
  id: string;
  name: string;
  path: string;
  attributes?: { startDate?: string; finishDate?: string; timeFrame?: string };
  url: string;
}

/* ------------------------------------------------------------------ *
 * Prompt seam — real interactive prompts by default, injectable so
 * tests can drive the resolver without a TTY.
 * ------------------------------------------------------------------ */

export interface TeamResolverPrompts {
  select(config: { message: string; choices: Array<{ name: string; value: string }> }): Promise<string>;
  confirm(config: { message: string; default?: boolean }): Promise<boolean>;
}

export const defaultPrompts: TeamResolverPrompts = {
  select: (config) => inquirerSelect(config),
  confirm: (config) => inquirerConfirm(config),
};

/* ------------------------------------------------------------------ *
 * Project resolution.
 * ------------------------------------------------------------------ */

export type ProjectSource = 'flag' | 'repo-local' | 'context';

export interface ResolveProjectResult {
  project: string;
  source: ProjectSource;
}

/**
 * Resolution order: --project flag > `dova.project` (repo-local) > the
 * project already implied by context resolution (git remote / az devops
 * defaults).
 */
export async function resolveProject(
  runner: Runner,
  contextProject: string | undefined,
  flags: { project?: string } = {},
  opts: { cwd?: string } = {}
): Promise<ResolveProjectResult> {
  if (flags.project) return { project: flags.project, source: 'flag' };

  const repoLocal = await gitConfigGet(runner, 'dova.project', { cwd: opts.cwd });
  if (repoLocal) return { project: repoLocal, source: 'repo-local' };

  if (contextProject) return { project: contextProject, source: 'context' };

  throw new UserError('Could not determine an Azure DevOps project.', [
    'Pass --project explicitly, or run this inside a repo whose remote resolves one.',
  ]);
}

/* ------------------------------------------------------------------ *
 * Team resolution.
 * ------------------------------------------------------------------ */

export type TeamSource = 'flag' | 'repo-local' | 'interactive';

export interface ResolveTeamResult {
  team: string;
  source: TeamSource;
}

export interface ResolveTeamOptions {
  cwd?: string;
  prompts?: TeamResolverPrompts;
  /** Skip the repo-local git config lookup and go straight to interactive resolution. */
  reresolve?: boolean;
}

/**
 * Resolution order: --team flag > `dova.team` (repo-local) > interactive
 * picker over `az devops team list` (auto-selected when the project has
 * exactly one team). On interactive resolution, offers to save the pick
 * to repo-local git config.
 */
export async function resolveTeam(
  runner: Runner,
  orgUrl: string,
  project: string,
  flags: { team?: string } = {},
  opts: ResolveTeamOptions = {}
): Promise<ResolveTeamResult> {
  const prompts = opts.prompts ?? defaultPrompts;

  if (flags.team) {
    return { team: flags.team, source: 'flag' };
  }

  if (!opts.reresolve) {
    const repoLocal = await gitConfigGet(runner, 'dova.team', { cwd: opts.cwd });
    if (repoLocal) return { team: repoLocal, source: 'repo-local' };
  }

  const teams = await runAzJson<AzTeam[]>(runner, [
    'devops', 'team', 'list',
    '--organization', orgUrl,
    '--project', project,
  ]);
  if (!teams.length) {
    throw new NotFoundError(`Project "${project}" has no teams.`);
  }

  let chosen: string;
  if (teams.length === 1) {
    chosen = teams[0]!.name;
  } else {
    chosen = await prompts.select({
      message: `Multiple teams in "${project}" — which one?`,
      choices: teams.map((t) => ({ name: t.name, value: t.name })),
    });
  }

  const save = await prompts.confirm({
    message: 'Save this to git config for next time?',
    default: true,
  });
  if (save) {
    await gitConfigSet(runner, 'dova.team', chosen, { cwd: opts.cwd });
  }

  return { team: chosen, source: 'interactive' };
}

/* ------------------------------------------------------------------ *
 * Area path resolution.
 * ------------------------------------------------------------------ */

export interface ResolvedAreaPath {
  areaPath: string;
  warning?: string;
}

export async function resolveAreaPath(
  runner: Runner,
  orgUrl: string,
  project: string,
  team: string,
  prompts: TeamResolverPrompts = defaultPrompts
): Promise<ResolvedAreaPath> {
  const data = await runAzJson<AzTeamFieldValues>(runner, [
    'boards', 'area', 'team', 'list',
    '--organization', orgUrl,
    '--project', project,
    '--team', team,
  ]);

  if (data.defaultValue) {
    return { areaPath: data.defaultValue };
  }

  const values = data.values ?? [];
  if (values.length === 0) {
    throw new NotFoundError(`Team "${team}" has no area paths configured.`);
  }
  if (values.length === 1) {
    return {
      areaPath: values[0]!.value,
      warning: `No default area path is set for team "${team}"; using its only assigned area path.`,
    };
  }

  const choice = await prompts.select({
    message: `No default area path is set for team "${team}". Pick one:`,
    choices: values.map((v) => ({ name: v.value, value: v.value })),
  });
  return { areaPath: choice };
}

/* ------------------------------------------------------------------ *
 * Iteration path resolution ("current sprint"). dova only ever targets
 * dev.azure.com, and the extension version that runs against it supports
 * `--timeframe` (confirmed from source) — so this is one az call, no
 * fallback for older extension versions that don't exist here.
 * ------------------------------------------------------------------ */

export interface ResolvedIterationPath {
  iterationPath: string;
  warning?: string;
}

export async function resolveIterationPath(
  runner: Runner,
  orgUrl: string,
  project: string,
  team: string
): Promise<ResolvedIterationPath> {
  const current = await runAzJson<AzTeamIteration[]>(runner, [
    'boards', 'iteration', 'team', 'list',
    '--organization', orgUrl,
    '--project', project,
    '--team', team,
    '--timeframe', 'current',
  ]);

  const iteration = current[0];
  if (iteration?.path) {
    return { iterationPath: iteration.path };
  }

  // Kanban-only teams (and teams between sprints) have no "current"
  // iteration. The project's root iteration path is always the project
  // name itself, so this needs no extra az call to compute.
  return {
    iterationPath: project,
    warning: `Team "${team}" has no current sprint (Kanban-only team, or between sprints); falling back to the project's root iteration ("${project}").`,
  };
}

/* ------------------------------------------------------------------ *
 * Create-context resolution: what --area/--iteration a *new* work item
 * should get. Team is only ever a means to that pair (`az boards
 * work-item create` takes --area/--iteration, not --team), so once
 * they're known there's nothing left to resolve or ask about a team
 * name for — and everything durable here lives in one place, repo-local
 * git config, same as `dova.team`/`dova.project`. No separate cache
 * dir: a repo only ever has one team's worth of tickets in it, so
 * caching by team (rather than just by repo) bought nothing real.
 * ------------------------------------------------------------------ */

export type CreateContextSource = 'like' | 'repo-local-area' | 'team';

export interface ResolvedCreateContext {
  /** null when area/iteration came from --like or a saved repo-local override — no team was ever resolved. */
  team: string | null;
  areaPath: string;
  iterationPath: string;
  warnings: string[];
  fromCache: boolean;
  source: CreateContextSource;
}

export interface ResolveCreateContextOptions {
  cwd?: string;
  prompts?: TeamResolverPrompts;
  reresolve?: boolean;
  /** Work item id to copy area/iteration path from directly, bypassing team resolution entirely. */
  like?: string;
  /** Persist the --like ticket's area/iteration as this repo's default (requires `like`). */
  save?: boolean;
}

/**
 * Resolution order: `--like <id>` or `--team <name>` (both explicit,
 * one-off overrides — `--like` copies area/iteration straight off an
 * existing work item, one `boards work-item show` call, no team
 * involved; `--team` skips straight to `resolveAreaPath()`/
 * `resolveIterationPath()` for that team) > saved `dova.area`+
 * `dova.iteration` repo-local git config > `resolveTeam()`'s normal
 * fallback (repo-local `dova.team`, or an interactive pick) followed by
 * the same area/iteration resolution.
 *
 * A fresh team-based resolution is saved to `dova.area`/`dova.iteration`
 * afterward — but only when the team itself came from something durable
 * (repo-local config, or a pick the user just confirmed saving), never
 * from the one-off `--team` flag. That mirrors `--like` without
 * `--save`: an explicit override for this one call shouldn't silently
 * become the repo's new default.
 */
export async function resolveCreateContext(
  runner: Runner,
  orgUrl: string,
  project: string,
  flags: { team?: string } = {},
  opts: ResolveCreateContextOptions = {}
): Promise<ResolvedCreateContext> {
  if (opts.save && !opts.like) {
    throw new UserError('--save only makes sense together with --like.', [
      "Pass --like <id> --save to persist that ticket's area/iteration as this repo's default.",
    ]);
  }
  if (opts.like && flags.team) {
    throw new UserError('--like and --team are mutually exclusive.', [
      '--like copies area/iteration straight from an existing ticket; --team resolves them from a team name. Use one or the other.',
    ]);
  }

  if (opts.like) {
    const exampleId = Number(opts.like);
    if (!Number.isInteger(exampleId) || exampleId <= 0) {
      throw new UserError(`"${opts.like}" is not a valid work item id.`);
    }
    const example = await fetchWorkItem(runner, orgUrl, exampleId);
    const areaPath = fieldValue(example, 'System.AreaPath');
    const iterationPath = fieldValue(example, 'System.IterationPath');
    if (!areaPath || !iterationPath) {
      throw new NotFoundError(`Work item #${exampleId} has no area/iteration path to copy.`);
    }
    if (opts.save) {
      await gitConfigSet(runner, 'dova.area', areaPath, { cwd: opts.cwd });
      await gitConfigSet(runner, 'dova.iteration', iterationPath, { cwd: opts.cwd });
    }
    return { team: null, areaPath, iterationPath, warnings: [], fromCache: false, source: 'like' };
  }

  // --team is an explicit ad-hoc override too, same standing as --like —
  // it must reach team-based resolution below rather than being silently
  // shadowed by whatever's already saved for this repo.
  if (!opts.reresolve && !flags.team) {
    const [savedArea, savedIteration] = await Promise.all([
      gitConfigGet(runner, 'dova.area', { cwd: opts.cwd }),
      gitConfigGet(runner, 'dova.iteration', { cwd: opts.cwd }),
    ]);
    if (savedArea && savedIteration) {
      return { team: null, areaPath: savedArea, iterationPath: savedIteration, warnings: [], fromCache: true, source: 'repo-local-area' };
    }
  }

  const prompts = opts.prompts ?? defaultPrompts;
  const teamResult = await resolveTeam(runner, orgUrl, project, flags, opts);
  const area = await resolveAreaPath(runner, orgUrl, project, teamResult.team, prompts);
  const iteration = await resolveIterationPath(runner, orgUrl, project, teamResult.team);
  const warnings = [area.warning, iteration.warning].filter((w): w is string => Boolean(w));

  if (teamResult.source !== 'flag') {
    await gitConfigSet(runner, 'dova.area', area.areaPath, { cwd: opts.cwd });
    await gitConfigSet(runner, 'dova.iteration', iteration.iterationPath, { cwd: opts.cwd });
  }

  return {
    team: teamResult.team,
    areaPath: area.areaPath,
    iterationPath: iteration.iterationPath,
    warnings,
    fromCache: false,
    source: 'team',
  };
}
