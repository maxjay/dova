import type { ChalkInstance } from 'chalk';
import type { Runner } from './exec.js';
import { adoJson, adoUrl, projectBase, accountFromConnectionData, type ConnectionData } from './ado.js';
import { buildWiql } from './wiql.js';
import { renderTable } from './output.js';
import { NotFoundError } from './errors.js';
import type { AzWorkItem } from '../types/azure-devops.js';

/**
 * Web URL for a single work item: `{orgUrl}/{project}/_workitems?id={id}`,
 * the same link the Azure DevOps UI hands out.
 */
export function buildWiWebUrl(orgUrl: string, project: string, id: number): string {
  return `${orgUrl}/${encodeURIComponent(project)}/_workitems?id=${id}`;
}

export async function fetchWorkItem(runner: Runner, orgUrl: string, id: number): Promise<AzWorkItem> {
  try {
    return await adoJson<AzWorkItem>(runner, {
      method: 'GET',
      url: adoUrl(orgUrl, `_apis/wit/workitems/${id}`, { $expand: 'relations' }),
    });
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError(`Work item #${id} was not found.`);
    throw err;
  }
}

/** The work items API takes at most this many ids per batch request. */
const BATCH_SIZE = 200;

/** Upper bound on what one query returns — far past anything a terminal shows. */
const QUERY_TOP = 1000;

interface WiqlResult {
  workItems?: Array<{ id: number }>;
  columns?: Array<{ referenceName: string }>;
}

/**
 * Runs a WIQL query and returns the matching work items, with the fields
 * the query SELECTs, in the query's own order. WIQL itself only returns
 * ids, so this is one query plus one batch fetch per 200 results.
 */
export async function queryWorkItems(runner: Runner, orgUrl: string, wiql: string): Promise<AzWorkItem[]> {
  const result = await adoJson<WiqlResult>(runner, {
    method: 'POST',
    url: adoUrl(orgUrl, '_apis/wit/wiql', { $top: QUERY_TOP }),
    body: { query: wiql },
  });
  const ids = (result?.workItems ?? []).map((w) => w.id);
  const fields = (result?.columns ?? []).map((c) => c.referenceName);
  return fetchWorkItemsBatch(runner, orgUrl, ids, fields.length > 0 ? fields : undefined);
}

/**
 * Work items by id, in the order asked for. Ids that don't exist (or
 * that the user can't see) are left out rather than failing the batch.
 * Every field when `fields` is omitted.
 */
export async function fetchWorkItemsBatch(runner: Runner, orgUrl: string, ids: number[], fields?: string[]): Promise<AzWorkItem[]> {
  if (ids.length === 0) return [];
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) chunks.push(ids.slice(i, i + BATCH_SIZE));

  const pages = await Promise.all(
    chunks.map((chunk) =>
      adoJson<{ value?: Array<AzWorkItem | null> }>(runner, {
        method: 'POST',
        url: adoUrl(orgUrl, '_apis/wit/workitemsbatch'),
        body: { ids: chunk, ...(fields ? { fields } : {}), errorPolicy: 'omit' },
      })
    )
  );
  const byId = new Map<number, AzWorkItem>();
  for (const page of pages) {
    for (const item of page?.value ?? []) if (item) byId.set(item.id, item);
  }
  return ids.map((id) => byId.get(id)).filter((item): item is AzWorkItem => item !== undefined);
}

/** Batch-fetches several work items by id. Returns [] for an empty `ids` array without making a call. */
export async function fetchWorkItemsByIds(
  runner: Runner,
  orgUrl: string,
  ids: number[],
  fields: string[] = ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo']
): Promise<AzWorkItem[]> {
  return fetchWorkItemsBatch(runner, orgUrl, ids, fields);
}

/** Direct children of a work item (via System.Parent — a queryable reference field on every process template). */
export async function fetchChildren(runner: Runner, orgUrl: string, parentId: number): Promise<AzWorkItem[]> {
  const wiql = buildWiql({
    fields: ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType'],
    where: [{ field: 'System.Parent', op: '=', value: parentId }],
  });
  return queryWorkItems(runner, orgUrl, wiql);
}

export interface CreateWorkItemOptions {
  type: string;
  /** Field reference name -> value, e.g. `System.Title`. Undefined values are skipped. */
  fields: Record<string, string | undefined>;
  /** Link the new item as a child of this one, in the same request. */
  parentId?: number;
}

/**
 * Creates a work item in one request — fields and parent link together,
 * so there is never a created-but-unlinked item to account for.
 */
export async function createWorkItem(runner: Runner, orgUrl: string, project: string, opts: CreateWorkItemOptions): Promise<AzWorkItem> {
  const patch: Array<{ op: 'add'; path: string; value: unknown }> = [];
  for (const [field, value] of Object.entries(opts.fields)) {
    if (value !== undefined) patch.push({ op: 'add', path: `/fields/${field}`, value });
  }
  if (opts.parentId !== undefined) {
    patch.push({
      op: 'add',
      path: '/relations/-',
      value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${orgUrl}/_apis/wit/workItems/${opts.parentId}` },
    });
  }
  return adoJson<AzWorkItem>(runner, {
    method: 'POST',
    url: adoUrl(projectBase(orgUrl, project), `_apis/wit/workitems/$${encodeURIComponent(opts.type)}`),
    body: patch,
    contentType: 'application/json-patch+json',
  });
}

/**
 * The signed-in user as a value `System.AssignedTo` accepts, for
 * `--assign-to me`. The REST API has no "me" shorthand of its own.
 */
export async function currentUserIdentity(runner: Runner, orgUrl: string): Promise<string> {
  const data = await adoJson<ConnectionData>(runner, { method: 'GET', url: adoUrl(orgUrl, '_apis/connectionData', { 'api-version': '7.1-preview' }) });
  const account = accountFromConnectionData(data ?? {});
  const identity = account.username ?? account.name;
  if (!identity) throw new NotFoundError('Could not tell who the signed-in user is, to assign the item to.', ['Pass --assign-to <email> instead.']);
  return identity;
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
