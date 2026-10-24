import { needRepo, type App } from '../../app.js';
import type { WorkItem, WorkItemRef } from '../../core/types.js';
import { looksLikeUrl, parseId, parseWorkItemLink } from '../../core/urls.js';
import { NotFoundError, UserError } from '../../errors.js';
import { command, group, type GlobalFlags, type Out } from '../framework.js';
import { link } from './link.js';
import { findPullRequest, pullRequestDetail, renderPullRequest } from './pr.js';
import { truncate } from '../../core/text.js';

/* ---------------- view ---------------- */

type Detail = WorkItem & { parent: WorkItemRef | null; children: WorkItemRef[] };

const ref = ({ id, title, type, state }: WorkItemRef): WorkItemRef => ({ id, title, type, state });

export async function workItemDetail(app: App, idOrUrl: string): Promise<Detail> {
  const linkTo = looksLikeUrl(idOrUrl) ? parseWorkItemLink(idOrUrl) : null;
  const id = linkTo?.id ?? parseId(idOrUrl);
  if (!id) throw new UserError(`"${idOrUrl}" isn't a work item id or link.`);
  const ado = app.ado((await app.scope(linkTo ?? {})).orgUrl);
  const item = await ado.workItem(id);
  const [parent, children] = await Promise.all([
    item.parentId ? ado.workItems([item.parentId]).then(([p]) => p ?? null) : null,
    ado.query(`SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = ${id}`),
  ]);
  return { ...item, parent: parent && ref(parent), children: children.map(ref) };
}

function renderWorkItem(d: Detail, out: Out, full: boolean): void {
  const c = out.color;
  out.print(
    `${c.bold(`#${d.id}`)} ${d.title ?? ''}`,
    c.dim(`${d.type} · ${d.state} · ${d.assignedTo ? `assigned to ${d.assignedTo}` : 'unassigned'}`),
    '',
    `Area:      ${d.areaPath}`,
    `Iteration: ${d.iterationPath}`,
    d.parent && `Parent:    #${d.parent.id} ${d.parent.title ?? ''} ${c.dim(`[${d.parent.type}]`)}`,
    '',
    c.dim(d.url),
    ...d.body.flatMap((b) => {
      const shown = full ? { text: b.text, truncated: false } : truncate(b.text, 800);
      return ['', c.bold(b.label), shown.text, shown.truncated && c.dim('  … truncated — --full for the rest')];
    }),
    ...(d.children.length > 0 ? ['', c.bold(`Children (${d.children.length})`), out.table(['ID', 'Type', 'Title', 'State'], d.children.map((w) => [`#${w.id}`, w.type ?? '?', w.title ?? '', w.state ?? '?']))] : [])
  );
}

/* ---------------- area and iteration for a new item ---------------- */

interface PlaceFlags {
  team?: string;
  area?: string;
  iteration?: string;
  like?: string;
  save?: boolean;
  reresolve?: boolean;
}

interface Place {
  project: string;
  team: string | null;
  areaPath: string;
  iterationPath: string;
  warnings: string[];
}

/**
 * Where a new work item goes. In order: copied from an existing item
 * (--like), given outright (--area and --iteration), saved for this repo
 * (git config dova.area / dova.iteration), or worked out from a team —
 * its default area and current sprint. What's worked out is saved, so
 * after the first time it's silent.
 */
