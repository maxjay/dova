/**
 * Small WIQL builder. Nothing here writes raw WIQL for the user — every
 * command that needs one (dova wi search, batch-fetching work items by
 * id) goes through this so there's exactly one place that knows how to
 * quote/escape a WIQL string literal.
 */

/** Escapes a value for use inside a single-quoted WIQL string literal. */
export function wiqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface WiqlClause {
  field: string;
  op: '=' | '<>' | 'CONTAINS' | 'IN';
  /** A raw WIQL macro like `@Me` — passed through unquoted, unlike `value`. */
  macro?: string;
  value?: string | number | Array<string | number>;
}

function renderClause(clause: WiqlClause): string {
  if (clause.macro) {
    return `[${clause.field}] ${clause.op} ${clause.macro}`;
  }
  if (clause.op === 'IN') {
    const values = (clause.value as Array<string | number>).map((v) =>
      typeof v === 'number' ? String(v) : wiqlString(v)
    );
    return `[${clause.field}] IN (${values.join(', ')})`;
  }
  const value = clause.value;
  const rendered = typeof value === 'number' ? String(value) : wiqlString(String(value));
  return `[${clause.field}] ${clause.op} ${rendered}`;
}

export interface BuildWiqlOptions {
  fields?: string[];
  where: WiqlClause[];
  orderBy?: string;
}

export function buildWiql(opts: BuildWiqlOptions): string {
  const fields = opts.fields && opts.fields.length > 0 ? opts.fields : ['System.Id'];
  const select = `SELECT ${fields.map((f) => `[${f}]`).join(', ')} FROM WorkItems`;
  const where = opts.where.length > 0 ? ` WHERE ${opts.where.map(renderClause).join(' AND ')}` : '';
  const orderBy = opts.orderBy ? ` ORDER BY ${opts.orderBy}` : '';
  return `${select}${where}${orderBy}`;
}

/** `me`/`@me` (any case) is the one value `--assigned-to`-style flags treat as a WIQL current-user macro instead of a literal string. */
export function isCurrentUserToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'me' || normalized === '@me';
}
