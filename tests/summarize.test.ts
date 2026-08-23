import { describe, it, expect } from 'vitest';
import { resolveBase, resolveDiffableRef, gatherSummary } from '../src/commands/summarize.js';
import { UserError, NotFoundError } from '../src/lib/errors.js';
import { createFakeRunner, ok, okJson, fail } from './fixtures/fake-runner.js';
import type { AzWorkItem, AzPullRequest, AzGitRepository } from '../src/types/azure-devops.js';
import type { ResolvedContext } from '../src/lib/context.js';

const CTX: ResolvedContext = { org: 'contoso', orgUrl: 'https://dev.azure.com/contoso', project: 'MyProject', repo: 'my-repo', source: 'git-remote' };
const CTX_NO_REPO: ResolvedContext = { org: 'contoso', orgUrl: 'https://dev.azure.com/contoso', project: 'MyProject', source: 'az-devops-defaults' };

function pr(targetRefName: string): AzPullRequest {
  return {
    pullRequestId: 1,
    title: 'A PR',
    status: 'active',
    createdBy: { displayName: 'Jane' },
    creationDate: '2024-01-01T00:00:00Z',
    sourceRefName: 'refs/heads/fix/200',
    targetRefName,
    url: '',
  };
}

function item(id: number, title: string, description?: string): AzWorkItem {
  return { id, url: '', fields: { 'System.Title': title, 'System.WorkItemType': 'Bug', 'System.State': 'Active', ...(description ? { 'System.Description': description } : {}) } };
}

/** git handler: `verify(refName) => boolean`, `symbolicRef => string | null`. */
function gitFor(opts: { verify?: (ref: string) => boolean; symbolicRef?: string | null } = {}) {
  return (args: string[]) => {
    if (args[0] === 'symbolic-ref') {
      return opts.symbolicRef ? ok(opts.symbolicRef) : fail('', 1);
    }
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      const ref = args[args.length - 1]!;
      return opts.verify?.(ref) ? ok('deadbeef') : fail('', 1);
    }
    return fail(`unexpected git call: ${args.join(' ')}`);
  };
}

describe('resolveBase', () => {
  it('--base always wins, no calls made', async () => {
    const runner = createFakeRunner({ az: () => fail('should not be called'), git: () => fail('should not be called') });
    const result = await resolveBase(runner, CTX, 'fix/200', 'develop', undefined);
    expect(result).toEqual({ ref: 'develop', source: 'flag' });
  });

  it('uses the active PR target when one exists', async () => {
    const runner = createFakeRunner({ az: () => okJson([pr('refs/heads/release/1.0')]) });
    const result = await resolveBase(runner, CTX, 'fix/200', undefined, undefined);
    expect(result).toEqual({ ref: 'release/1.0', source: 'pr-target' });
  });

  it('falls back to origin/HEAD when no PR exists', async () => {
    const runner = createFakeRunner({
      az: () => okJson([]),
      git: (args) => (args[0] === 'symbolic-ref' ? ok('origin/main') : fail()),
    });
    const result = await resolveBase(runner, CTX, 'fix/200', undefined, undefined);
    expect(result).toEqual({ ref: 'main', source: 'origin-head' });
  });

  it('falls back to `az repos show`s defaultBranch when origin/HEAD is unset', async () => {
    const runner = createFakeRunner({
      az: (args) => {
        if (args[0] === 'repos' && args[1] === 'pr') return okJson([]);
        if (args[0] === 'repos' && args[1] === 'show') return okJson({ id: 'r1', name: 'my-repo', defaultBranch: 'refs/heads/main' } satisfies AzGitRepository);
        return fail(`unexpected az call: ${args.join(' ')}`);
      },
      git: () => fail('', 1),
    });
    const result = await resolveBase(runner, CTX, 'fix/200', undefined, undefined);
    expect(result).toEqual({ ref: 'main', source: 'repo-default' });
  });

  it('skips the PR lookup entirely when there is no repo in context', async () => {
    const runner = createFakeRunner({
      az: () => fail('should not be called — no repo to look up a PR for'),
      git: (args) => (args[0] === 'symbolic-ref' ? ok('origin/main') : fail()),
    });
    const result = await resolveBase(runner, CTX_NO_REPO, 'fix/200', undefined, undefined);
    expect(result).toEqual({ ref: 'main', source: 'origin-head' });
  });

  it('throws UserError when nothing resolves', async () => {
    const runner = createFakeRunner({ az: () => okJson([]), git: () => fail('', 1) });
    await expect(resolveBase(runner, CTX, 'fix/200', undefined, undefined)).rejects.toBeInstanceOf(UserError);
  });
});

describe('resolveDiffableRef', () => {
  it('prefers the remote-tracking ref when it resolves', async () => {
    const runner = createFakeRunner({ git: gitFor({ verify: (ref) => ref === 'origin/main' }) });
    expect(await resolveDiffableRef(runner, 'main', undefined)).toBe('origin/main');
  });

  it('falls back to the local ref when the remote one does not resolve', async () => {
    const runner = createFakeRunner({ git: gitFor({ verify: (ref) => ref === 'main' }) });
    expect(await resolveDiffableRef(runner, 'main', undefined)).toBe('main');
  });

  it('throws when neither resolves', async () => {
    const runner = createFakeRunner({ git: gitFor({ verify: () => false }) });
    await expect(resolveDiffableRef(runner, 'main', undefined)).rejects.toBeInstanceOf(UserError);
  });
});

