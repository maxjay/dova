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
          ? 'runs'
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

  it('then fetches the PR work items and its comment threads together', async () => {
    const events: string[] = [];
    await gatherStatus({ color: true } as never, undefined, statusRunner(events));

    const secondWave = events.slice(events.indexOf('end:pr') + 1).filter((e) => e.startsWith('start:'));
    expect(secondWave).toHaveLength(2);
    // Both of the PR-dependent calls started before either finished.
    const firstEnd = events.findIndex((e) => e === 'end:workitems' || e === 'end:threads');
    const startsBeforeFirstEnd = events.slice(0, firstEnd).filter((e) => e === 'start:workitems' || e === 'start:threads');
    expect(startsBeforeFirstEnd).toHaveLength(2);
  });

  it('makes no work-item or thread call at all when there is no PR and nothing linked', async () => {
    const events: string[] = [];
    await gatherStatus({ color: true } as never, undefined, statusRunner(events, { pr: false }));

    expect(events.filter((e) => e === 'start:workitems')).toHaveLength(0);
    expect(events.filter((e) => e === 'start:threads')).toHaveLength(0);
  });
});
