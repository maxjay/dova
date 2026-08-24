import { describe, it, expect } from 'vitest';
import { gatherStatus } from '../src/commands/status.js';
import { createFakeRunner, ok, okJson, fail } from './fixtures/fake-runner.js';

/* ------------------------------------------------------------------ *
 * `dova status` answers four questions, but only two of them depend on
 * knowing whether a PR exists. Since every `az` invocation starts a
 * Python interpreter (~2-3s on Windows before any network), the number
 * of *sequential* calls is what this command's latency is made of.
 * These assert the scheduling, not just the result — a re-serialized
 * version would still return the same status.
 * ------------------------------------------------------------------ */

function statusRunner(events: string[], opts: { pr?: boolean } = {}) {
  const withPr = opts.pr ?? true;
  return createFakeRunner({
    git: (args) => {
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) return ok('true');
      if (args[0] === 'remote') return ok('https://dev.azure.com/contoso/MyProject/_git/my-repo');
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return ok('fix/200');
      if (args[0] === 'config') return fail('', 1);
      return fail(`unexpected git call: ${args.join(' ')}`);
    },
    az: async (args) => {
      const joined = args.join(' ');
      const kind = joined.includes('repos pr list')
        ? 'pr'
        : joined.includes('build') || joined.includes('pipelines')
          ? // The branch query and the PR build-validation query are both
            // `pipelines runs list`; only the ref tells them apart.
            joined.includes('refs/pull')
            ? 'prruns'
            : 'runs'
          : joined.includes('work-item')
            ? 'workitems'
            : 'threads';
      events.push(`start:${kind}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end:${kind}`);

      if (kind === 'pr') {
        return okJson(
          withPr
            ? [
                {
                  pullRequestId: 612,
                  title: 'A PR',
                  status: 'active',
                  createdBy: { displayName: 'Jane' },
                  creationDate: '2026-01-01T00:00:00Z',
                  sourceRefName: 'refs/heads/fix/200',
                  targetRefName: 'refs/heads/main',
                  url: '',
                },
              ]
            : []
        );
      }
      if (kind === 'threads') return okJson({ value: [] });
      return okJson([]);
    },
  });
}

describe('gatherStatus call scheduling', () => {
  it('looks up the PR and the pipeline runs together — runs need only the branch', async () => {
    const events: string[] = [];
    await gatherStatus({ color: true } as never, undefined, statusRunner(events));

    // The first two calls overlap: neither waited for the other.
    expect(events[0]!.startsWith('start:')).toBe(true);
    expect(events[1]!.startsWith('start:')).toBe(true);
    expect(new Set([events[0], events[1]])).toEqual(new Set(['start:pr', 'start:runs']));
  });

  it('then fetches work items, threads and the PR validation runs together', async () => {
    const events: string[] = [];
    await gatherStatus({ color: true } as never, undefined, statusRunner(events));

    // Three calls need the PR id: its work items, its threads, and the
    // build-validation runs (which report refs/pull/<id>/merge, so the
    // branch query in wave 1 never returns them). All three go at once.
    // Only these three depend on the PR; wave 1's branch-runs call may
    // still be in flight and finish among them, which is fine.
    const wave2 = ['workitems', 'threads', 'prruns'];
    const own = events.filter((e) => wave2.some((k) => e.endsWith(`:${k}`)));

    expect(own.filter((e) => e.startsWith('start:'))).toHaveLength(3);
    // All three started before any of the three finished.
    expect(own.slice(0, 3).every((e) => e.startsWith('start:'))).toBe(true);
  });

  it('makes no work-item or thread call at all when there is no PR and nothing linked', async () => {
    const events: string[] = [];
    await gatherStatus({ color: true } as never, undefined, statusRunner(events, { pr: false }));

    expect(events.filter((e) => e === 'start:workitems')).toHaveLength(0);
    expect(events.filter((e) => e === 'start:threads')).toHaveLength(0);
  });
});