export async function resolvePlace(app: App, flags: PlaceFlags & GlobalFlags): Promise<Place> {
  const scope = await app.scope();
  const project = (!flags.project && (await app.git.configGet('dova.project'))) || scope.project;
  const ado = app.ado(scope.orgUrl);
  const place = (team: string | null, areaPath: string, iterationPath: string, warnings: string[] = []) => ({ project, team, areaPath, iterationPath, warnings });
  const save = async (p: Place) => {
    await app.git.configSet('dova.area', p.areaPath);
    await app.git.configSet('dova.iteration', p.iterationPath);
  };

  if (flags.like) {
    if (flags.area || flags.iteration || flags.team) throw new UserError('--like can’t be combined with --team, --area or --iteration.');
    const example = await ado.workItem(parseId(flags.like) ?? 0);
    if (!example.areaPath || !example.iterationPath) throw new NotFoundError(`#${example.id} has no area or iteration to copy.`);
    const p = place(null, example.areaPath, example.iterationPath);
    if (flags.save) await save(p);
    return p;
  }
  if (flags.save) throw new UserError('--save goes with --like.');
  if (flags.area && flags.iteration) return place(null, flags.area, flags.iteration);
  if (!flags.reresolve && !flags.team && !flags.area && !flags.iteration) {
    const [area, iteration] = await Promise.all([app.git.configGet('dova.area'), app.git.configGet('dova.iteration')]);
    if (area && iteration) return place(null, area, iteration);
  }

  let team = flags.team ?? (flags.reresolve ? null : await app.git.configGet('dova.team'));
  if (!team) {
    const teams = await ado.teams(project);
    if (teams.length === 0) throw new NotFoundError(`Project "${project}" has no teams.`);
    team = teams.length === 1 ? teams[0]! : await app.prompts.select(`Which team in "${project}"?`, teams.map((t) => ({ name: t, value: t })), 'Pass --team <name>.');
    if (await app.prompts.confirm('Save this team for this repo?')) await app.git.configSet('dova.team', team);
  }
  const warnings: string[] = [];
  let area = flags.area;
  if (!area) {
    const { defaultArea, areas } = await ado.teamAreas(project, team);
    if (defaultArea || areas.length === 1) area = defaultArea || areas[0]!;
    else if (areas.length === 0) throw new NotFoundError(`Team "${team}" has no area paths.`);
    else area = await app.prompts.select(`Team "${team}" has no default area. Which one?`, areas.map((a) => ({ name: a, value: a })), 'Pass --area <path>, or --like <id>.');
  }
  let iteration = flags.iteration ?? (await ado.currentIteration(project, team));
  if (!iteration) {
    iteration = project; // the root iteration is always named after the project
    warnings.push(`Team "${team}" has no current sprint; using the project's root iteration.`);
  }
  const p = place(team, area, iteration, warnings);
  // A one-off --team never becomes the repo's default.
  if (!flags.team && !flags.area && !flags.iteration) await save(p);
  return p;
}

/* ---------------- create ---------------- */

interface CreateFlags extends PlaceFlags {
  type?: string;
  body?: string;
  parent?: string;
  assignee?: string;
  at?: string;
  link?: boolean;
}

const createOptions: Array<[string, string]> = [
  ['--body <text>', "description ('-' reads stdin)"],
  ['--parent <id>', 'make it a child of this work item'],
  ['--assignee <user>', 'assign it ("me" for yourself)'],
  ['--at <file:line>', 'add a "Found in:" link to this line at HEAD'],
  ['--link', 'also link it to the current branch'],
  ['--team <team>', 'resolve area and iteration from this team'],
  ['--area <path>', 'area path'],
  ['--iteration <path>', 'iteration path'],
  ['--like <id>', 'copy area and iteration from this work item'],
  ['--save', 'with --like: make that this repo’s default'],
  ['--reresolve', 'ignore the saved area, iteration and team'],
];

export async function createWorkItem(app: App, titleArg: string | undefined, type: string, flags: CreateFlags & GlobalFlags) {
  const title = await app.stdin.text(titleArg, 'title');
  const place = await resolvePlace(app, flags);
  const scope = await app.scope();
  const ado = app.ado(scope.orgUrl);
  let description = flags.body === undefined ? undefined : await app.stdin.text(flags.body, 'body');
  if (flags.at) {
    const s = needRepo(scope, 'wi create --at');
    const [, file, line] = flags.at.match(/^(.*?)(?::(\d+))?$/)!;
    const url = new URL(`${s.orgUrl}/${encodeURIComponent(s.project)}/_git/${encodeURIComponent(s.repo)}`);
    url.searchParams.set('path', `/${file!.replace(/^\//, '')}`);
    url.searchParams.set('version', `GC${await app.git.run(['rev-parse', 'HEAD'])}`);
    if (line) for (const [k, v] of [['line', line], ['lineEnd', String(Number(line) + 1)], ['lineStartColumn', '1'], ['lineEndColumn', '1']]) url.searchParams.set(k!, v!);
    description = [description, `Found in: ${url}`].filter(Boolean).join('\n\n');
  }
  const parentId = flags.parent ? parseId(flags.parent) ?? undefined : undefined;
  if (flags.parent && !parentId) throw new UserError(`--parent "${flags.parent}" isn't a work item id.`);
  const assignedTo = flags.assignee && /^@?me$/i.test(flags.assignee) ? (await ado.me()) ?? undefined : flags.assignee;
  const item = await ado.createWorkItem({ project: place.project, type, title, areaPath: place.areaPath, iterationPath: place.iterationPath, description, assignedTo, parentId });
  return { ...item, team: place.team, warnings: place.warnings, linked: flags.link ? (await link(app, [String(item.id)])).branch : null };
}

