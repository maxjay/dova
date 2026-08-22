import { describe, it, expect } from 'vitest';
import { gatherLinkedBranches } from '../src/commands/list.js';
import { createFakeRunner, ok, okJson, fail } from './fixtures/fake-runner.js';
import type { AzWorkItem } from '../src/types/azure-devops.js';
import type { ResolvedContext } from '../src/lib/context.js';

const CTX: ResolvedContext = { org: 'contoso', orgUrl: 'https://dev.azure.com/contoso', project: 'MyProject', repo: 'my-repo', source: 'git-remote' };

function item(id: number, title: string): AzWorkItem {
  return { id, url: '', fields: { 'System.Title': title } };
}

describe('gatherLinkedBranches', () => {
  it('returns [] when no branch has a dova link', async () => {
    const runner = createFakeRunner({ git: () => fail('', 1) });
    expect(await gatherLinkedBranches(runner, CTX)).toEqual([]);
  });

  it('parses branch/workitems/primary out of one combined --get-regexp call, sorted most-recent-first', async () => {
    const runner = createFakeRunner({
      git: (args) => {
        if (args[0] === 'config' && args.includes('--get-regexp')) {
          return ok(
            [
              'branch.fix/200-bug.dova-workitems 200,205',
              'branch.fix/200-bug.dova-primary 200',
              'branch.feature/300-thing.dova-workitems 300',
            ].join('\n')
          );
        }
        if (args[0] === 'for-each-ref') {
          return ok(['fix/200-bug\t2024-01-02T00:00:00+00:00', 'feature/300-thing\t2024-01-05T00:00:00+00:00'].join('\n'));
        }
        return fail(`unexpected git call: ${args.join(' ')}`);
      },
      az: (args) => (args.join(' ').startsWith('boards query') ? okJson([item(200, 'Fix the bug'), item(205, 'Sub task'), item(300, 'New thing')]) : fail()),
    });

    const branches = await gatherLinkedBranches(runner, CTX);

    expect(branches.map((b) => b.branch)).toEqual(['feature/300-thing', 'fix/200-bug']);
    expect(branches[0]).toEqual({ branch: 'feature/300-thing', lastActivity: '2024-01-05T00:00:00+00:00', primaryId: 300, primaryTitle: 'New thing', otherIds: [] });
    expect(branches[1]).toEqual({
      branch: 'fix/200-bug',
      lastActivity: '2024-01-02T00:00:00+00:00',
      primaryId: 200,
      primaryTitle: 'Fix the bug',
      otherIds: [205],
    });
  });

  it('falls back to the first id as primary when dova-primary is missing or stale', async () => {
    const runner = createFakeRunner({
      git: (args) => {
        if (args[0] === 'config' && args.includes('--get-regexp')) {
          return ok('branch.no-primary.dova-workitems 400,401');
        }
        if (args[0] === 'for-each-ref') return fail('', 1);
        return fail(`unexpected git call: ${args.join(' ')}`);
      },
      az: () => okJson([item(400, 'A'), item(401, 'B')]),
    });

    const branches = await gatherLinkedBranches(runner, CTX);
    expect(branches[0]!.primaryId).toBe(400);
    expect(branches[0]!.lastActivity).toBeNull();
  });

  it('makes exactly one batched work item fetch regardless of branch count', async () => {
    let azCalls = 0;
    const runner = createFakeRunner({
      git: (args) => {
        if (args[0] === 'config' && args.includes('--get-regexp')) {
          return ok(['branch.a.dova-workitems 1', 'branch.b.dova-workitems 2', 'branch.c.dova-workitems 3'].join('\n'));
        }
        return fail('', 1);
      },
      az: () => {
        azCalls++;
        return okJson([item(1, 'A'), item(2, 'B'), item(3, 'C')]);
      },
    });

    await gatherLinkedBranches(runner, CTX);
    expect(azCalls).toBe(1);
  });
});
