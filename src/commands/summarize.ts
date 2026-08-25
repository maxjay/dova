import type { Command } from 'commander';
import { defaultRunner, runAzJson, tryGit, resolveOrFetchBranchRef, type Runner } from '../lib/exec.js';
import { resolveContext, resolveDefaultBranch, type ResolvedContext } from '../lib/context.js';
import { gitConfigGet } from '../lib/config.js';
import { fetchActivePrForBranch, fetchPrById } from '../lib/pr.js';
import { fetchWorkItemsByIds, fieldValue, workItemBody, type WorkItemBody } from '../lib/work-items.js';
import { parsePrUrl, parseIdArgument, looksLikeUrl } from '../lib/urls.js';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption } from '../lib/command-helpers.js';
import { emit, getColor } from '../lib/output.js';
import { UserError } from '../lib/errors.js';
import type { AzGitRepository, AzWorkItem } from '../types/azure-devops.js';

export interface SummarizeFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  base?: string;
  files?: string[];
  json?: string | boolean;
  jq?: string;
  color: boolean;
}

export interface SummarizeWorkItem {
  id: number;
  type: string | null;
  state: string | null;
  title: string | null;
  description: string | null;
  /** Description, acceptance criteria, repro steps — whichever the ticket has. */
  body: WorkItemBody[];
  primary: boolean;
}

export interface SummarizeCommit {
  sha: string;
  subject: string;
}

export type BaseSource = 'flag' | 'pr-target' | 'origin-head' | 'repo-default';

export interface SummarizeResult {
  branch: string;
  /** The ref actually diffed/logged against, e.g. "origin/main". */
  base: string;
  baseSource: BaseSource;
  workItems: SummarizeWorkItem[];
  commits: SummarizeCommit[];
  diffStat: string;
  /** The pathspecs the diff was restricted to, when it was restricted. */
  files?: string[];
  fullLog?: string;
  fullDiff?: string;
  /**
   * Work in the tree that isn't committed yet, and so isn't in `diffStat`
   * — which compares commits. Only present when summarizing the branch
   * currently checked out; there's no working tree to inspect for any
   * other branch, or for a PR.
   */
  uncommitted?: {
    stat: string;
    untracked: string[];
    patch?: string;
  };
}

const DESCRIPTION_TRUNCATE = 500;

function truncate(text: string, n: number): { shown: string; truncated: boolean } {
  if (text.length <= n) return { shown: text, truncated: false };
  return { shown: text.slice(0, n).trimEnd() + '…', truncated: true };
}

/**
 * What to diff/log the branch against: --base always wins; otherwise an
 * active PR's own target branch is the authoritative answer when one
 * exists; otherwise the repo's default branch, found for free from a
 * locally-known `origin/HEAD` symref first, falling back to one
 * `az repos show` call only if that's unset (a plain clone doesn't
 * always populate it).
 */
