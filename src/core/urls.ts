/* ------------------------------------------------------------------ *
 * Azure DevOps URLs: the web links dova prints, and the links and git
 * remotes it accepts as input.
 * ------------------------------------------------------------------ */

export function orgUrlFor(org: string): string {
  return `https://dev.azure.com/${org}`;
}

const enc = encodeURIComponent;

export const webUrl = {
  workItem: (orgUrl: string, project: string, id: number) => `${orgUrl}/${enc(project)}/_workitems/edit/${id}`,
  pullRequest: (orgUrl: string, project: string, repo: string, id: number) => `${orgUrl}/${enc(project)}/_git/${enc(repo)}/pullrequest/${id}`,
  run: (orgUrl: string, project: string, id: number) => `${orgUrl}/${enc(project)}/_build/results?buildId=${id}`,
};

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** A bare positive integer, optionally written `#123`. Null for anything else. */
export function parseId(value: string): number | null {
  const trimmed = value.trim().replace(/^#/, '');
  if (!/^\d+$/.test(trimmed)) return null;
  const id = Number(trimmed);
  return id > 0 ? id : null;
}

interface OrgPath {
  org: string;
  /** Path segments after the org (and after DefaultCollection on visualstudio.com). */
  rest: string[];
}

/** `git@host:path` (scp-style SSH) → a URL, so every remote form parses the same way. */
function toUrl(raw: string): URL | null {
  let s = raw.trim();
  const scp = !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && s.match(/^([^@/\s]+)@([^:/\s]+):(.+)$/);
  if (scp) s = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`;
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function orgPath(url: URL): OrgPath | null {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (host === 'dev.azure.com') {
    return segments[0] ? { org: segments[0], rest: segments.slice(1) } : null;
  }
  if (host === 'ssh.dev.azure.com') {
    // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
    return segments[0] === 'v3' && segments[1] ? { org: segments[1], rest: segments.slice(2) } : null;
  }
  if (host.endsWith('.visualstudio.com')) {
    const org = host.slice(0, -'.visualstudio.com'.length);
    if (!org || org.includes('.')) return null;
    const rest = segments[0]?.toLowerCase() === 'defaultcollection' ? segments.slice(1) : segments;
    return { org, rest };
  }
  return null;
}

export interface RemoteRepo {
  org: string;
  project: string;
  repo: string;
}

/**
 * An Azure Repos git remote, in any form Azure DevOps hands out:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
 *   git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 * Null for anything else (a GitHub remote, say).
 */
export function parseRemote(raw: string): RemoteRepo | null {
  const url = toUrl(raw);
  if (!url) return null;
  const info = orgPath(url);
  if (!info) return null;
  const strip = (name: string) => name.replace(/\.git$/, '');

  if (url.hostname.toLowerCase() === 'ssh.dev.azure.com') {
    const [project, repo] = info.rest;
    return project && repo ? { org: info.org, project, repo: strip(repo) } : null;
  }
  const git = info.rest.indexOf('_git');
  const repo = info.rest[git + 1];
  if (git < 1 || !repo) return null;
  return { org: info.org, project: info.rest.slice(0, git).join('/'), repo: strip(repo) };
}

export interface WorkItemLink {
  org: string;
  project: string;
  id: number;
}

/** `.../{project}/_workitems/edit/{id}` or `.../{project}/_workitems?id={id}`. */
export function parseWorkItemLink(raw: string): WorkItemLink | null {
  const url = toUrl(raw);
  const info = url && orgPath(url);
  if (!url || !info) return null;
  const at = info.rest.indexOf('_workitems');
  if (at < 1) return null;
  const project = info.rest.slice(0, at).join('/');
  const after = info.rest.slice(at + 1);
  const id = parseId(after[0] === 'edit' && after[1] ? after[1] : url.searchParams.get('id') ?? '');
  return id ? { org: info.org, project, id } : null;
}

export interface PullRequestLink extends WorkItemLink {
  repo: string;
}

/** `.../{project}/_git/{repo}/pullrequest/{id}`. */
export function parsePullRequestLink(raw: string): PullRequestLink | null {
  const url = toUrl(raw);
  const info = url && orgPath(url);
  if (!info) return null;
  const git = info.rest.indexOf('_git');
  if (git < 1) return null;
  const [repo, kind, idText] = info.rest.slice(git + 1);
  const id = kind === 'pullrequest' && idText ? parseId(idText) : null;
  return repo && id ? { org: info.org, project: info.rest.slice(0, git).join('/'), repo, id } : null;
}
