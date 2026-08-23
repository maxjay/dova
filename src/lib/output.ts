import chalk, { Chalk, type ChalkInstance } from 'chalk';
import Table from 'cli-table3';
import * as jq from 'jq-wasm';
import { UserError } from './errors.js';

/* ------------------------------------------------------------------ *
 * Color — respects --no-color and $NO_COLOR (https://no-color.org),
 * on top of chalk's own TTY/CI detection.
 * ------------------------------------------------------------------ */

export function getColor(noColorFlag?: boolean): ChalkInstance {
  const disabled = Boolean(noColorFlag) || Boolean(process.env.NO_COLOR) || process.env.FORCE_COLOR === '0';
  return disabled ? new Chalk({ level: 0 }) : chalk;
}

/* ------------------------------------------------------------------ *
 * Tables — cli-table3 for layout, chalk (via getColor) for coloring.
 * cli-table3's own color styling is turned off so NO_COLOR/--no-color
 * is the single source of truth for whether ANSI codes appear at all.
 * ------------------------------------------------------------------ */

export function renderTable(headers: string[], rows: string[][]): string {
  const table = new Table({
    head: headers,
    style: { head: [], border: [], compact: false },
  });
  for (const row of rows) table.push(row);
  return table.toString();
}

/* ------------------------------------------------------------------ *
 * Diff coloring — same convention as `git diff`/`git log -p`: added
 * lines green, removed lines red, hunk headers cyan, file headers
 * bold. Applied only at render time, never to the value handed to
 * --json, so JSON/--jq output stays plain-text.
 * ------------------------------------------------------------------ */

export function colorizeDiff(patch: string, color: ChalkInstance): string {
  if (!patch) return patch;
  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git') || line.startsWith('index ')) return color.dim(line);
      if (line.startsWith('--- ') || line.startsWith('+++ ')) return color.bold(line);
      if (line.startsWith('@@')) return color.cyan(line);
      if (line.startsWith('+')) return color.green(line);
      if (line.startsWith('-')) return color.red(line);
      return line;
    })
    .join('\n');
}

/** Colors just the trailing `+++--` bar of each `git diff --stat` file line, not the filename. */
export function colorizeDiffStat(stat: string, color: ChalkInstance): string {
  if (!stat) return stat;
  return stat
    .split('\n')
    .map((line) => {
      const match = line.match(/^(.*\|\s*\d+\s+)([+-]+)$/);
      if (!match) return line;
      const [, prefix, bar] = match;
      return prefix + bar!.replace(/\+/g, (m) => color.green(m)).replace(/-/g, (m) => color.red(m));
    })
    .join('\n');
}

/* ------------------------------------------------------------------ *
 * --json / --jq, mirroring gh's pattern:
 *   --json field1,field2   restrict (and select) the JSON output to
 *                          just those top-level fields
 *   --jq <expr>            pipe that JSON through a jq expression
 *                          (requires --json; there's nothing to filter
 *                          otherwise)
 * ------------------------------------------------------------------ */

export interface OutputFlags {
  /** `true` for a bare `--json`, a comma-separated field string for `--json a,b`, `undefined` when not passed. */
  json?: string | boolean;
  jq?: string;
}

export function filterJsonFields(data: object, fields?: string[]): Record<string, unknown> {
  const record = data as Record<string, unknown>;
  if (!fields || fields.length === 0) return record;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (!(field in record)) {
      throw new UserError(`Unknown --json field "${field}".`, [
        `Available fields: ${Object.keys(record).join(', ')}`,
      ]);
    }
    out[field] = record[field];
  }
  return out;
}

function formatJqResult(value: unknown): string {
  // Mirrors `jq -r`: raw strings print unquoted, everything else prints as JSON.
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export async function applyJq(data: jq.JqInput, expression: string): Promise<string> {
  let results: unknown[];
  try {
    results = await jq.json(data, expression);
  } catch (err) {
    throw new UserError(`Invalid --jq expression "${expression}": ${err instanceof Error ? err.message : String(err)}`);
  }
  return results.map(formatJqResult).join('\n');
}

/**
 * The one call every read command ends on: prints JSON (optionally
 * filtered by --json fields and piped through --jq) when JSON output was
 * requested, otherwise falls back to the human renderer. `data` should be
 * the full result object the command computed, from which --json fields
 * are selected.
 */
export async function emit(data: object, flags: OutputFlags, renderHuman: () => void): Promise<void> {
  if (flags.jq !== undefined && flags.json === undefined) {
    throw new UserError('--jq requires --json.', ['Example: --json <fields> --jq <expr>']);
  }

  if (flags.json !== undefined) {
    const fields =
      typeof flags.json === 'string' && flags.json.length > 0
        ? flags.json.split(',').map((s) => s.trim())
        : undefined;
    const filtered = filterJsonFields(data, fields);
    if (flags.jq !== undefined) {
      process.stdout.write(`${await applyJq(filtered, flags.jq)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
    }
    return;
  }

  renderHuman();
}

/* ------------------------------------------------------------------ *
 * Error printing — used once, at the CLI entrypoint's catch handler.
 * ------------------------------------------------------------------ */

export function printError(err: unknown, color: ChalkInstance): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${color.red('Error:')} ${message}\n`);
  const hints = (err as { hints?: string[] }).hints;
  if (Array.isArray(hints)) {
    for (const hint of hints) {
      process.stderr.write(`${color.dim('  ' + hint)}\n`);
    }
  }
}
