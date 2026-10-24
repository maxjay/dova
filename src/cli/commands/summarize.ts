import type { App } from '../../app.js';
import { truncate } from '../../core/text.js';
import type { BodySection } from '../../core/types.js';
import { looksLikeUrl, parseId } from '../../core/urls.js';
import { UserError } from '../../errors.js';
import { command } from '../framework.js';
import { findPullRequest } from './pr.js';

interface Flags {
  base?: string;
  full?: boolean;
  files?: string[];
}

export interface Summary {
  branch: string;
  /** What it's compared against, and why that. */
  base: string;
  baseSource: 'flag' | 'pr-target' | 'origin-head' | 'repo-default';
  workItems: Array<{ id: number; title: string | null; type: string | null; state: string | null; primary: boolean; body: BodySection[] }>;
  commits: Array<{ sha: string; subject: string }>;
  diffStat: string;
  /** With --full or --files. */
  diff?: string;
  log?: string;
  /** Only for the checked-out branch: work not committed yet, which the diff above can't show. */
  uncommitted?: { stat: string; untracked: string[]; diff?: string };
}

/** A catch-up on a branch or PR: why it exists (its tickets), what happened (commits), and how big it is (the diff). */
export async function summarize(app: App, target: string | undefined, flags: Flags): Promise<Summary> {
  let branch = target;
  let base: { ref: string; source: Summary['baseSource'] } | null = flags.base ? { ref: flags.base, source: 'flag' } : null;
  if (target && (looksLikeUrl(target) || parseId(target))) {
    const { pr } = await findPullRequest(app, target);
    branch = pr.sourceBranch;
    base ??= { ref: pr.targetBranch, source: 'pr-target' };
  }
  const scope = await app.scope();
  branch ??= scope.branch;
  if (!branch) throw new UserError('Not on a branch — pass a branch, PR id or PR link.');
  const ado = app.ado(scope.orgUrl);

  if (!base && scope.repo) {
    const pr = await ado.activePullRequest(scope.project, scope.repo, branch);
    if (pr) base = { ref: pr.targetBranch, source: 'pr-target' };
  }
  if (!base) {
    const head = await app.git.originHead();
    const repoDefault = head ? null : scope.repo ? await ado.defaultBranch(scope.project, scope.repo) : null;
    if (head || repoDefault) base = { ref: (head ?? repoDefault)!, source: head ? 'origin-head' : 'repo-default' };
  }
  if (!base) throw new UserError(`Could not tell what to compare "${branch}" against.`, ['Pass --base <branch>.']);

  const headRef = await app.git.readableRef(branch);
  const baseRef = (await app.git.hasRef(`origin/${base.ref}`)) ? `origin/${base.ref}` : base.ref;
  const link = await app.links.get(branch);
  const items = await ado.workItems(link.ids);
  const paths = flags.files?.length ? ['--', ...flags.files] : [];
  const wantDiff = Boolean(flags.full || flags.files?.length);
  const range = `${baseRef}...${headRef}`;
  const [log, diffStat, diff, fullLog] = await Promise.all([
    app.git.try(['log', '--format=%H%x09%s', `${baseRef}..${headRef}`]),
    app.git.try(['diff', '--stat', range, ...paths]),
    wantDiff ? app.git.try(['diff', range, ...paths]) : null,
    flags.full ? app.git.try(['log', `${baseRef}..${headRef}`]) : null,
  ]);

  const summary: Summary = {
    branch,
    base: baseRef,
    baseSource: base.source,
    workItems: items.map((w) => ({ id: w.id, title: w.title, type: w.type, state: w.state, primary: w.id === link.primary, body: w.body })),
    commits: (log ?? '').split('\n').filter(Boolean).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })),
    diffStat: diffStat ?? '',
    ...(wantDiff ? { diff: diff ?? '' } : {}),
    ...(flags.full ? { log: fullLog ?? '' } : {}),
  };
  if (branch === scope.branch) {
    const [stat, untracked, patch] = await Promise.all([
      app.git.try(['diff', '--stat', 'HEAD', ...paths]),
      app.git.try(['ls-files', '--others', '--exclude-standard', ...(flags.files ?? [])]),
      wantDiff ? app.git.try(['diff', 'HEAD', ...paths]) : null,
    ]);
    if (stat || untracked) summary.uncommitted = { stat: stat ?? '', untracked: (untracked ?? '').split('\n').filter(Boolean), ...(patch ? { diff: patch } : {}) };
  }
  return summary;
}

export const summarizeCommand = command<{ target?: string }, Flags, Summary>({
  name: 'summarize [target]',
  description: "Catch up on a branch or PR: its tickets, commits and diff since it diverged (default: the current branch)",
  options: [
    ['--base <branch>', 'compare against this (default: the PR’s target, else the repo’s default branch)'],
    ['--full', 'full commit messages and the whole diff'],
    ['--files <paths...>', 'the actual diff, for just these paths'],
  ],
  run: (app, { target }, flags) => summarize(app, target, flags),
  render(r, out, flags) {
    const c = out.color;
    out.print(
      c.bold(`Branch: ${r.branch}`),
      c.dim(`compared against ${r.base}`),
      '',
      ...(r.workItems.length === 0 ? [c.dim('(no linked work items — see `dova link`)')] : []),
      ...r.workItems.flatMap((w) => [
        c.bold(`#${w.id} [${w.type}/${w.state}] ${w.title}${w.primary ? c.cyan(' (primary)') : ''}`),
        ...w.body.flatMap((b) => {
          const shown = flags.full ? { text: b.text, truncated: false } : truncate(b.text, 500);
          return [c.dim(`${b.label}:`), shown.text, shown.truncated && c.dim('  … --full for the rest')];
        }),
        '',
      ]),
      c.bold(`Commits (${r.commits.length})`),
      r.log ?? (r.commits.map((cm) => `  ${c.dim(cm.sha.slice(0, 7))} ${cm.subject}`).join('\n') || c.dim('  (none)')),
      '',
      c.bold('Diff'),
      (r.diff ?? r.diffStat) || c.dim('  (no changes)'),
      ...(r.uncommitted
        ? ['', c.bold('Uncommitted') + c.dim(' — in the working tree, not in the diff above'), r.uncommitted.diff ?? r.uncommitted.stat, ...r.uncommitted.untracked.map((f) => `  ${c.green('?')} ${f}`)]
        : [])
    );
  },
});
