import { needBranch, type App } from '../../app.js';
import type { WorkItem } from '../../core/types.js';
import { parseId } from '../../core/urls.js';
import { NotFoundError, UserError } from '../../errors.js';
import { command, type Out } from '../framework.js';

/* `dova link` records which work items the branch you're on is for, so `dova pr create` links them. It never creates or names branches — that's git's. */

interface Linked {
  branch: string;
  workItems: Array<{ id: number; title: string | null; type: string | null; primary: boolean }>;
  /** Already linked on another branch, and you chose to switch to it. */
  switchedTo?: string;
  warnings: string[];
}

function parseIds(values: string[]): number[] {
  const ids = values.map(parseId);
  if (ids.some((id) => id === null)) throw new UserError(`Not work item ids: ${values.join(' ')}`);
  return [...new Set(ids as number[])];
}

async function describe(app: App, orgUrl: string, ids: number[], primary: number | null, known: WorkItem[] = []): Promise<Linked['workItems']> {
  const byId = new Map(known.map((w) => [w.id, w]));
  const missing = ids.filter((id) => !byId.has(id));
  for (const w of missing.length > 0 ? await app.ado(orgUrl).workItems(missing) : []) byId.set(w.id, w);
  return ids.map((id) => ({ id, title: byId.get(id)?.title ?? null, type: byId.get(id)?.type ?? null, primary: id === primary }));
}

