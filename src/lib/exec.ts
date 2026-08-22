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
      const result = await execa('az', args, {
        cwd: opts?.cwd,
        reject: false,
        // az is a Python CLI; on Windows its stdout defaults to the
        // console's codepage (often cp1252), not UTF-8. When a response
        // contains a character outside that codepage — an em dash, a
        // curly quote, an accented name — az's own attempt to print it
        // (including its "not a json response, printing raw" fallback)
        // throws a UnicodeEncodeError and az exits non-zero with a
        // garbled/truncated stderr. Forcing UTF-8 IO on az's own process
        // env (not relying on the user's shell/session having it set)
        // avoids that regardless of the host terminal's codepage.
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
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

/**
 * The Azure DevOps (formerly VSTS) AAD app/resource id. `az rest` can't
 * derive an AAD resource to request a token for from a dev.azure.com (or
 * visualstudio.com) URL on its own — dev.azure.com isn't a recognized
 * Azure cloud endpoint the way management.azure.com is — so every `az
 * rest` call dova makes against Azure DevOps has to pass this explicitly
 * via `--resource`. Without it, az either fails outright or silently
 * requests a token for the wrong audience, and Azure DevOps hands back a
 * non-JSON (often HTML) response instead — which is what actually
 * triggers the Windows Unicode crash above (its content is what az's
 * "not a json response" fallback then tries, and fails, to print).
 * This is a well-known, stable resource id — not an org-specific value.
 */
export const AZURE_DEVOPS_AAD_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

/**
 * `JSON.stringify`, but every character outside printable ASCII is escaped
 * to `\uXXXX`. `az rest --body` has a long-standing, still-open upstream
 * bug (Azure/azure-cli#30366, #22616) where a body string containing a
 * character outside Latin-1 — an em dash, a curly quote, plenty of
 * ordinary non-English names — can throw `UnicodeEncodeError` while az
 * sends it, regardless of az CLI version. `\uXXXX` escapes are plain
 * ASCII and standard JSON syntax — Azure DevOps decodes them back to the
 * real character on its end — so a body built this way can never contain
 * a byte that bug can trip on, independent of whatever az does with it.
 */
export function toAsciiSafeJson(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return JSON.stringify(value).replace(/[^\x00-\x7E]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export interface AzRestOptions {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  uri: string;
  /** A JSON-serializable value dova constructs — serialized via `toAsciiSafeJson`. Mutually exclusive with `rawBody`. */
  body?: unknown;
  /**
   * A pre-formed string passed straight through as `--body`, untouched —
   * for callers (namely `dova api`, the escape hatch) handing through a
   * user-typed body that may already use az's own `@path/to/file.json`
   * syntax, which `toAsciiSafeJson` must never be applied to. The caller
   * owns avoiding the Latin-1 bug in this case. Mutually exclusive with `body`.
   */
  rawBody?: string;
  headers?: string[];
  /** Override the AAD resource `az rest` requests a token for. Defaults to Azure DevOps. */
  resource?: string;
  cwd?: string;
}

/** `runAzJson`, specialized for `az rest` against Azure DevOps — see `AZURE_DEVOPS_AAD_RESOURCE`. */
export async function runAzRestJson<T>(runner: Runner, opts: AzRestOptions): Promise<T> {
  const args = ['rest', '--method', opts.method, '--uri', opts.uri, '--resource', opts.resource ?? AZURE_DEVOPS_AAD_RESOURCE];
  if (opts.body !== undefined) args.push('--body', toAsciiSafeJson(opts.body));
  else if (opts.rawBody !== undefined) args.push('--body', opts.rawBody);
  for (const header of opts.headers ?? []) args.push('--headers', header);
  return runAzJson<T>(runner, args, { cwd: opts.cwd });
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
