import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import ini from 'ini';
import Conf from 'conf';
import type { Runner } from './exec.js';

/* ------------------------------------------------------------------ *
 * git config — the only place dova persists anything repo-specific.
 * Nothing here is ever written to a tracked file; it's all local git
 * config (repo-local `git config key value`, or `--global` for the
 * user's whole machine).
 * ------------------------------------------------------------------ */

export interface GitConfigScope {
  /** Read/write the user's global git config (~/.gitconfig) instead of the repo-local one. */
  global?: boolean;
  /** Repo to run `git config` in. Defaults to process.cwd(). */
  cwd?: string;
}

export async function gitConfigGet(
  runner: Runner,
  key: string,
  scope: GitConfigScope = {}
): Promise<string | null> {
  const args = ['config', ...(scope.global ? ['--global'] : []), '--get', key];
  const result = await runner.git(args, { cwd: scope.cwd });
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

export async function gitConfigSet(
  runner: Runner,
  key: string,
  value: string,
  scope: GitConfigScope = {}
): Promise<void> {
  const args = ['config', ...(scope.global ? ['--global'] : []), key, value];
  const result = await runner.git(args, { cwd: scope.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git config ${key} failed:\n${result.stderr.trim()}`);
  }
}

/** Is `cwd` (or process.cwd()) inside a git worktree at all? */
export async function isInsideGitRepo(runner: Runner, cwd?: string): Promise<boolean> {
  const result = await runner.git(['rev-parse', '--is-inside-work-tree'], { cwd });
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

/* ------------------------------------------------------------------ *
 * az devops CLI's own defaults file.
 *
 * `az devops configure --list` is NOT a source of structured data: in the
 * azure-devops-cli-extension source (dev/team/configure.py), the
 * `list_config` branch only calls `print()` for each config line and the
 * command function returns nothing — so `--output json` on it yields
 * `null`, not the defaults. The actual defaults live in a small INI file
 * that `az devops configure --defaults ...` writes to, at:
 *
 *   <az cli config dir>/azuredevops/config      (section: [defaults])
 *
 * where <az cli config dir> is $AZURE_CONFIG_DIR or ~/.azure, and the dir
 * itself can be overridden with $AZURE_DEVOPS_EXT_CONFIG_DIR. Reading this
 * file directly is more reliable than scraping `configure --list`'s stdout
 * text, and it's read-only from dova's side either way.
 * ------------------------------------------------------------------ */

export interface AzDevopsDefaults {
  organization?: string;
  project?: string;
}

export function azDevopsConfigFilePath(): string {
  const azConfigDir = process.env.AZURE_CONFIG_DIR || path.join(os.homedir(), '.azure');
  const devopsConfigDir = process.env.AZURE_DEVOPS_EXT_CONFIG_DIR || path.join(azConfigDir, 'azuredevops');
  return path.join(devopsConfigDir, 'config');
}

export function readAzDevopsDefaults(configFilePath: string = azDevopsConfigFilePath()): AzDevopsDefaults {
  let raw: string;
  try {
    raw = fs.readFileSync(configFilePath, 'utf8');
  } catch {
    return {};
  }
  const parsed = ini.parse(raw) as Record<string, Record<string, string> | undefined>;
  const defaults = parsed.defaults ?? {};
  return {
    organization: defaults.organization || undefined,
    project: defaults.project || undefined,
  };
}

/* ------------------------------------------------------------------ *
 * dova's own config/cache dir — NOT git config, since this isn't
 * per-branch or per-repo. Uses the standard per-OS location:
 * XDG on Linux, Application Support on macOS, AppData on Windows
 * (that's what the `conf` package resolves internally).
 * ------------------------------------------------------------------ */

export interface CachedTeamContext {
  org: string;
  project: string;
  team: string;
  areaPath: string;
  iterationPath: string;
  /** Warning surfaced when resolution fell back (e.g. Kanban team, no default area). */
  warning?: string;
  resolvedAt: string; // ISO timestamp
}

export interface DovaCacheSchema {
  teamContext: Record<string, CachedTeamContext>;
}

let cacheInstance: Conf<DovaCacheSchema> | null = null;

/** Lazily-constructed singleton so tests can override via `setCacheInstance`. */
export function getCache(): Conf<DovaCacheSchema> {
  if (!cacheInstance) {
    cacheInstance = new Conf<DovaCacheSchema>({
      projectName: 'dova',
      configName: 'cache',
      defaults: { teamContext: {} },
    });
  }
  return cacheInstance;
}

export function setCacheInstance(conf: Conf<DovaCacheSchema> | null): void {
  cacheInstance = conf;
}

export function teamContextCacheKey(org: string, project: string, team: string): string {
  return `${org}::${project}::${team}`;
}
