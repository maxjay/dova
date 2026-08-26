import { execa, type Options as ExecaOptions } from 'execa';
import { PrereqError, ExternalCommandError, NotFoundError } from './errors.js';
import { withAzFileArg } from './az-file-arg.js';

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
 * A newline inside an `az` argument is silently destructive on Windows:
 * `az` is `az.cmd`, so the spawn goes through `cmd.exe /c`, which
 * rebuilds the command line as one string with no way to escape a
 * newline inside an argument. The text arrives empty or cut at the first
 * line and az reports success, which is how a PR gets created with no
 * description.
 *
 * There is no case where dova needs to send one: JSON bodies escape
 * newlines to `\n`, and free text goes through `withAzFileArg`. So this
 * fails loudly, everywhere, rather than only on a Windows user's PR.
 */
export function assertNoNewlineArgs(args: string[]): void {
  const offender = args.findIndex((a) => a.includes('\n') || a.includes('\r'));
  if (offender === -1) return;
  const flag = offender > 0 ? args[offender - 1] : '(first argument)';
  throw new Error(
    `Refusing to pass multi-line text to az as an argument (${flag}): it cannot survive cmd.exe on Windows. ` +
      'Wrap the call in withAzFileArg() and pass the `@path` it gives you.'
  );
}

/**
 * Runs `az ... --output json` and parses the result. Every az call in dova
 * goes through this — never through table output. `args` should not include
 * `--output`/`-o`; it's appended here.
 */
export async function runAzJson<T>(runner: Runner, args: string[], opts?: { cwd?: string }): Promise<T> {
  assertNoNewlineArgs(args);
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
 * derive an AAD resource to request a token for from a dev.azure.com URL
 * on its own — dev.azure.com isn't a recognized Azure cloud endpoint the
 * way management.azure.com is — so every `az rest` call needs it passed
 * explicitly via `--resource`, or az either fails outright or requests a
 * token for the wrong audience. dova only ever talks to Azure DevOps, so
 * this is the one and only resource `runAzRestJson` uses — not something
 * any caller needs, or should be able, to override. Well-known, stable —
 * not an org-specific value.
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
  cwd?: string;
}

/** `runAzJson`, specialized for `az rest` against Azure DevOps — see `AZURE_DEVOPS_AAD_RESOURCE`. */
export async function runAzRestJson<T>(runner: Runner, opts: AzRestOptions): Promise<T> {
  const base = ['rest', '--method', opts.method, '--uri', opts.uri, '--resource', AZURE_DEVOPS_AAD_RESOURCE];
  const headerArgs = (opts.headers ?? []).flatMap((header) => ['--headers', header]);

  // The body carries whatever a person wrote — a review reply, a comment
  // — so it can hold `(`, `&`, `%`, `^`, `!`, quotes, any of which cmd
  // re-parses when `az.cmd` forwards `%*` (see `withAzFiles`). It goes on
  // disk; only a short `@path` reaches the command line.
  if (opts.body !== undefined) {
    const json = toAsciiSafeJson(opts.body);
    return withAzFileArg(json, (arg) => runAzJson<T>(runner, [...base, '--body', arg, ...headerArgs], { cwd: opts.cwd }));
  }
  // `dova api` hands through a user-typed body that may already be az's
  // own `@path/to/file.json` — passing that through unchanged is the
  // whole point, so it must not be re-wrapped in another file.
  if (opts.rawBody !== undefined) {
    return runAzJson<T>(runner, [...base, '--body', opts.rawBody, ...headerArgs], { cwd: opts.cwd });
  }
  return runAzJson<T>(runner, [...base, ...headerArgs], { cwd: opts.cwd });
}

/**
 * Like `runAzRestJson`, but for endpoints that return plain text rather
 * than JSON (build logs) — no `--output json`, no `JSON.parse`. az
 * already dumps a non-JSON response body to stdout as-is (the "not a
 * json response, printing raw" fallback referenced above), so this is
 * just `runAzRestJson` minus the parse step.
 */
export async function runAzRestText(runner: Runner, opts: Omit<AzRestOptions, 'body' | 'rawBody'>): Promise<string> {
  const args = ['rest', '--method', opts.method, '--uri', opts.uri, '--resource', AZURE_DEVOPS_AAD_RESOURCE];
  for (const header of opts.headers ?? []) args.push('--headers', header);
  const result = await runner.az(args, { cwd: opts.cwd });
  return result.stdout;
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
 * remote-tracking ref if neither does yet — the same thing `az repos pr
 * checkout` itself does under the hood (confirmed from source: it's a
 * plain fetch of the PR's own sourceRefName, no special merge ref).
 * Never checks anything out — this is for reading, not switching
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

export type { ExecaOptions };
