import { describe, it, expect, afterEach } from 'vitest';
import { runUnlink, runLink } from '../src/lib/link.js';
import { setNonInteractive } from '../src/lib/interactive.js';
import { UserError, NotFoundError } from '../src/lib/errors.js';
import { createFakeRunner, ok, okJson, fail } from './fixtures/fake-runner.js';
import type { AzWorkItem } from '../src/types/azure-devops.js';

const COLOR = { bold: (s: string) => s, dim: (s: string) => s, cyan: (s: string) => s, yellow: (s: string) => s, green: (s: string) => s } as any;

function item(id: number, title: string): AzWorkItem {
  return { id, url: '', fields: { 'System.Title': title, 'System.WorkItemType': 'Bug' } };
}

/** git handler for a branch "fix/200" with tracked ids/primary, supporting --unset and re-set. */
function gitFor(opts: { workitems?: string; primary?: string; sets?: Record<string, string>; unset?: string[] } = {}) {
  const sets = opts.sets ?? {};
  const unset = opts.unset ?? [];
  return (args: string[]) => {
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return ok('fix/200');
    if (args[0] === 'config' && args.includes('--get')) {
      const key = args[args.length - 1]!;
      if (key === 'branch.fix/200.dova-workitems') return opts.workitems !== undefined ? ok(opts.workitems) : fail('', 1);
      if (key === 'branch.fix/200.dova-primary') return opts.primary !== undefined ? ok(opts.primary) : fail('', 1);
      return fail('', 1);
    }
    if (args[0] === 'config' && args.includes('--unset')) {
      unset.push(args[args.length - 1]!);
      return ok('');
    }
    if (args[0] === 'config') {
      const [, key, value] = args;
      if (key && value !== undefined) sets[key] = value;
      return ok('');
    }
    return fail(`unexpected git call: ${args.join(' ')}`);
  };
}

