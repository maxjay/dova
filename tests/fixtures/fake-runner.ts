import { readFileSync } from 'node:fs';
import type { Runner, ProcessResult } from '../../src/lib/exec.js';

/**
 * Free-text values reach `az` as `@<temp path>` rather than inline (see
 * `azText`), which real `az` expands by reading the file. The fake does
 * the same, so handlers can keep pattern-matching on the text a command
 * actually sent instead of on a temp path that changes every run.
 *
 * Tests that need to prove a value was file-backed assert on the raw
 * args instead — see tests/exec.test.ts and tests/az-file-arg.test.ts.
 */
function inlineFileArgs(args: string[]): string[] {
  return args.map((arg) => {
    if (!arg.startsWith('@')) return arg;
    try {
      return readFileSync(arg.slice(1), 'utf8');
    } catch {
      // Not a path this test wrote — e.g. `dova api --body @user/file.json`.
      return arg;
    }
  });
}

export type Handler = (args: string[], opts?: { cwd?: string }) => ProcessResult | Promise<ProcessResult>;

export function ok(stdout: string): ProcessResult {
  return { stdout, stderr: '', exitCode: 0 };
}

export function okJson(data: unknown): ProcessResult {
  return ok(JSON.stringify(data));
}

export function fail(stderr = '', exitCode = 1): ProcessResult {
  return { stdout: '', stderr, exitCode };
}

/**
 * A fully in-memory `Runner` for tests — no real git/az process is ever
 * spawned. Pass handlers that pattern-match on the `args` array; anything
 * unmatched should return `fail(...)` so a test fails loudly instead of
 * hanging on an unexpected call.
 */
export function createFakeRunner(
  handlers: { git?: Handler; az?: Handler },
  /** Set `rawArgs` to see `@<path>` as az would receive it, for tests about the file-backing itself. */
  opts: { rawArgs?: boolean } = {}
): Runner {
  return {
    async git(args, gitOpts) {
      if (!handlers.git) return fail('no git handler configured for this test');
      return handlers.git(args, gitOpts);
    },
    async az(args, azOpts) {
      if (!handlers.az) return fail('no az handler configured for this test');
      return handlers.az(opts.rawArgs ? args : inlineFileArgs(args), azOpts);
    },
  };
}
