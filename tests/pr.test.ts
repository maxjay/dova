import { describe, it, expect } from 'vitest';
import { resolveThreadStatusInput, threadLocation, gatherThreadDetail } from '../src/lib/pr.js';
import { UserError } from '../src/lib/errors.js';
import { createFakeRunner, okJson, fail } from './fixtures/fake-runner.js';
import type { AzCommentThread } from '../src/types/azure-devops.js';

const ORG_URL = 'https://dev.azure.com/contoso';
const PROJECT = 'MyProject';
const REPO = 'my-repo';

describe('resolveThreadStatusInput', () => {
  it('maps "resolved" (and "resolve") to the API\'s "fixed" value', () => {
    expect(resolveThreadStatusInput('resolved')).toBe('fixed');
    expect(resolveThreadStatusInput('resolve')).toBe('fixed');
    expect(resolveThreadStatusInput('Resolved')).toBe('fixed');
  });

  it('accepts the raw API term "fixed" directly', () => {
    expect(resolveThreadStatusInput('fixed')).toBe('fixed');
  });

  it('maps "won\'t fix" in any punctuation/casing to "wontFix"', () => {
    expect(resolveThreadStatusInput("won't fix")).toBe('wontFix');
    expect(resolveThreadStatusInput('wontfix')).toBe('wontFix');
    expect(resolveThreadStatusInput('Wont-Fix')).toBe('wontFix');
  });

  it('passes through active/closed/pending', () => {
    expect(resolveThreadStatusInput('active')).toBe('active');
    expect(resolveThreadStatusInput('closed')).toBe('closed');
    expect(resolveThreadStatusInput('pending')).toBe('pending');
  });

  it('throws a clear error for an unknown status', () => {
    expect(() => resolveThreadStatusInput('bogus')).toThrow(UserError);
  });
});

function baseThread(overrides: Partial<AzCommentThread> = {}): AzCommentThread {
  return { id: 1, status: 'active', comments: [], ...overrides };
}

describe('threadLocation', () => {
  it('returns null for a general comment with no threadContext', () => {
    expect(threadLocation(baseThread())).toBeNull();
  });

  it('prefers the right-file (proposed version) line', () => {
    const thread = baseThread({
      threadContext: { filePath: '/src/auth.ts', rightFileStart: { line: 42 }, leftFileStart: { line: 40 } },
    });
    expect(threadLocation(thread)).toEqual({ file: '/src/auth.ts', line: 42 });
  });

  it('falls back to the left-file line for a comment only the base side has (e.g. a deleted line)', () => {
    const thread = baseThread({ threadContext: { filePath: '/src/old.ts', leftFileStart: { line: 7 } } });
    expect(threadLocation(thread)).toEqual({ file: '/src/old.ts', line: 7 });
  });

  it('returns null when threadContext has a file but no position at all', () => {
    const thread = baseThread({ threadContext: { filePath: '/src/auth.ts' } });
    expect(threadLocation(thread)).toBeNull();
  });
});

describe('gatherThreadDetail', () => {
  it('returns every comment in order, plus status and location', async () => {
    const runner = createFakeRunner({
      az: (args) =>
        args.join(' ').includes('/threads/4?api-version=7.1')
          ? okJson({
              id: 4,
              status: 'active',
              threadContext: { filePath: '/src/auth.ts', rightFileStart: { line: 42 } },
              comments: [
                { id: 1, content: 'Fix this cognitive complexity issue.', author: { displayName: 'SonarQube' }, publishedDate: '2026-08-22T10:00:00Z', commentType: 'text' },
                { id: 2, content: 'Can you also handle the null case?', author: { displayName: 'Jane Doe' }, publishedDate: '2026-08-22T10:15:00Z', commentType: 'text' },
              ],
            })
          : fail(`unexpected az call: ${args.join(' ')}`),
    });

    const detail = await gatherThreadDetail(runner, ORG_URL, PROJECT, REPO, 612, 4);

    expect(detail).toEqual({
      id: 4,
      prId: 612,
      status: 'active',
      unresolved: true,
      location: { file: '/src/auth.ts', line: 42 },
      comments: [
        { id: 1, author: 'SonarQube', publishedDate: '2026-08-22T10:00:00Z', content: 'Fix this cognitive complexity issue.', commentType: 'text' },
        { id: 2, author: 'Jane Doe', publishedDate: '2026-08-22T10:15:00Z', content: 'Can you also handle the null case?', commentType: 'text' },
      ],
    });
  });
});
