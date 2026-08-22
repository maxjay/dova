import { select as inquirerSelect, confirm as inquirerConfirm } from '@inquirer/prompts';
import type { Runner } from './exec.js';
import { runAzJson } from './exec.js';
import { gitConfigGet, gitConfigSet, getCache, teamContextCacheKey } from './config.js';
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

export type ProjectSource = 'flag' | 'global-override' | 'repo-local' | 'context';

export interface ResolveProjectResult {
  project: string;
  source: ProjectSource;
}

/**
 * Resolution order: --project flag > `dova.project.override` (global) >
 * `dova.project` (repo-local) > the project already implied by context
 * resolution (git remote / az devops defaults).
 */
export async function resolveProject(
  runner: Runner,
  contextProject: string | undefined,
  flags: { project?: string } = {},
  opts: { cwd?: string } = {}
): Promise<ResolveProjectResult> {
  if (flags.project) return { project: flags.project, source: 'flag' };

  const globalOverride = await gitConfigGet(runner, 'dova.project.override', { global: true });
  if (globalOverride) return { project: globalOverride, source: 'global-override' };

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

export type TeamSource = 'flag' | 'global-override' | 'repo-local' | 'interactive';

export interface ResolveTeamResult {
  team: string;
  source: TeamSource;
}

export interface ResolveTeamOptions {
  cwd?: string;
  prompts?: TeamResolverPrompts;
  /** Skip the override/repo-local git config lookups and go straight to interactive resolution. */
  reresolve?: boolean;
}

/**
 * Resolution order: --team flag > `dova.team.override` (global) >
 * `dova.team` (repo-local) > interactive picker over `az devops team list`
 * (auto-selected when the project has exactly one team). On interactive
 * resolution, offers to save the pick to repo-local git config.
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
    const globalOverride = await gitConfigGet(runner, 'dova.team.override', { global: true });
    if (globalOverride) return { team: globalOverride, source: 'global-override' };

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
 * Iteration path resolution ("current sprint").
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
  let current: AzTeamIteration[];
  try {
    current = await runAzJson<AzTeamIteration[]>(runner, [
      'boards', 'iteration', 'team', 'list',
      '--organization', orgUrl,
      '--project', project,
      '--team', team,
      '--timeframe', 'current',
    ]);
  } catch (err) {
    // Defensive fallback for azure-devops extension versions old enough not
    // to support --timeframe (current versions do — verified against the
    // extension's boards/iteration.py, which passes timeframe straight
    // through to WorkClient.get_team_iterations).
    if (err instanceof Error && /unrecognized arguments.*--timeframe/i.test(err.message)) {
      current = await fetchCurrentIterationViaRest(runner, orgUrl, project, team);
    } else {
      throw err;
    }
  }

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

async function fetchCurrentIterationViaRest(
  runner: Runner,
  orgUrl: string,
  project: string,
  team: string
): Promise<AzTeamIteration[]> {
  const uri = `${orgUrl}/${encodeURIComponent(project)}/${encodeURIComponent(team)}/_apis/work/teamsettings/iterations?%24timeframe=current&api-version=7.1`;
  const result = await runAzJson<{ value: AzTeamIteration[] }>(runner, ['rest', '--method', 'get', '--uri', uri]);
  return result.value ?? [];
}

/* ------------------------------------------------------------------ *
 * Full team context: team + area + iteration, cached in dova's own
 * config dir (not git config — sprints roll over independent of branch).
 * ------------------------------------------------------------------ */

export interface ResolvedTeamContext {
  team: string;
  teamSource: TeamSource;
  areaPath: string;
  iterationPath: string;
  warnings: string[];
  fromCache: boolean;
}

export interface ResolveTeamContextOptions {
  cwd?: string;
  prompts?: TeamResolverPrompts;
  reresolve?: boolean;
}

export async function resolveTeamContext(
  runner: Runner,
  org: string,
  orgUrl: string,
  project: string,
  flags: { team?: string } = {},
  opts: ResolveTeamContextOptions = {}
): Promise<ResolvedTeamContext> {
  const teamResult = await resolveTeam(runner, orgUrl, project, flags, opts);
  const cache = getCache();
  const key = teamContextCacheKey(org, project, teamResult.team);

  if (!opts.reresolve) {
    const cached = cache.get('teamContext')[key];
    if (cached) {
      return {
        team: teamResult.team,
        teamSource: teamResult.source,
        areaPath: cached.areaPath,
        iterationPath: cached.iterationPath,
        warnings: cached.warning ? [cached.warning] : [],
        fromCache: true,
      };
    }
  }

  const prompts = opts.prompts ?? defaultPrompts;
  const [area, iteration] = [
    await resolveAreaPath(runner, orgUrl, project, teamResult.team, prompts),
    await resolveIterationPath(runner, orgUrl, project, teamResult.team),
  ];
  const warnings = [area.warning, iteration.warning].filter((w): w is string => Boolean(w));

  const all = cache.get('teamContext');
  cache.set('teamContext', {
    ...all,
    [key]: {
      org,
      project,
      team: teamResult.team,
      areaPath: area.areaPath,
      iterationPath: iteration.iterationPath,
      warning: warnings[0],
      resolvedAt: new Date().toISOString(),
    },
  });

  return {
    team: teamResult.team,
    teamSource: teamResult.source,
    areaPath: area.areaPath,
    iterationPath: iteration.iterationPath,
    warnings,
    fromCache: false,
  };
}
