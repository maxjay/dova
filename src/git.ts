import { execa } from 'execa';
import { ExternalError, NotFoundError, PrereqError } from './errors.js';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs one git command; the seam tests replace. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export const execGit: GitRunner = async (args, cwd) => {
  const res = await execa('git', args, { cwd, reject: false });
  if (res.code === 'ENOENT') throw new PrereqError('git is not installed or not on PATH.');
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode ?? 1 };
};

/** git, in the user's working tree. */
export class Git {
  constructor(
    private readonly runner: GitRunner,
    readonly cwd: string
  ) {}

  /** Trimmed stdout; throws on a non-zero exit. */
  async run(args: string[]): Promise<string> {
    const res = await this.runner(args, this.cwd);
    if (res.exitCode !== 0) throw new ExternalError(`git ${args.join(' ')} failed:\n${res.stderr.trim()}`);
    return res.stdout.trimEnd();
  }

  /** Trimmed stdout, or null on a non-zero exit or empty output. */
  async try(args: string[]): Promise<string | null> {
    const res = await this.runner(args, this.cwd);
    const out = res.stdout.trimEnd();
    return res.exitCode === 0 && out ? out : null;
  }

  async isRepo(): Promise<boolean> {
    return (await this.try(['rev-parse', '--is-inside-work-tree'])) === 'true';
  }

  /** Null on a detached HEAD or outside a repo. */
  async currentBranch(): Promise<string | null> {
    const branch = await this.try(['rev-parse', '--abbrev-ref', 'HEAD']);
    return branch && branch !== 'HEAD' ? branch : null;
  }

  remoteUrl(remote = 'origin'): Promise<string | null> {
    return this.try(['remote', 'get-url', remote]);
  }

  /** The branch origin's HEAD points at, if the clone recorded it. */
  async originHead(): Promise<string | null> {
    const ref = await this.try(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return ref ? ref.replace(/^origin\//, '') : null;
  }

  async hasRef(ref: string): Promise<boolean> {
    return (await this.try(['rev-parse', '--verify', '--quiet', ref])) !== null;
  }

  /**
   * A ref to read `branch` from: local, already fetched, or fetched now
   * into a remote-tracking ref. Never checks anything out, so it works for
   * someone else's PR without touching the working tree.
   */
  async readableRef(branch: string): Promise<string> {
    if (await this.hasRef(`refs/heads/${branch}`)) return branch;
    if (await this.hasRef(`refs/remotes/origin/${branch}`)) return `origin/${branch}`;
    const res = await this.runner(['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`], this.cwd);
    if (res.exitCode !== 0) {
      const said = res.stderr.trim().split('\n')[0];
      throw new NotFoundError(`No branch named "${branch}" locally or on origin.`, said ? [`git fetch said: ${said}`] : []);
    }
    return `origin/${branch}`;
  }

  /* ---------------- config ---------------- */

  configGet(key: string): Promise<string | null> {
    return this.try(['config', '--get', key]);
  }

  async configSet(key: string, value: string): Promise<void> {
    await this.run(['config', key, value]);
  }

  async configUnset(key: string): Promise<void> {
    await this.try(['config', '--unset', key]);
  }

  /** Every `key value` pair whose key matches. */
  async configMatching(pattern: string): Promise<Array<[key: string, value: string]>> {
    const out = await this.try(['config', '--get-regexp', pattern]);
    if (!out) return [];
    return out.split('\n').flatMap((line) => {
      const space = line.indexOf(' ');
      return space === -1 ? [] : [[line.slice(0, space), line.slice(space + 1)] as [string, string]];
    });
  }
}

/* ------------------------------------------------------------------ *
 * Which work items a branch is for — the one thing dova records that
 * neither git nor Azure DevOps tracks. It lives in that branch's own git
 * config, next to its upstream:
 *
 *   branch.<name>.dova-workitems = 4821,4822
 *   branch.<name>.dova-primary   = 4821
 * ------------------------------------------------------------------ */

export interface BranchLink {
  branch: string;
  ids: number[];
  /** Always one of `ids` when there are any. */
  primary: number | null;
}

const idsKey = (branch: string) => `branch.${branch}.dova-workitems`;
const primaryKey = (branch: string) => `branch.${branch}.dova-primary`;

function parseIds(raw: string | null | undefined): number[] {
  return [...new Set((raw ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))];
}

function link(branch: string, ids: number[], primary: number | null): BranchLink {
  return { branch, ids, primary: primary !== null && ids.includes(primary) ? primary : ids[0] ?? null };
}

export class LinkStore {
  constructor(private readonly git: Git) {}

  async get(branch: string): Promise<BranchLink> {
    const [ids, primary] = await Promise.all([this.git.configGet(idsKey(branch)), this.git.configGet(primaryKey(branch))]);
    return link(branch, parseIds(ids), primary ? Number(primary) : null);
  }

  /** Replaces the branch's links; an empty `ids` removes them. */
  async set(branch: string, ids: number[], primary: number | null): Promise<BranchLink> {
    const next = link(branch, [...new Set(ids)], primary);
    if (next.ids.length === 0) {
      await this.git.configUnset(idsKey(branch));
      await this.git.configUnset(primaryKey(branch));
      return next;
    }
    await this.git.configSet(idsKey(branch), next.ids.join(','));
    await this.git.configSet(primaryKey(branch), String(next.primary));
    return next;
  }

  /** Every branch with links, in no particular order. */
  async all(): Promise<BranchLink[]> {
    const entries = await this.git.configMatching(String.raw`^branch\..*\.dova-(workitems|primary)$`);
    const ids = new Map<string, number[]>();
    const primaries = new Map<string, number>();
    for (const [key, value] of entries) {
      const match = key.match(/^branch\.(.+)\.dova-(workitems|primary)$/);
      if (!match) continue;
      if (match[2] === 'workitems') ids.set(match[1]!, parseIds(value));
      else primaries.set(match[1]!, Number(value));
    }
    return [...ids].filter(([, list]) => list.length > 0).map(([branch, list]) => link(branch, list, primaries.get(branch) ?? null));
  }
}
