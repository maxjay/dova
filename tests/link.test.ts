import { describe, it, expect } from 'vitest';
import { runUnlink } from '../src/lib/link.js';
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