describe('runUnlink', () => {
  it('removes one id, keeps the rest, keeps the existing primary if still linked', async () => {
    const sets: Record<string, string> = {};
    const runner = createFakeRunner({
      git: gitFor({ workitems: '200,201,202', primary: '201', sets }),
      az: () => okJson([item(200, 'A'), item(202, 'C')]),
    });

    const result = await runUnlink({ ids: ['201'], runner, org: 'contoso', project: 'MyProject', color: COLOR });

    expect(result.removedIds).toEqual([201]);
    expect(sets['branch.fix/200.dova-workitems']).toBe('200,202');
    // primary was removed, and wasn't re-specified -> falls back to the first remaining id
    expect(sets['branch.fix/200.dova-primary']).toBe('200');
    expect(result.workItems).toEqual([
      { id: 200, title: 'A', type: 'Bug', primary: true },
      { id: 202, title: 'C', type: 'Bug', primary: false },
    ]);
  });

  it('keeps the existing primary when it is not the id being removed', async () => {
    const sets: Record<string, string> = {};
    const runner = createFakeRunner({
      git: gitFor({ workitems: '200,201,202', primary: '200', sets }),
      az: () => okJson([item(200, 'A'), item(202, 'C')]),
    });

    await runUnlink({ ids: ['201'], runner, org: 'contoso', project: 'MyProject', color: COLOR });

    expect(sets['branch.fix/200.dova-primary']).toBe('200');
  });

  it('--all clears every linked id and unsets both git config keys', async () => {
    const unset: string[] = [];
    const runner = createFakeRunner({
      git: gitFor({ workitems: '200,201', primary: '200', unset }),
      az: () => fail('should not be called — nothing left to hydrate'),
    });

    const result = await runUnlink({ ids: [], all: true, runner, org: 'contoso', project: 'MyProject', color: COLOR });

    expect(result.removedIds).toEqual([200, 201]);
    expect(result.workItems).toEqual([]);
    expect(unset).toEqual(['branch.fix/200.dova-workitems', 'branch.fix/200.dova-primary']);
  });

  it('warns (not errors) about ids that were requested but are not currently linked', async () => {
    const sets: Record<string, string> = {};
    const runner = createFakeRunner({
      git: gitFor({ workitems: '200,201', primary: '200', sets }),
      az: () => okJson([item(200, 'A')]),
    });

    const result = await runUnlink({ ids: ['201', '999'], runner, org: 'contoso', project: 'MyProject', color: COLOR });

    expect(result.removedIds).toEqual([201]);
    expect(result.warnings[0]).toMatch(/#999/);
  });

  it('--primary picks a specific id to keep as primary among what remains', async () => {
    const sets: Record<string, string> = {};
    const runner = createFakeRunner({
      git: gitFor({ workitems: '200,201,202', primary: '200', sets }),
      az: () => okJson([item(201, 'B'), item(202, 'C')]),
    });

    await runUnlink({ ids: ['200'], primary: '202', runner, org: 'contoso', project: 'MyProject', color: COLOR });

    expect(sets['branch.fix/200.dova-primary']).toBe('202');
  });

  it('throws UserError when --primary is not among the remaining ids', async () => {
    const runner = createFakeRunner({ git: gitFor({ workitems: '200,201', primary: '200' }) });
    await expect(
      runUnlink({ ids: ['201'], primary: '201', runner, org: 'contoso', project: 'MyProject', color: COLOR })
    ).rejects.toBeInstanceOf(UserError);
  });

  it('throws NotFoundError when the branch has nothing linked at all', async () => {
    const runner = createFakeRunner({ git: gitFor({}) });
    await expect(runUnlink({ ids: ['200'], runner, org: 'contoso', project: 'MyProject', color: COLOR })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws UserError when none of the requested ids are actually linked', async () => {
    const runner = createFakeRunner({ git: gitFor({ workitems: '200', primary: '200' }) });
    await expect(runUnlink({ ids: ['999'], runner, org: 'contoso', project: 'MyProject', color: COLOR })).rejects.toBeInstanceOf(UserError);
  });

  it('throws UserError when called with no ids and no --all', async () => {
    const runner = createFakeRunner({ git: gitFor({}) });
    await expect(runUnlink({ ids: [], runner, org: 'contoso', project: 'MyProject', color: COLOR })).rejects.toBeInstanceOf(UserError);
  });

  it('throws UserError on detached HEAD', async () => {
    const runner = createFakeRunner({
      git: (args) => (args[0] === 'rev-parse' && args.includes('--abbrev-ref') ? ok('HEAD') : fail('', 1)),
    });
    await expect(runUnlink({ ids: ['200'], runner, org: 'contoso', project: 'MyProject', color: COLOR })).rejects.toBeInstanceOf(UserError);
  });
});

/* ------------------------------------------------------------------ *
 * Non-interactive behaviour — the prompts dova can't show when there's
 * no terminal (an agent, CI, a pipe). These deliberately do NOT inject
 * `prompts`, so the real defaults are exercised.
 * ------------------------------------------------------------------ */

describe('runLink without a terminal', () => {
  afterEach(() => setNonInteractive(false));

  function linkRunner(gitCalls: string[][]) {
    return createFakeRunner({
      git: (args) => {
        gitCalls.push(args);
        if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return ok('true');
        if (args[0] === 'remote') return ok('https://dev.azure.com/contoso/MyProject/_git/my-repo');
        if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return ok('fix/200');
        // #200 is already linked on a *different* branch.
        if (args[0] === 'config' && args.includes('--get-regexp')) return ok('branch.other/branch.dova-workitems 200');
        if (args[0] === 'config') return ok('');
        if (args[0] === 'checkout') return ok('');
        return fail(`unexpected git call: ${args.join(' ')}`);
      },
      az: (args) => {
        const joined = args.join(' ');
        // Both the seed fetch and the children lookup are `boards query`;
        // only the children one filters on System.Parent.
        if (joined.includes('System.Parent')) return okJson([]);
        return okJson([item(200, 'A')]);
      },
    });
  }

  it('never checks out another branch unasked — the confirm defaults to yes interactively, but must not here', async () => {
    setNonInteractive(true);
    const gitCalls: string[][] = [];
    const result = await runLink({
      ids: ['200'],
      runner: linkRunner(gitCalls),
      org: 'contoso',
      project: 'MyProject',
      color: COLOR,
    });

    // Silently moving the working tree out from under a running agent is
    // the one thing this must never do.
    expect(gitCalls.some((c) => c[0] === 'checkout')).toBe(false);
    expect(result.branch).toBe('fix/200');
    expect(result.switchedToExisting).toBeFalsy();
  });
});
