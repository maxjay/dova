import fs from 'node:fs';
import { UserError } from './errors.js';

/* ------------------------------------------------------------------ *
 * Free text that arrives on stdin instead of argv.
 *
 * Anything on a command line is parsed by the shell first, and dova
 * never sees the original: in bash `"...$total..."` expands to nothing
 * and `` "...`npm test`..." `` *executes* npm test before dova starts.
 * There is no preprocessing that recovers it — the text is already
 * gone. Single-quoting is the fix for short titles (literal in bash,
 * zsh and PowerShell alike), but it can't carry an apostrophe, so
 * anything longer gets piped in instead and reaches dova untouched:
 *
 *   dova pr comment 612 - <<'EOF'
 *   Use `npm test` — the "total" field is $null. Nothing is escaped.
 *   EOF
 * ------------------------------------------------------------------ */

type ReadableTTY = NodeJS.ReadableStream & { isTTY?: boolean };

/**
 * Whether something is actually piped or redirected in — as opposed to
 * merely "not a terminal", which is true of every agent and CI run even
 * when nothing was sent.
 *
 * A pipe is a FIFO; a `< file` redirect is a regular file with a size.
 * A closed stdin or `< /dev/null` is a character device, and neither
 * carries anything to read.
 */
export function stdinHasData(fd = 0): boolean {
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isFIFO()) return true;
    if (stat.isFile()) return stat.size > 0;
    return false;
  } catch {
    return false;
  }
}

export interface ReadTextArgOptions {
  /** What's missing, for the error message — e.g. "comment text", "title". */
  what: string;
  /** Extra guidance appended to the error when nothing is available to read. */
  hints?: string[];
  /** Injectable for tests; defaults to the real stdin. */
  stdin?: ReadableTTY;
}

async function readAll(stream: ReadableTTY): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolves a free-text argument: the value as given, or stdin when it
 * was omitted or passed as `-`. Trailing newlines (a heredoc always
 * adds one) and CRLF line endings are normalized away — that's the
 * "preprocess inside dova" half; everything downstream already handles
 * arbitrary text safely, since `az` is spawned without a shell and
 * REST bodies go through `toAsciiSafeJson`.
 */
export async function readTextArg(value: string | undefined, opts: ReadTextArgOptions): Promise<string> {
  if (value !== undefined && value !== '-') return value;

  const stream = opts.stdin ?? process.stdin;
  const hints = opts.hints ?? [];

  // Reading a terminal here would block forever waiting on a human who
  // was never asked anything — same hang as an unshowable prompt.
  if (stream.isTTY) {
    throw new UserError(`No ${opts.what} given.`, hints);
  }

  const text = (await readAll(stream)).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (text.length === 0) {
    throw new UserError(`No ${opts.what} given — stdin was empty.`, hints);
  }
  return text;
}
