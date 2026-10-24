import { execa } from 'execa';
import { PrereqError, ExternalCommandError, NotFoundError } from './errors.js';
import type { AdoRequest, AdoResponse } from './ado.js';
import { defaultTransport } from './transport.js';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Everything dova needs from the outside world, behind one small interface:
 * git, run in the user's working tree, and Azure DevOps, over its REST API.
 * Real commands use `defaultRunner`; tests pass a fake that answers from
 * fixtures (see tests/fixtures/fake-runner.ts), so no real git binary or
 * network is ever involved.
 */
export interface Runner {
  git(args: string[], opts?: { cwd?: string }): Promise<ProcessResult>;
  /** One Azure DevOps REST request. Call it through `adoJson`/`adoText` (ado.ts), which turn statuses into errors. */
  ado(req: AdoRequest): Promise<AdoResponse>;
}

export const defaultRunner: Runner = {
  async git(args, opts) {
    try {
      const result = await execa('git', args, { cwd: opts?.cwd, reject: false });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
    } catch (err) {
      if (isEnoent(err)) {
        throw new PrereqError('git is not installed or not on PATH.');
      }
      throw err;
    }
  },

  ado(req) {
    return defaultTransport().send(req);
  },
};

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}

/** Runs a git command and returns trimmed stdout. Throws ExternalCommandError on non-zero exit. */
export async function runGit(runner: Runner, args: string[], opts?: { cwd?: string }): Promise<string> {
  const result = await runner.git(args, opts);
  if (result.exitCode !== 0) {
    throw new ExternalCommandError(`git ${args.join(' ')} failed:\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** Like runGit, but returns null instead of throwing (e.g. for "does this key exist" probes). */
export async function tryGit(runner: Runner, args: string[], opts?: { cwd?: string }): Promise<string | null> {
  const result = await runner.git(args, opts);
  if (result.exitCode !== 0) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

/**
 * Resolves `branch` to a ref usable in a git diff/log range: the local
 * branch if it exists, an already-fetched remote-tracking branch if
 * that exists, or one fresh `git fetch origin <branch>` into a
 * remote-tracking ref if neither does yet — a plain fetch of the PR's
 * own source branch, no special merge ref. Never checks anything out — this is for reading, not switching
 * branches, so it works for someone else's PR without touching your
 * working tree.
 */
export async function resolveOrFetchBranchRef(runner: Runner, branch: string, cwd?: string): Promise<string> {
  if (await tryGit(runner, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })) {
    return branch;
  }
  if (await tryGit(runner, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd })) {
    return `origin/${branch}`;
  }
  const fetch = await runner.git(['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`], { cwd });
  if (fetch.exitCode !== 0) {
    const firstLine = fetch.stderr.trim().split('\n')[0];
    throw new NotFoundError(`No branch named "${branch}" found locally or on origin.`, firstLine ? [`git fetch said: ${firstLine}`] : []);
  }
  return `origin/${branch}`;
}

