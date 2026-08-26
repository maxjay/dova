import type { ChalkInstance } from 'chalk';
import type { Runner } from './exec.js';
import { runAzJson } from './exec.js';
import { buildWiql } from './wiql.js';
import { renderTable } from './output.js';
import { NotFoundError, looksLikeAzNotFoundError } from './errors.js';
import { azText } from './az-file-arg.js';
import type { AzWorkItem } from '../types/azure-devops.js';

/**
 * Web URL for a single work item. Format confirmed from the
 * azure-devops-cli-extension source (`_open_work_item` in
 * dev/boards/work_item.py): `{orgUrl}/{project}/_workitems?id={id}`.
 */
export function buildWiWebUrl(orgUrl: string, project: string, id: number): string {
  return `${orgUrl}/${encodeURIComponent(project)}/_workitems?id=${id}`;
}

export async function fetchWorkItem(runner: Runner, orgUrl: string, id: number): Promise<AzWorkItem> {
  let result: AzWorkItem | null;
  try {
    result = await runAzJson<AzWorkItem | null>(runner, [
      'boards', 'work-item', 'show',
      '--id', String(id),
      '--organization', orgUrl,
    ]);
  } catch (err) {
    // A nonexistent id fails the az call outright (nonzero exit), rather
    // than succeeding with an empty result — see looksLikeAzNotFoundError.
    if (err instanceof Error && looksLikeAzNotFoundError(err.message)) {
      throw new NotFoundError(`Work item #${id} was not found.`);
    }
    throw err;
  }
  if (!result) {
    throw new NotFoundError(`Work item #${id} was not found.`);
  }
  return result;
}

/**
 * Batch-fetches several work items by id in a single call. There's no
 * native "show many" command (`work-item show` takes one --id), so this
 * goes through `az boards query --wiql` instead — one call for N ids.
 * Returns [] for an empty `ids` array without making a call.
 */
export async function fetchWorkItemsByIds(
  runner: Runner,
  orgUrl: string,
  ids: number[],
  fields: string[] = ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo']
): Promise<AzWorkItem[]> {
  if (ids.length === 0) return [];
  const wiql = buildWiql({ fields, where: [{ field: 'System.Id', op: 'IN', value: ids }] });
  const result = await runAzJson<AzWorkItem[] | null>(runner, [
    'boards', 'query',
    '--wiql', azText(wiql),
    '--organization', orgUrl,
  ]);
  return result ?? [];
}

/** Direct children of a work item (via System.Parent — a queryable reference field on every process template). */
export async function fetchChildren(runner: Runner, orgUrl: string, parentId: number): Promise<AzWorkItem[]> {
  const wiql = buildWiql({
    fields: ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType'],
    where: [{ field: 'System.Parent', op: '=', value: parentId }],
  });
  const result = await runAzJson<AzWorkItem[] | null>(runner, ['boards', 'query', '--wiql', azText(wiql), '--organization', orgUrl]);
  return result ?? [];
}

/**
 * `System.Description` is rich text (HTML) for most process templates,
 * not plain text. This is a pragmatic tag-stripper for terminal display
 * — not an HTML parser — covering markup and entities that actually
 * show up in practice, not the general case.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function fieldValue(item: AzWorkItem, field: string): string | null {
  const value = item.fields[field];
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && 'displayName' in (value as Record<string, unknown>)) {
    return (value as { displayName: string }).displayName;
  }
  return String(value);
}

export interface WorkItemRef {
  id: number;
  title: string | null;
  type: string | null;
  state: string | null;
}

/**
 * Where a work item's actual content lives depends on its type and the
 * project's process template. Reading only `System.Description` misses
 * the point of the ticket for most types: an Agile Bug puts the detail
 * in ReproSteps and often leaves Description empty, and a User Story or
 * Feature states its real objective in AcceptanceCriteria. All three
 * are stock fields across the out-of-box templates, and any that a
 * given project doesn't use simply comes back absent.
 */
export const BODY_FIELDS: ReadonlyArray<{ field: string; label: string }> = [
  { field: 'System.Description', label: 'Description' },
  { field: 'Microsoft.VSTS.Common.AcceptanceCriteria', label: 'Acceptance Criteria' },
  { field: 'Microsoft.VSTS.TCM.ReproSteps', label: 'Repro Steps' },
];

export interface WorkItemBody {
  label: string;
  text: string;
}

/** Every body field this item actually has, in the order above, HTML stripped. */
export function workItemBody(item: AzWorkItem): WorkItemBody[] {
  const body: WorkItemBody[] = [];
  for (const { field, label } of BODY_FIELDS) {
    const raw = fieldValue(item, field);
    if (!raw) continue;
    const text = stripHtml(raw).trim();
    if (text) body.push({ label, text });
  }
  return body;
}

