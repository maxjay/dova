import type { Runner } from './exec.js';
import { tryGit, runGit } from './exec.js';
import { isInsideGitRepo, readAzDevopsDefaults } from './config.js';
import { UserError } from './errors.js';

export interface AzureRepoRemote {
  org: string;
  project: string;
  repo: string;
  /** Base org URL to build browser links / REST calls from, e.g. https://dev.azure.com/contoso */
  orgUrl: string;
}

export interface ParsedOrgUrl {
  org: string;
  orgUrl: string;
}

/**
 * Turns `git@host:path` (scp-like syntax, used by SSH remotes) into a real
 * URL so the rest of the parser can use `URL` uniformly for both HTTPS and
 * SSH remotes.
 */
export function normalizeToUrl(remote: string): URL | null {
  let s = remote.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) && /^[^@/\s]+@[^:/\s]+:.+$/.test(s)) {
    const m = s.match(/^([^@]+)@([^:]+):(.+)$/);
    if (m) {
      s = `ssh://${m[1]}@${m[2]}/${m[3]}`;
    }
  }
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function stripGitSuffix(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -4) : name;
}

export function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
}

export interface HostOrgSegments {
  org: string;
  orgUrl: string;
  /** Path segments after the org. */
  rest: string[];
}

/**
 * Shared org/host detection for any full Azure DevOps resource URL (not
 * just a git remote) — used by lib/urls.ts to parse work item and PR
 * links. dova only recognizes dev.azure.com.
 */
export function resolveHostOrgSegments(url: URL): HostOrgSegments | null {
  const host = url.hostname.toLowerCase();
  const segments = pathSegments(url);

  if (host === 'dev.azure.com') {
    const org = segments[0];
    if (!org) return null;
    return { org, orgUrl: `https://dev.azure.com/${org}`, rest: segments.slice(1) };
  }

  return null;
}

/**
 * Parses an org base URL (as stored by `az devops configure --defaults
 * organization=...`) into its short org name plus a normalized URL.
 */
export function parseOrgUrl(raw: string): ParsedOrgUrl | null {
  const url = normalizeToUrl(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();

  if (host === 'dev.azure.com') {
    const org = pathSegments(url)[0];
    if (!org) return null;
    return { org, orgUrl: `https://dev.azure.com/${org}` };
  }

  return null;
}

/**
 * Parses a git remote URL for an Azure Repos repo, in either form
 * dev.azure.com hands out:
 *   - https://dev.azure.com/{org}/{project}/_git/{repo}
 *   - git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 * Returns null for anything else (e.g. a GitHub remote) rather than guessing.
 */
export function parseAzureRepoRemoteUrl(remoteUrl: string): AzureRepoRemote | null {
  const url = normalizeToUrl(remoteUrl);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const segments = pathSegments(url);

  if (host === 'dev.azure.com') {
    const gitIdx = segments.indexOf('_git');
    if (gitIdx >= 1 && segments.length > gitIdx + 1) {
      const org = segments[0]!;
      const project = segments.slice(1, gitIdx).join('/');
      const repo = stripGitSuffix(segments[gitIdx + 1]!);
      return { org, project, repo, orgUrl: `https://dev.azure.com/${org}` };
    }
    return null;
  }

  if (host === 'ssh.dev.azure.com') {
    if (segments[0] === 'v3' && segments.length >= 4) {
      const org = segments[1]!;
      const project = segments[2]!;
      const repo = stripGitSuffix(segments[3]!);
      return { org, project, repo, orgUrl: `https://dev.azure.com/${org}` };
    }
    return null;
  }

  return null;
}

export interface ContextFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
}

export type ContextSource = 'flags' | 'git-remote' | 'az-devops-defaults';

export interface ResolvedContext {
  org: string;
  project: string;
  /** Undefined when context came only from az devops defaults (no repo in play). */
  repo?: string;
  orgUrl: string;
  /** Current branch, when resolved from inside a git repo. */
  branch?: string;
  source: ContextSource;
}

export interface ResolveContextOptions {
  cwd?: string;
  /** Which git remote to read (default "origin"). */
  remoteName?: string;
}

/**
 * Resolution order (per dova's design):
 *   1. Explicit flags always win, field by field.
 *   2. `git remote get-url origin`, parsed for org/project/repo, when inside a repo.
 *   3. `az devops configure` defaults (org + project only — no repo).
 *   4. Throw a specific, actionable error. Never silently guess.
 */
export async function resolveContext(
  runner: Runner,
  flags: ContextFlags = {},
  opts: ResolveContextOptions = {}
): Promise<ResolvedContext> {
  // Flags alone already fully resolve org+project — that's a complete
  // answer on its own, so it wins outright without even looking at git or
  // az devops defaults (also skips shelling out to either, for free).
  if (flags.org && flags.project) {
    return {
      org: flags.org,
      project: flags.project,
      repo: flags.repo,
      orgUrl: flags.orgUrl ?? `https://dev.azure.com/${flags.org}`,
      source: 'flags',
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const remoteName = opts.remoteName ?? 'origin';

  if (await isInsideGitRepo(runner, cwd)) {
    const remoteUrl = await tryGit(runner, ['remote', 'get-url', remoteName], { cwd });
    if (remoteUrl) {
      const parsed = parseAzureRepoRemoteUrl(remoteUrl);
      if (parsed) {
        const branch = await tryGit(runner, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
        return {
          org: flags.org ?? parsed.org,
          project: flags.project ?? parsed.project,
          repo: flags.repo ?? parsed.repo,
          orgUrl: flags.orgUrl ?? parsed.orgUrl,
          branch: branch && branch !== 'HEAD' ? branch : undefined,
          source: 'git-remote',
        };
      }
    }
  }

  const azDefaults = readAzDevopsDefaults();
  const parsedOrg = azDefaults.organization ? parseOrgUrl(azDefaults.organization) : null;
  const org = flags.org ?? parsedOrg?.org;
  const project = flags.project ?? azDefaults.project;
  if (org && project) {
    return {
      org,
      project,
      repo: flags.repo,
      orgUrl: flags.orgUrl ?? parsedOrg?.orgUrl ?? `https://dev.azure.com/${org}`,
      source: 'az-devops-defaults',
    };
  }

  throw new UserError('Could not determine an Azure DevOps organization/project.', [
    'Run this inside a git repo cloned from Azure Repos, or pass --org and --project explicitly.',
    'Or set a default with: az devops configure --defaults organization=<org-url> project=<project-name>',
  ]);
}

/** The branch dova is running against, for commands that need it outside resolveContext (e.g. after a checkout). */
export async function currentBranch(runner: Runner, cwd?: string): Promise<string | null> {
  const branch = await tryGit(runner, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return branch && branch !== 'HEAD' ? branch : null;
}

/** Builds the web URL for a repo's PR list / a specific PR, given a resolved context. */
export function buildPrWebUrl(ctx: Pick<ResolvedContext, 'orgUrl' | 'project' | 'repo'>, prId?: number): string {
  if (!ctx.repo) {
    throw new UserError('No repo in context — cannot build a pull request URL.');
  }
  const base = `${ctx.orgUrl}/${encodeURIComponent(ctx.project)}/_git/${encodeURIComponent(ctx.repo)}/pullrequest`;
  return prId ? `${base}/${prId}` : base;
}

export { runGit };
