import { execa, type Options as ExecaOptions } from 'execa';
import { PrereqError, ExternalCommandError } from './errors.js';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Everything dova needs from the outside world, behind one small interface.
 * Real commands use `defaultRunner` (execa under the hood); tests pass a
 * fake that returns fixture JSON, so context/team-resolver logic can be
 * unit tested without a real az/git binary or network access.
 */
export interface Runner {
  git(args: string[], opts?: { cwd?: string }): Promise<ProcessResult>;
  az(args: string[], opts?: { cwd?: string }): Promise<ProcessResult>;
}

const AZ_LOGIN_HINT = 'Run: az login';
const AZ_DEVOPS_EXT_HINT = 'Run: az extension add --name azure-devops';

function interpretAzFailure(stderr: string, exitCode: number | undefined): never {
  const text = stderr.toLowerCase();
  if (text.includes('az login') || text.includes('aadsts') || text.includes('please run')) {
    throw new PrereqError('Not logged in to Azure CLI.', [AZ_LOGIN_HINT]);
  }
  if (text.includes("'devops' is misspelled") || text.includes('az extension add --name azure-devops') ||
      (text.includes('devops') && text.includes('not a registered'))) {
    throw new PrereqError('The azure-devops extension is not installed.', [AZ_DEVOPS_EXT_HINT]);
  }
  throw new ExternalCommandError(
    `az exited with code ${exitCode ?? 'unknown'}:\n${stderr.trim() || '(no output on stderr)'}`
  );
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

  async az(args, opts) {
    try {
      const result = await execa('az', args, { cwd: opts?.cwd, reject: false });
      const exitCode = result.exitCode ?? 1;
      if (exitCode !== 0) {
        interpretAzFailure(result.stderr, result.exitCode);
      }
      return { stdout: result.stdout, stderr: result.stderr, exitCode };
    } catch (err) {
      if (isEnoent(err)) {
        throw new PrereqError('az (Azure CLI) is not installed or not on PATH.', [
          'Install: https://learn.microsoft.com/cli/azure/install-azure-cli',
        ]);
      }
      throw err;
    }
  },
};

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}

/**
 * Runs `az ... --output json` and parses the result. Every az call in dova
 * goes through this — never through table output. `args` should not include
 * `--output`/`-o`; it's appended here.
 */
export async function runAzJson<T>(runner: Runner, args: string[], opts?: { cwd?: string }): Promise<T> {
  const result = await runner.az([...args, '--output', 'json'], opts);
  const trimmed = result.stdout.trim();
  if (!trimmed) {
    // Some az commands print nothing on an empty result set (e.g. an empty list).
    return [] as unknown as T;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new ExternalCommandError(
      `Could not parse JSON from "az ${args.join(' ')}":\n${trimmed.slice(0, 500)}`
    );
  }
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

export type { ExecaOptions };