describe('gatherSummary', () => {
  function fullRunner(opts: {
    workitems?: string;
    primary?: string;
    logOutput?: string;
    statOutput?: string;
  } = {}) {
    return createFakeRunner({
      git: (args) => {
        if (args[0] === 'rev-parse' && args.includes('--verify') && args[args.length - 1] === 'refs/heads/fix/200') return ok('deadbeef');
        if (args[0] === 'config' && args.includes('--get')) {
          const key = args[args.length - 1]!;
          if (key === 'branch.fix/200.dova-workitems') return opts.workitems !== undefined ? ok(opts.workitems) : fail('', 1);
          if (key === 'branch.fix/200.dova-primary') return opts.primary !== undefined ? ok(opts.primary) : fail('', 1);
          return fail('', 1);
        }
        if (args[0] === 'rev-parse' && args.includes('--verify') && args[args.length - 1] === 'origin/develop') return ok('deadbeef');
        if (args[0] === 'log') return ok(opts.logOutput ?? '');
        if (args[0] === 'diff' && args.includes('--stat')) return ok(opts.statOutput ?? '');
        if (args[0] === 'diff') return ok('full diff text');
        return fail(`unexpected git call: ${args.join(' ')}`);
      },
      az: (args) => (args.join(' ').startsWith('boards query') ? okJson([item(200, 'Fix the bug', '<p>Root cause: null check</p>')]) : fail()),
    });
  }

  it('builds a full catch-up report for a linked branch', async () => {
    const runner = fullRunner({
      workitems: '200',
      primary: '200',
      logOutput: 'abc123\tFix the null check\ndef456\tAdd a test',
      statOutput: ' src/parser.ts | 4 +++-\n 1 file changed',
    });

    const result = await gatherSummary(runner, 'fix/200', { org: 'contoso', project: 'MyProject', base: 'develop' });

    expect(result.branch).toBe('fix/200');
    expect(result.base).toBe('origin/develop');
    expect(result.baseSource).toBe('flag');
    expect(result.workItems).toEqual([
      { id: 200, type: 'Bug', state: 'Active', title: 'Fix the bug', description: 'Root cause: null check', primary: true },
    ]);
    expect(result.commits).toEqual([
      { sha: 'abc123', subject: 'Fix the null check' },
      { sha: 'def456', subject: 'Add a test' },
    ]);
    expect(result.diffStat).toContain('src/parser.ts');
    expect(result.fullLog).toBeUndefined();
  });

  it('works with no linked work items — no az call made', async () => {
    let azCalled = false;
    const runner = fullRunner({});
    const runnerNoAz = { ...runner, az: async (args: string[]) => { azCalled = true; return runner.az(args); } };

    const result = await gatherSummary(runnerNoAz, 'fix/200', { org: 'contoso', project: 'MyProject', base: 'develop' });

    expect(result.workItems).toEqual([]);
    expect(azCalled).toBe(false);
  });

  it('--full also fetches the full log and full diff', async () => {
    const runner = fullRunner({ workitems: '200', primary: '200' });
    const result = await gatherSummary(runner, 'fix/200', { org: 'contoso', project: 'MyProject', base: 'develop' }, { full: true });
    expect(result.fullLog).toBeDefined();
    expect(result.fullDiff).toBe('full diff text');
  });

  it('throws NotFoundError for a branch that does not exist locally or on origin', async () => {
    const runner = createFakeRunner({ git: () => fail('', 1) });
    await expect(gatherSummary(runner, 'no-such-branch', { org: 'contoso', project: 'MyProject' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('fetches a branch that only exists on origin, then diffs against the fetched ref', async () => {
    let fetchedInto: string | undefined;
    const runner = createFakeRunner({
      git: (args) => {
        if (args[0] === 'rev-parse' && args.includes('--verify') && args[args.length - 1] === 'refs/heads/feature/other') return fail('', 1);
        if (args[0] === 'rev-parse' && args.includes('--verify') && args[args.length - 1] === 'refs/remotes/origin/feature/other') return fail('', 1);
        if (args[0] === 'fetch' && args[1] === 'origin') {
          fetchedInto = args[2];
          return ok('');
        }
        if (args[0] === 'config' && args.includes('--get')) return fail('', 1);
        if (args[0] === 'rev-parse' && args.includes('--verify') && args[args.length - 1] === 'origin/develop') return ok('deadbeef');
        if (args[0] === 'log') return ok('abc123\tSome commit');
        if (args[0] === 'diff' && args.includes('--stat')) return ok(' a.ts | 1 +');
        return fail(`unexpected git call: ${args.join(' ')}`);
      },
      az: () => fail('should not be called — no linked work items'),
    });

    const result = await gatherSummary(runner, 'feature/other', { org: 'contoso', project: 'MyProject', base: 'develop' });

    expect(fetchedInto).toBe('feature/other:refs/remotes/origin/feature/other');
    expect(result.commits).toEqual([{ sha: 'abc123', subject: 'Some commit' }]);
    expect(result.diffStat).toContain('a.ts');
  });
});
