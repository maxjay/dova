import type { Runner, ProcessResult } from '../../src/lib/exec.js';

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
export function createFakeRunner(handlers: { git?: Handler; az?: Handler }): Runner {
  return {
    async git(args, opts) {
      if (!handlers.git) return fail('no git handler configured for this test');
      return handlers.git(args, opts);
    },
    async az(args, opts) {
      if (!handlers.az) return fail('no az handler configured for this test');
      return handlers.az(args, opts);
    },
  };
}
