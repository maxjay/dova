import { describe, it, expect } from 'vitest';
import { fetchTimeline, fetchLogText, failedRecords, type AzTimelineRecord } from '../src/lib/pipelines.js';
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
