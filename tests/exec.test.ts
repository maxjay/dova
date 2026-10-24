import { describe, it, expect } from 'vitest';
import { resolveOrFetchBranchRef } from '../src/lib/exec.js';
import { NotFoundError } from '../src/lib/errors.js';
import { createFakeRunner, ok, fail } from './fixtures/fake-runner.js';

describe('resolveOrFetchBranchRef', () => {
  it('returns the bare branch name when it already exists locally, no fetch attempted', async () => {
    const runner = createFakeRunner({
      git: (args) => {
        if (args[0] === 'rev-parse' && args[args.length - 1] === 'refs/heads/feature/x') return ok('deadbeef');
        return fail('should not be called');
      },
    });
    expect(await resolveOrFetchBranchRef(runner, 'feature/x')).toBe('feature/x');
  });

  it('returns origin/<branch> when already fetched, no new fetch attempted', async () => {
    const runner = createFakeRunner({
      git: (args) => {
        if (args[0] === 'rev-parse' && args[args.length - 1] === 'refs/heads/feature/x') return fail('', 1);
        if (args[0] === 'rev-parse' && args[args.length - 1] === 'refs/remotes/origin/feature/x') return ok('deadbeef');
        if (args[0] === 'fetch') return fail('should not fetch — already resolved');
        return fail('unexpected');
      },
    });
    expect(await resolveOrFetchBranchRef(runner, 'feature/x')).toBe('origin/feature/x');
  });

  it('fetches from origin when the branch is not local and not already fetched', async () => {
    let fetchArgs: string[] | undefined;
    const runner = createFakeRunner({
      git: (args) => {
        if (args[0] === 'rev-parse') return fail('', 1);
        if (args[0] === 'fetch') {
          fetchArgs = args;
          return ok('');
        }
        return fail('unexpected');
      },
    });
    expect(await resolveOrFetchBranchRef(runner, 'feature/x')).toBe('origin/feature/x');
    expect(fetchArgs).toEqual(['fetch', 'origin', 'feature/x:refs/remotes/origin/feature/x']);
  });

  it('throws NotFoundError when the branch exists nowhere', async () => {
    const runner = createFakeRunner({ git: () => fail('fatal: couldn\'t find remote ref feature/ghost', 128) });
    await expect(resolveOrFetchBranchRef(runner, 'feature/ghost')).rejects.toBeInstanceOf(NotFoundError);
  });
});
