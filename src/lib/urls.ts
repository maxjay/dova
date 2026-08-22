import { normalizeToUrl, resolveHostOrgSegments } from './context.js';

export interface ParsedWorkItemUrl {
  org: string;
  orgUrl: string;
  project: string;
  id: number;
}

export interface ParsedPrUrl {
  org: string;
  orgUrl: string;
  project: string;
  repo: string;
  id: number;
}

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** A bare positive integer id, e.g. from `dova wi view 123`. Returns null for anything else (including a URL). */
export function parseIdArgument(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const id = Number(trimmed);
  return id > 0 ? id : null;
}

/**
 * Parses a work item URL in either form Azure Boards hands out:
 *   - https://dev.azure.com/{org}/{project}/_workitems/edit/{id}   (what your browser's address bar shows)
 *   - https://dev.azure.com/{org}/{project}/_workitems?id={id}     (the form dova's own buildWiWebUrl generates)
 * and their {org}.visualstudio.com equivalents. Returns null for anything else.
 */
export function parseWorkItemUrl(raw: string): ParsedWorkItemUrl | null {
  const url = normalizeToUrl(raw);
  if (!url) return null;
  const info = resolveHostOrgSegments(url);
  if (!info) return null;

  const widx = info.rest.indexOf('_workitems');
  if (widx < 1) return null; // need at least one project segment before _workitems
  const project = info.rest.slice(0, widx).join('/');
  const after = info.rest.slice(widx + 1);

  if (after[0] === 'edit' && after[1]) {
    const id = Number(after[1]);
    if (Number.isInteger(id) && id > 0) {
      return { org: info.org, orgUrl: info.orgUrl, project, id };
    }
  }

  const idParam = url.searchParams.get('id');
  if (idParam) {
    const id = Number(idParam);
    if (Number.isInteger(id) && id > 0) {
      return { org: info.org, orgUrl: info.orgUrl, project, id };
    }
  }

  return null;
}

/**
 * Parses a pull request URL:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
 * and its {org}.visualstudio.com equivalent. Returns null for anything else.
 */
export function parsePrUrl(raw: string): ParsedPrUrl | null {
  const url = normalizeToUrl(raw);
  if (!url) return null;
  const info = resolveHostOrgSegments(url);
  if (!info) return null;

  const gitIdx = info.rest.indexOf('_git');
  if (gitIdx < 1) return null; // need at least one project segment before _git
  const project = info.rest.slice(0, gitIdx).join('/');
  const after = info.rest.slice(gitIdx + 1);
  const repo = after[0];
  if (!repo || after[1] !== 'pullrequest' || !after[2]) return null;
  const id = Number(after[2]);
  if (!Number.isInteger(id) || id <= 0) return null;

  return { org: info.org, orgUrl: info.orgUrl, project, repo, id };
}