export interface WorkItemDetail extends WorkItemRef {
  assignedTo: string | null;
  areaPath: string | null;
  iterationPath: string | null;
  description: string | null;
  /** Description, acceptance criteria, repro steps — whichever this item has. */
  body: WorkItemBody[];
  parent: WorkItemRef | null;
  /** Direct children (e.g. a Feature's User Stories) — populated for any type, not just portfolio levels. */
  children: WorkItemRef[];
  url: string;
}

function toRef(item: AzWorkItem): WorkItemRef {
  return {
    id: item.id,
    title: fieldValue(item, 'System.Title'),
    type: fieldValue(item, 'System.WorkItemType'),
    state: fieldValue(item, 'System.State'),
  };
}

/**
 * Full detail for a single work item, the way both `dova wi view` and
 * `dova view` render it: the item itself, its parent (by id, hydrated
 * with title/type/state when the fetch succeeds), and its direct children
 * — generic across every work item type, so a Feature's User Stories (or
 * an Epic's Features, or a bug's linked tasks) all come back the same
 * shape without dova knowing anything process-specific about any of them.
 */
export async function gatherWorkItemDetail(
  runner: Runner,
  orgUrl: string,
  id: number,
  fallbackProject?: string
): Promise<WorkItemDetail> {
  const item = await fetchWorkItem(runner, orgUrl, id);
  const project = fieldValue(item, 'System.TeamProject') ?? fallbackProject ?? '';
  const parentIdRaw = item.fields['System.Parent'];
  const parentId = typeof parentIdRaw === 'number' ? parentIdRaw : undefined;

  const [children, parentItem] = await Promise.all([
    fetchChildren(runner, orgUrl, id),
    parentId ? fetchWorkItem(runner, orgUrl, parentId).catch(() => null) : Promise.resolve(null),
  ]);

  return {
    ...toRef(item),
    assignedTo: fieldValue(item, 'System.AssignedTo'),
    areaPath: fieldValue(item, 'System.AreaPath'),
    iterationPath: fieldValue(item, 'System.IterationPath'),
    description: fieldValue(item, 'System.Description'),
    body: workItemBody(item),
    parent: parentItem ? toRef(parentItem) : parentId ? { id: parentId, title: null, type: null, state: null } : null,
    children: children.map(toRef),
    url: buildWiWebUrl(orgUrl, project, item.id),
  };
}

/** Human rendering of `WorkItemDetail`, shared by `dova wi view` and `dova view`. */
/** Body text is the reason to read a ticket at all, so it's shown in full past this only with --full. */
const BODY_TRUNCATE = 800;

export function renderWorkItemDetailHuman(detail: WorkItemDetail, color: ChalkInstance, full = false): void {
  const lines: string[] = [
    `${color.bold(`#${detail.id}`)} ${detail.title ?? color.dim('(no title)')}`,
    `${color.dim(String(detail.type))} · ${color.dim(String(detail.state))}${detail.assignedTo ? ` · ${color.dim(`assigned to ${detail.assignedTo}`)}` : color.dim(' · unassigned')}`,
    '',
    `Area:      ${detail.areaPath ?? color.dim('(none)')}`,
    `Iteration: ${detail.iterationPath ?? color.dim('(none)')}`,
  ];
  if (detail.parent) {
    const p = detail.parent;
    lines.push(`Parent:    #${p.id}${p.title ? ` ${p.title}` : ''}${p.type ? color.dim(` [${p.type}]`) : ''}`);
  }
  lines.push('', color.dim(detail.url));

  // What the ticket actually asks for. Without this, `wi view` reports
  // a ticket's metadata and none of its substance, which sends the
  // reader straight back to the browser.
  for (const section of detail.body) {
    lines.push('', color.bold(section.label));
    if (full || section.text.length <= BODY_TRUNCATE) {
      lines.push(section.text);
    } else {
      lines.push(`${section.text.slice(0, BODY_TRUNCATE).trimEnd()}…`);
      lines.push(color.dim('  … truncated — pass --full for the rest'));
    }
  }

  if (detail.children.length > 0) {
    lines.push('', color.bold(`Children (${detail.children.length})`));
    lines.push(
      renderTable(
        ['ID', 'Type', 'Title', 'State'],
        detail.children.map((c) => [`#${c.id}`, c.type ?? '?', c.title ?? '(no title)', c.state ?? '?'])
      )
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}