const created = command<{ title?: string }, CreateFlags, Awaited<ReturnType<typeof createWorkItem>>>({
  name: 'create [title]',
  description: "File a work item ('-' or no title reads stdin)",
  options: [['--type <type>', 'work item type (default: Task)'], ...createOptions],
  run: (app, { title }, flags) => createWorkItem(app, title, flags.type ?? 'Task', flags),
  web: (r) => r.url,
  render(r, out) {
    const c = out.color;
    out.print(
      `${c.green('Created')} ${r.type} ${c.bold(`#${r.id}`)} ${r.title}`,
      c.dim(`  ${r.url}`),
      `  ${r.areaPath} · ${r.iterationPath}`,
      r.linked && `  Linked to ${r.linked}`,
      ...r.warnings.map((w) => c.yellow(`  Warning: ${w}`))
    );
  },
});

/* ---------------- commands ---------------- */

export const wi = group('wi', 'Work items', [
  command<{ idOrUrl: string }, { full?: boolean }, Detail>({
    name: 'view <id-or-url>',
    description: 'A work item with its parent and children',
    options: [['--full', 'show the description in full']],
    run: (app, { idOrUrl }) => workItemDetail(app, idOrUrl),
    web: (r) => r.url,
    render: (r, out, flags) => renderWorkItem(r, out, Boolean(flags.full)),
  }),
  command<{ query?: string }, { state?: string; type?: string; assignee?: string; tag?: string }, { items: WorkItemRef[] }>({
    name: 'search [query]',
    description: 'Work items in this project by title, state, type, assignee or tag',
    options: [
      ['--state <state>', 'in this state'],
      ['--type <type>', 'of this type'],
      ['--assignee <user>', 'assigned to ("me" for yourself)'],
      ['--tag <tag>', 'with this tag'],
    ],
    async run(app, { query }, flags) {
      const scope = await app.scope();
      const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
      const where = [
        `[System.TeamProject] = ${q(scope.project)}`,
        query && `[System.Title] CONTAINS ${q(query)}`,
        flags.state && `[System.State] = ${q(flags.state)}`,
        flags.type && `[System.WorkItemType] = ${q(flags.type)}`,
        flags.tag && `[System.Tags] CONTAINS ${q(flags.tag)}`,
        flags.assignee && `[System.AssignedTo] = ${/^@?me$/i.test(flags.assignee) ? '@Me' : q(flags.assignee)}`,
      ].filter(Boolean);
      const items = await app.ado(scope.orgUrl).query(`SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.ChangedDate] DESC`);
      return { items: items.map(ref) };
    },
    render: ({ items }, out) =>
      out.print(items.length === 0 ? out.color.dim('Nothing matched.') : out.table(['ID', 'Type', 'State', 'Title'], items.map((w) => [`#${w.id}`, w.type ?? '?', w.state ?? '?', w.title ?? '']))),
  }),
  created,
]);

export const bug = command<{ title?: string }, CreateFlags, Awaited<ReturnType<typeof createWorkItem>>>({
  ...created,
  name: 'bug [title]',
  description: "File a Bug — `dova wi create --type Bug` ('-' or no title reads stdin)",
  options: createOptions,
  run: (app, { title }, flags) => createWorkItem(app, title, 'Bug', flags),
});

/** A work item or a PR, from an id or link. A bare id tries work items first — they're what people look up by number. */
export const view = command<{ idOrUrl: string }, { full?: boolean }, { kind: 'work-item' | 'pull-request'; url: string }>({
  name: 'view <id-or-url>',
  description: 'A work item or pull request, from its id or link',
  options: [['--full', 'nothing truncated']],
  async run(app, { idOrUrl }) {
    const asPr = async () => ({ kind: 'pull-request' as const, ...(await pullRequestDetail(await findPullRequest(app, idOrUrl))) });
    if (looksLikeUrl(idOrUrl)) return parseWorkItemLink(idOrUrl) ? { kind: 'work-item' as const, ...(await workItemDetail(app, idOrUrl)) } : asPr();
    try {
      return { kind: 'work-item' as const, ...(await workItemDetail(app, idOrUrl)) };
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      return asPr().catch((e) => Promise.reject(e instanceof NotFoundError ? new NotFoundError(`#${idOrUrl} is neither a work item nor a pull request.`) : e));
    }
  },
  web: (r) => r.url,
  render: (r, out, flags) =>
    r.kind === 'work-item' ? renderWorkItem(r as unknown as Detail, out, Boolean(flags.full)) : renderPullRequest(r as never, out, Boolean(flags.full)),
});
