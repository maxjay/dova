import { describe, it, expect } from 'vitest';
import {
  resolveThreadStatusInput,
  threadLocation,
  gatherThreadDetail,
  renderPrDetailHuman,
  THREAD_COMMENT_TRUNCATE,
} from '../src/lib/pr.js';
import { describeLostDescription } from '../src/commands/pr/create.js';
import { getColor } from '../src/lib/output.js';
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

/* ------------------------------------------------------------------ *
 * A description passed as a command-line argument does not survive
 * Windows reliably — the .cmd/.ps1 shim rebuilds the command line and
 * the body arrives empty or cut at the first newline. az reports success
 * either way, so dova has to check what came back.
 * ------------------------------------------------------------------ */

describe('describeLostDescription', () => {
  it('says nothing when the body came back intact', () => {
    expect(describeLostDescription('## Summary\nBody text', '## Summary\nBody text')).toBeNull();
  });

  it('ignores line-ending and trailing-whitespace normalization', () => {
    expect(describeLostDescription('## Summary\nBody', '## Summary\r\nBody\n')).toBeNull();
  });

  it('reports a body that vanished entirely', () => {
    expect(describeLostDescription('## Summary\nBody', '')).toContain('no description');
    expect(describeLostDescription('## Summary\nBody', undefined)).toContain('no description');
  });

  it('reports a body cut at the first newline', () => {
    const lost = describeLostDescription('## Summary\nBody text here', '## Summary');
    expect(lost).toContain('truncated');
    expect(lost).toContain('10 of 25');
  });

  it('stays quiet when nothing was sent', () => {
    expect(describeLostDescription(undefined, '')).toBeNull();
    expect(describeLostDescription('   ', '')).toBeNull();
  });

  it('does not cry wolf when the server returns something longer', () => {
    // Azure DevOps can append to a body; that is not a loss.
    expect(describeLostDescription('Body', 'Body\n\nRelated work items: #1')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Threads render as blocks, not table rows. A 60-character cell reduced
 * a Sonar finding to the opening of its badge URL, which forced a
 * `pr comment show` — another `az` start — on every single thread.
 * ------------------------------------------------------------------ */

describe('renderPrDetailHuman comment threads', () => {
  const base = {
    id: 612, title: 'Fix null check', isDraft: false, status: 'active', author: 'Max',
    sourceBranch: 'fix/1', targetBranch: 'main', url: 'https://example/612', workItems: [],
  };
  const longComment =
    '**[CWE-862 / OWASP A01]** Authorization check is performed after the dataset is loaded, ' +
    'so a user without the required permission still triggers the full query before being filtered.';

  function render(threads: unknown[], full = false): string {
    const out: string[] = [];
    const write = process.stdout.write;
    (process.stdout as { write: unknown }).write = (s: string) => { out.push(s); return true; };
    try {
      renderPrDetailHuman({ ...base, threads } as never, getColor(true), full);
    } finally {
      (process.stdout as { write: unknown }).write = write;
    }
    return out.join('');
  }

  const thread = (over: Record<string, unknown> = {}) => ({
    id: 4, unresolved: true, status: 'active', commentCount: 1, lastAuthor: 'Jane Doe',
    location: { file: '/src/auth.ts', line: 42 }, lastComment: longComment, ...over,
  });

  it('prints the whole comment rather than a truncated table cell', () => {
    const out = render([thread()]);
    expect(out).toContain(longComment);
    // The old rendering cut at 60 characters, losing the actual request.
    expect(out).not.toContain('…');
  });

  it('keeps a long file path whole instead of fitting it to a column', () => {
    const file = '/src/main/java/com/bfm/app/dashboard/module/atmcontrols/ATMControlsReloadStrategy.java';
    const out = render([thread({ location: { file, line: 42 } })]);
    expect(out).toContain(`${file}:42`);
  });

  it('names the exact follow-up command only when a thread has earlier comments', () => {
    expect(render([thread({ commentCount: 3 })])).toContain('dova pr comment show 612 4');
    expect(render([thread({ commentCount: 1 })])).not.toContain('pr comment show');
  });

  it('counts open and resolved threads in the heading', () => {
    const out = render([thread(), thread({ id: 5, unresolved: false, status: 'fixed' })]);
    expect(out).toContain('Comment Threads');
    expect(out).toContain('1 open, 1 resolved');
  });

  it('truncates only very long comments, and --full restores them', () => {
    const huge = 'x'.repeat(THREAD_COMMENT_TRUNCATE + 200);
    expect(render([thread({ lastComment: huge })])).toContain('truncated');
    expect(render([thread({ lastComment: huge })], true)).toContain(huge);
  });

  it('handles a thread with no comment text', () => {
    expect(render([thread({ lastComment: null })])).toContain('(no comment text)');
  });
});