export async function resolveBase(
  runner: Runner,
  ctx: ResolvedContext,
  branch: string,
  flagBase: string | undefined,
  cwd: string | undefined
): Promise<{ ref: string; source: BaseSource }> {
  if (flagBase) return { ref: flagBase, source: 'flag' };

  if (ctx.repo) {
    const pr = await fetchActivePrForBranch(runner, ctx.orgUrl, ctx.project, ctx.repo, branch);
    if (pr) {
      return { ref: pr.targetRefName.replace(/^refs\/heads\//, ''), source: 'pr-target' };
    }
  }

  // Same resolution `dova pr create` targets, so a branch is diffed
  // against the branch its PR will actually merge into.
  const fromRepo = await resolveDefaultBranch(runner, ctx, cwd);
  if (fromRepo) {
    return { ref: fromRepo.branch, source: fromRepo.source };
  }

  throw new UserError(`Could not determine what to compare "${branch}" against.`, [
    'Pass --base <branch> explicitly.',
  ]);
}

/** Prefers the up-to-date remote-tracking ref over a possibly-stale local one. */
export async function resolveDiffableRef(runner: Runner, base: string, cwd: string | undefined): Promise<string> {
  const remote = `origin/${base}`;
  if (await tryGit(runner, ['rev-parse', '--verify', '--quiet', remote], { cwd })) return remote;
  if (await tryGit(runner, ['rev-parse', '--verify', '--quiet', base], { cwd })) return base;
  throw new UserError(`Neither "${remote}" nor "${base}" resolves to a ref dova can diff against.`, [
    'Pass --base <branch> explicitly, or fetch first.',
  ]);
}

function toSummarizeWorkItem(item: AzWorkItem, primaryId: number | undefined): SummarizeWorkItem {
  const body = workItemBody(item);
  return {
    id: item.id,
    type: fieldValue(item, 'System.WorkItemType'),
    state: fieldValue(item, 'System.State'),
    title: fieldValue(item, 'System.Title'),
    // Kept for compatibility; `body` is the one that carries acceptance
    // criteria and repro steps as well as the description.
    description: body.length > 0 ? body.map((s) => s.text).join('\n\n') : null,
    body,
    primary: item.id === primaryId,
  };
}

export interface GatherSummaryOptions {
  cwd?: string;
  full?: boolean;
  /**
   * git pathspecs to restrict the diff to. A 31-file branch's full patch
   * is thousands of lines — too much to read and too much to hand an
   * agent — so naming files is how you get actual content out of a large
   * change. Naming any implies the patch, not the stat: asking for a
   * file means asking what changed in it.
   */
  files?: string[];
}

/** `git diff <range> [-- path...]`, with the pathspec separator only when there are paths. */
function diffArgs(range: string, files: string[] | undefined, extra: string[] = []): string[] {
  const args = ['diff', ...extra, range];
  if (files && files.length > 0) args.push('--', ...files);
  return args;
}

/**
 * `dova summarize` — a catch-up report for a branch: why it exists (its
 * linked tickets' own descriptions), what's happened on it (the commit
 * log since it diverged from its base), and how big the change is (a
 * diff stat, not the full patch, by default — see `opts.full`).
 */
export async function gatherSummary(
  runner: Runner,
  branch: string,
  flags: { org?: string; orgUrl?: string; project?: string; repo?: string; base?: string },
  opts: GatherSummaryOptions = {}
): Promise<SummarizeResult> {
  const cwd = opts.cwd;

  // Fetches `branch` from origin first if it isn't already local — so
  // this works for a PR that was never checked out here, not just your
  // own already-local branches.
  const headRef = await resolveOrFetchBranchRef(runner, branch, cwd);

  const ctx = await resolveContext(runner, { org: flags.org, orgUrl: flags.orgUrl, project: flags.project, repo: flags.repo }, { cwd });

  const [trackedIdsRaw, primaryRaw] = await Promise.all([
    gitConfigGet(runner, `branch.${branch}.dova-workitems`, { cwd }),
    gitConfigGet(runner, `branch.${branch}.dova-primary`, { cwd }),
  ]);
  const ids = (trackedIdsRaw ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const primaryId = primaryRaw ? Number(primaryRaw) : ids[0];

  const [items, base] = await Promise.all([
    ids.length > 0
      ? fetchWorkItemsByIds(runner, ctx.orgUrl, ids, ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.Description'])
      : Promise.resolve([]),
    resolveBase(runner, ctx, branch, flags.base, cwd),
  ]);

  const diffable = await resolveDiffableRef(runner, base.ref, cwd);

  const logRaw = (await tryGit(runner, ['log', '--pretty=format:%H%x09%s', `${diffable}..${headRef}`], { cwd })) ?? '';
  const commits: SummarizeCommit[] = logRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\t');
      return { sha: sha ?? '', subject: subject ?? '' };
    });

  const range = `${diffable}...${headRef}`;
  // Naming files means wanting their content, so the patch comes back
  // whether or not --full was passed.
  const wantPatch = Boolean(opts.full) || (opts.files?.length ?? 0) > 0;

  const diffStat = (await tryGit(runner, diffArgs(range, opts.files, ['--stat']), { cwd })) ?? '';

  const result: SummarizeResult = {
    branch,
    base: diffable,
    baseSource: base.source,
    workItems: ids.map((id) => {
      const item = items.find((i) => i.id === id);
      return item
        ? toSummarizeWorkItem(item, primaryId)
        : { id, type: null, state: null, title: null, description: null, body: [], primary: id === primaryId };
    }),
    commits,
    diffStat,
  };
  if (opts.files?.length) result.files = opts.files;

  if (opts.full) {
    result.fullLog = (await tryGit(runner, ['log', `${diffable}..${headRef}`], { cwd })) ?? '';
  }
  if (wantPatch) {
    result.fullDiff = (await tryGit(runner, diffArgs(range, opts.files), { cwd })) ?? '';
  }

  // `diffStat` above compares commits, so anything still in the working
  // tree is invisible to it — which reads as "no changes" on a branch
  // you're actively working on. Report it, but separately: folding
  // uncommitted work into the branch's diff would misrepresent what's
  // actually on the branch. Only possible for the checked-out branch.
  const currentBranch = await tryGit(runner, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (currentBranch === branch) {
    // `diff HEAD` covers staged and unstaged together; untracked files
    // are invisible to git diff entirely, so they're listed separately.
    const [stat, untrackedRaw, patch] = await Promise.all([
      tryGit(runner, diffArgs('HEAD', opts.files, ['--stat']), { cwd }),
      tryGit(runner, ['ls-files', '--others', '--exclude-standard', ...(opts.files ?? [])], { cwd }),
      wantPatch ? tryGit(runner, diffArgs('HEAD', opts.files), { cwd }) : Promise.resolve(null),
    ]);
    const untracked = (untrackedRaw ?? '').split('\n').filter(Boolean);
    if (stat || untracked.length > 0) {
      result.uncommitted = { stat: stat ?? '', untracked };
      if (patch) result.uncommitted.patch = patch;
    }
  }

  return result;
}

function renderSummarizeHuman(result: SummarizeResult, full: boolean, color: ReturnType<typeof getColor>): void {
  const lines: string[] = [color.bold(`Branch: ${result.branch}`), color.dim(`compared against ${result.base}`), ''];

  if (result.workItems.length === 0) {
    lines.push(color.dim('(no linked work items — see `dova link`)'), '');
  } else {
    for (const wi of result.workItems) {
      const marker = wi.primary ? color.cyan(' (primary)') : '';
      lines.push(color.bold(`#${wi.id} [${wi.type ?? '?'}/${wi.state ?? '?'}] ${wi.title ?? '(no title)'}${marker}`));
      // Labelled per section: for a User Story the objective is in the
      // acceptance criteria, not the description, and running them
      // together would hide which is which.
      for (const section of wi.body) {
        lines.push(color.dim(`${section.label}:`));
        const { shown, truncated } = full ? { shown: section.text, truncated: false } : truncate(section.text, DESCRIPTION_TRUNCATE);
        lines.push(shown);
        if (truncated) lines.push(color.dim('  … pass --full for the rest'));
      }
      lines.push('');
    }
  }

  lines.push(color.bold(`Commits (${result.commits.length} since ${result.base})`));
  if (full && result.fullLog !== undefined) {
    lines.push(result.fullLog || color.dim('  (none)'));
  } else if (result.commits.length === 0) {
    lines.push(color.dim('  (none — branch has no commits ahead of the base)'));
  } else {
    for (const c of result.commits) lines.push(`  ${color.dim(c.sha.slice(0, 7))} ${c.subject}`);
  }
  lines.push('');

  const scope = result.files?.length ? color.dim(` — ${result.files.join(' ')}`) : '';
  lines.push(color.bold('Diff') + scope);
  // `fullDiff` is only populated when a patch was asked for — by --full,
  // or by naming files — so its presence is the condition, not `full`.
  if (result.fullDiff !== undefined) {
    lines.push(result.fullDiff || color.dim('  (no changes)'));
  } else {
    lines.push(result.diffStat.trim() || color.dim('  (no changes)'));
  }

  if (result.uncommitted) {
    lines.push('', color.bold('Uncommitted') + color.dim(' — in the working tree, not in the diff above'));
    if (result.uncommitted.patch !== undefined) {
      lines.push(result.uncommitted.patch);
    } else if (result.uncommitted.stat.trim()) {
      lines.push(result.uncommitted.stat.trim());
    }
    for (const file of result.uncommitted.untracked) {
      lines.push(`  ${color.green('?')} ${file}${color.dim(' (untracked)')}`);
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

export function registerSummarizeCommand(program: Command): void {
  const cmd = program
    .command('summarize [branch-or-id-or-url]')
    .description(
      "Catch up on a branch or a PR: linked tickets' descriptions, commit log, and diff shape since it diverged (default: current branch)"
    )
    .option('--base <ref>', 'compare against this branch instead of auto-detecting (PR target, then repo default)')
    .option('--full', 'show full commit messages and the full diff, not just the compact form')
    .option(
      '--files <paths...>',
      'show the actual patch for these paths only, instead of the file-count summary (directories work too)'
    );

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);

  cmd.action(async (arg: string | undefined, opts: SummarizeFlags & { full?: boolean }) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);

    const fromUrl = arg && looksLikeUrl(arg) ? parsePrUrl(arg) : null;
    if (arg && looksLikeUrl(arg) && !fromUrl) {
      throw new UserError(`"${arg}" looks like a URL, but not one dova recognizes as a pull request link.`);
    }
    const bareId = !arg || fromUrl ? null : parseIdArgument(arg);

    let branch: string;
    let flags: SummarizeFlags = opts;

    if (fromUrl || bareId !== null) {
      // A PR id or url — resolve it directly, then diff its own source
      // against its own target (unless --base overrides that), rather
      // than looking a branch's active PR back up.
      const ctx = await resolveContext(runner, {
        org: opts.org ?? fromUrl?.org,
        orgUrl: opts.orgUrl ?? fromUrl?.orgUrl,
        project: opts.project ?? fromUrl?.project,
        repo: opts.repo ?? fromUrl?.repo,
      });
      const pullRequest = await fetchPrById(runner, ctx.orgUrl, fromUrl?.id ?? bareId!);
      branch = pullRequest.sourceRefName.replace(/^refs\/heads\//, '');
      flags = {
        ...opts,
        org: ctx.org,
        orgUrl: ctx.orgUrl,
        project: ctx.project,
        repo: ctx.repo,
        base: opts.base ?? pullRequest.targetRefName.replace(/^refs\/heads\//, ''),
      };
    } else if (arg) {
      branch = arg;
    } else {
      const currentBranch = await tryGit(runner, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (!currentBranch || currentBranch === 'HEAD') {
        throw new UserError('Not currently on a branch (detached HEAD?).', [
          'Pass a branch name, PR id, or PR url explicitly.',
        ]);
      }
      branch = currentBranch;
    }

    const result = await gatherSummary(runner, branch, flags, { full: opts.full, files: opts.files });
    await emit(result, opts, () => renderSummarizeHuman(result, Boolean(opts.full), color));
  });
}