export async function link(app: App, values: string[], primaryArg?: string): Promise<Linked> {
  const seeds = parseIds(values);
  const s = needBranch(await app.scope());
  const ado = app.ado(s.orgUrl);
  const warnings: string[] = [];
  const parents = seeds.join(', ');
  const [found, children] = await Promise.all([ado.workItems(seeds), ado.query(`SELECT [System.Id] FROM WorkItems WHERE [System.Parent] IN (${parents})`)]);
  const missing = seeds.filter((id) => !found.some((w) => w.id === id));
  if (missing.length > 0) throw new NotFoundError(`Not found: ${missing.map((id) => `#${id}`).join(', ')}`);

  // A ticket with children (an Epic, a Feature, a Bug used as a checklist) links the open ones you pick.
  const types = [...new Set(children.map((c) => c.type ?? ''))];
  const states = new Map(await Promise.all(types.map(async (t) => [t, await ado.states(s.project, t)] as const)));
  const done = (w: WorkItem) => /Completed|Removed/.test(states.get(w.type ?? '')?.find((st) => st.name === w.state)?.category ?? '');
  const ids: number[] = [];
  for (const seed of found) {
    const mine = children.filter((c) => c.parentId === seed.id);
    const open = mine.filter((c) => !done(c));
    if (mine.length === 0) ids.push(seed.id);
    else if (open.length === 0) warnings.push(`#${seed.id} has children, but none are open — nothing linked from it.`);
    else {
      const picked = await app.prompts.checkbox(
        `#${seed.id} "${seed.title}" has open children — link which?`,
        open.map((c) => ({ name: `#${c.id} [${c.type}/${c.state}] ${c.title}`, value: String(c.id), checked: true })),
        `Pass the ids you want: dova link ${open.map((c) => c.id).join(' ')}`
      );
      ids.push(...picked.map(Number));
    }
  }
  if (ids.length === 0) throw new UserError('Nothing to link: no open work items.');

  // Already tracked on another branch? Offer to go there instead of tracking it twice.
  for (const other of await app.links.all()) {
    if (other.branch === s.branch || !other.ids.some((id) => ids.includes(id))) continue;
    if (await app.prompts.confirm(`Branch "${other.branch}" already links this work — switch to it?`)) {
      await app.git.run(['checkout', other.branch]);
      return { branch: other.branch, switchedTo: other.branch, warnings, workItems: await describe(app, s.orgUrl, other.ids, other.primary, [...found, ...children]) };
    }
  }

  const current = await app.links.get(s.branch);
  const merged = [...new Set([...current.ids, ...ids])];
  const primary = primaryArg ? parseIds([primaryArg])[0]! : current.primary;
  if (primaryArg && !merged.includes(primary!)) throw new UserError(`--primary ${primaryArg} isn't among the linked work items.`);
  const saved = await app.links.set(s.branch, merged, primary);
  return { branch: s.branch, warnings, workItems: await describe(app, s.orgUrl, saved.ids, saved.primary, [...found, ...children]) };
}

export async function unlink(app: App, values: string[], all: boolean, primaryArg?: string): Promise<Linked & { removed: number[] }> {
  if (!all && values.length === 0) throw new UserError('Pass the ids to unlink, or --all.');
  const s = needBranch(await app.scope());
  const current = await app.links.get(s.branch);
  if (current.ids.length === 0) throw new NotFoundError(`Branch "${s.branch}" has no linked work items.`);
  const removed = all ? current.ids : parseIds(values).filter((id) => current.ids.includes(id));
  if (removed.length === 0) throw new UserError(`None of those are linked to "${s.branch}".`, [`Linked: ${current.ids.map((id) => `#${id}`).join(', ')}`]);
  const remaining = current.ids.filter((id) => !removed.includes(id));
  const primary = primaryArg ? parseIds([primaryArg])[0]! : current.primary;
  if (primaryArg && !remaining.includes(primary!)) throw new UserError(`--primary ${primaryArg} isn't among the remaining work items.`);
  const saved = await app.links.set(s.branch, remaining, primary);
  return { branch: s.branch, removed, warnings: [], workItems: await describe(app, s.orgUrl, saved.ids, saved.primary) };
}

function renderLinked(r: Linked, out: Out, heading = 'Linked'): void {
  const c = out.color;
  out.print(
    r.switchedTo && c.yellow(`Already linked on "${r.switchedTo}" — switched to it.`),
    `${c.bold('Branch:')} ${r.branch}`,
    ...(r.workItems.length > 0 ? [c.bold(`${heading}:`), ...r.workItems.map((w) => `  #${w.id} [${w.type ?? '?'}] ${w.title ?? ''}${w.primary ? c.cyan(' (primary)') : ''}`)] : [c.dim('No work items linked.')]),
    ...r.warnings.map((w) => c.yellow(`Warning: ${w}`))
  );
}

export const linkCommands = [
  command<{ ids: string[] }, { primary?: string }, Linked>({
    name: 'link <ids...>',
    description: 'Record that the current branch is for these work items, so `dova pr create` links them',
    options: [['--primary <id>', 'the main one (default: the first, or the existing primary)']],
    run: (app, { ids }, flags) => link(app, ids, flags.primary),
    render: (r, out) => renderLinked(r, out),
  }),
  command<{ ids: string[] }, { all?: boolean; primary?: string }, Linked & { removed: number[] }>({
    name: 'unlink [ids...]',
    description: 'Remove work items from the current branch',
    options: [
      ['--all', 'remove all of them'],
      ['--primary <id>', 'which remaining one becomes primary'],
    ],
    run: (app, { ids }, flags) => unlink(app, ids, Boolean(flags.all), flags.primary),
    render: (r, out) => (out.print(`${out.color.bold('Removed:')} ${r.removed.map((id) => `#${id}`).join(', ')}`), renderLinked(r, out, 'Still linked')),
  }),
  command<never, never, { branches: Array<{ branch: string; lastCommit: string | null; primary: number | null; title: string | null; others: number[] }> }>({
    name: 'list',
    description: 'Local branches linked to work items, most recently active first',
    async run(app) {
      const [links, refs, scope] = await Promise.all([app.links.all(), app.git.try(['for-each-ref', '--format=%(refname:short)%09%(committerdate:iso-strict)', 'refs/heads/']), app.scope()]);
      const dates = new Map((refs ?? '').split('\n').map((l) => l.split('\t') as [string, string]));
      const titles = new Map((await app.ado(scope.orgUrl).workItems(links.flatMap((l) => (l.primary ? [l.primary] : [])))).map((w) => [w.id, w.title]));
      const branches = links.map((l) => ({ branch: l.branch, lastCommit: dates.get(l.branch) ?? null, primary: l.primary, title: titles.get(l.primary!) ?? null, others: l.ids.filter((id) => id !== l.primary) }));
      return { branches: branches.sort((a, b) => (b.lastCommit ?? '').localeCompare(a.lastCommit ?? '')) };
    },
    render: ({ branches }, out) =>
      out.print(
        branches.length === 0
          ? out.color.dim('No branches are linked to work items — see `dova link`.')
          : out.table(['Branch', 'Primary', 'Title', ''], branches.map((b) => [b.branch, `#${b.primary}`, b.title ?? '', b.others.length > 0 ? out.color.dim(`+${b.others.length}`) : '']))
      ),
  }),
];
