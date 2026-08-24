import { describe, it, expect } from 'vitest';
import { fetchTimeline, fetchLogText, failedRecords, fetchRecentRuns, type AzTimelineRecord } from '../src/lib/pipelines.js';
import { NotFoundError, ExternalCommandError } from '../src/lib/errors.js';
import { createFakeRunner, ok, okJson } from './fixtures/fake-runner.js';

const ORG_URL = 'https://dev.azure.com/contoso';
const PROJECT = 'MyProject';

function record(overrides: Partial<AzTimelineRecord>): AzTimelineRecord {
  return {
    id: 'r1',
    parentId: null,
    type: 'Task',
    name: 'Unnamed',
    state: 'completed',
    result: 'succeeded',
    ...overrides,
  };
}

describe('failedRecords', () => {
  it('keeps only failed records that have their own log', () => {
    const records = [
      record({ name: 'Build', type: 'Stage', result: 'failed' }), // rollup, no log of its own
      record({ name: 'Run tests', type: 'Task', result: 'failed', log: { id: 5 }, startTime: '2024-01-01T00:00:02Z' }),
      record({ name: 'Lint', type: 'Task', result: 'succeeded', log: { id: 4 }, startTime: '2024-01-01T00:00:01Z' }),
    ];

    expect(failedRecords(records).map((r) => r.name)).toEqual(['Run tests']);
  });

  it('orders failures by start time, earliest first', () => {
    const records = [
      record({ name: 'Second failure', type: 'Task', result: 'failed', log: { id: 2 }, startTime: '2024-01-01T00:05:00Z' }),
      record({ name: 'First failure', type: 'Task', result: 'failed', log: { id: 1 }, startTime: '2024-01-01T00:01:00Z' }),
    ];

    expect(failedRecords(records).map((r) => r.name)).toEqual(['First failure', 'Second failure']);
  });
});

describe('fetchTimeline', () => {
  it('returns the records array', async () => {
    const runner = createFakeRunner({ az: () => okJson({ records: [record({ name: 'A' })] }) });
    const records = await fetchTimeline(runner, ORG_URL, PROJECT, 42);
    expect(records).toEqual([record({ name: 'A' })]);
  });

  it('returns [] when the response has no records', async () => {
    const runner = createFakeRunner({ az: () => okJson(null) });
    expect(await fetchTimeline(runner, ORG_URL, PROJECT, 42)).toEqual([]);
  });

  it('throws NotFoundError for a run that does not exist', async () => {
    // Mirrors what defaultRunner.az actually does on a nonzero az exit
    // (interpretAzFailure, in exec.ts) — the fake runner here doesn't
    // replicate that exit-code-to-throw translation itself, so the test
    // throws directly with the same kind of message az would produce.
    const runner = createFakeRunner({
      az: () => {
        throw new ExternalCommandError('az exited with code 1:\nTF401180: Build 999 does not exist.');
      },
    });
    await expect(fetchTimeline(runner, ORG_URL, PROJECT, 999)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('fetchLogText', () => {
  it('returns the raw log text', async () => {
    const runner = createFakeRunner({ az: () => ok('line one\nline two\nBuild FAILED') });
    const text = await fetchLogText(runner, ORG_URL, PROJECT, 42, 7);
    expect(text).toBe('line one\nline two\nBuild FAILED');
  });
});

describe('fetchRecentRuns branch filtering', () => {
  function runsRunner(runs: unknown[], seen: string[][] = []) {
    return createFakeRunner({
      az: (args) => {
        seen.push(args);
        return okJson(runs);
      },
    });
  }

  it('drops runs whose sourceBranch is a different ref', async () => {
    const runner = runsRunner([
      { id: 1, buildNumber: '1', status: 'completed', result: 'succeeded', sourceBranch: 'refs/heads/main', url: '' },
      { id: 2, buildNumber: '2', status: 'completed', result: 'failed', sourceBranch: 'refs/heads/feature/x', url: '' },
      { id: 3, buildNumber: '3', status: 'completed', result: 'succeeded', sourceBranch: 'refs/pull/99/merge', url: '' },
    ]);

    const runs = await fetchRecentRuns(runner, ORG_URL, PROJECT, 'feature/x');

    // A run for another ref shown under this branch reads as this
    // branch's CI and isn't — worse than showing nothing.
    expect(runs.map((r) => r.id)).toEqual([2]);
  });

  it('matches a branch name containing slashes', async () => {
    const runner = runsRunner([
      { id: 1, buildNumber: '1', status: 'completed', result: 'succeeded', sourceBranch: 'refs/heads/integration/teams-upstream', url: '' },
    ]);
    const runs = await fetchRecentRuns(runner, ORG_URL, PROJECT, 'integration/teams-upstream');
    expect(runs).toHaveLength(1);
  });

  it('keeps runs that report no sourceBranch at all rather than silently dropping them', async () => {
    const runner = runsRunner([{ id: 1, buildNumber: '1', status: 'completed', result: 'succeeded', url: '' }]);
    expect(await fetchRecentRuns(runner, ORG_URL, PROJECT, 'feature/x')).toHaveLength(1);
  });

  it('over-fetches so filtering still returns the number asked for', async () => {
    const seen: string[][] = [];
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: i, buildNumber: String(i), status: 'completed', result: 'succeeded',
      sourceBranch: i % 2 === 0 ? 'refs/heads/feature/x' : 'refs/heads/main', url: '',
    }));
    const runner = runsRunner(many, seen);

    const runs = await fetchRecentRuns(runner, ORG_URL, PROJECT, 'feature/x', 3);

    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.sourceBranch === 'refs/heads/feature/x')).toBe(true);
    // Asked az for more than 3, or the filter would leave fewer.
    expect(Number(seen[0]![seen[0]!.indexOf('--top') + 1])).toBeGreaterThan(3);
  });
});
