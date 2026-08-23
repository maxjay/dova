import { describe, it, expect } from 'vitest';
import { colorizeDiff, colorizeDiffStat } from '../src/lib/output.js';
import type { ChalkInstance } from 'chalk';

const COLOR = {
  bold: (s: string) => `<b>${s}</b>`,
  dim: (s: string) => `<d>${s}</d>`,
  cyan: (s: string) => `<c>${s}</c>`,
  green: (s: string) => `<g>${s}</g>`,
  red: (s: string) => `<r>${s}</r>`,
} as unknown as ChalkInstance;

describe('colorizeDiff', () => {
  it('returns an empty string untouched', () => {
    expect(colorizeDiff('', COLOR)).toBe('');
  });

  it('colors each line by its diff role, same convention as git diff', () => {
    const patch = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      'index 1234567..89abcde 100644',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -85,6 +85,8 @@ export function checkSession(token: string | null) {',
      ' unchanged context line',
      '+  if (token === null) {',
      '-  return legacyCheck(token);',
    ].join('\n');

    expect(colorizeDiff(patch, COLOR).split('\n')).toEqual([
      '<d>diff --git a/src/auth.ts b/src/auth.ts</d>',
      '<d>index 1234567..89abcde 100644</d>',
      '<b>--- a/src/auth.ts</b>',
      '<b>+++ b/src/auth.ts</b>',
      '<c>@@ -85,6 +85,8 @@ export function checkSession(token: string | null) {</c>',
      ' unchanged context line',
      '<g>+  if (token === null) {</g>',
      '<r>-  return legacyCheck(token);</r>',
    ]);
  });
});

describe('colorizeDiffStat', () => {
  it('returns an empty string untouched', () => {
    expect(colorizeDiffStat('', COLOR)).toBe('');
  });

  it('colors only the trailing +/- bar, leaving the filename (even one containing a hyphen) alone', () => {
    const stat = [
      ' src/auth.ts | 4 +++-',
      ' src/my-file.ts | 2 +-',
      ' 2 files changed, 5 insertions(+), 1 deletion(-)',
    ].join('\n');

    expect(colorizeDiffStat(stat, COLOR).split('\n')).toEqual([
      ' src/auth.ts | 4 <g>+</g><g>+</g><g>+</g><r>-</r>',
      ' src/my-file.ts | 2 <g>+</g><r>-</r>',
      // no trailing bar on the summary line, so it's left exactly as-is —
      // in particular the hyphen in "my-file.ts" above is never touched.
      ' 2 files changed, 5 insertions(+), 1 deletion(-)',
    ]);
  });
});
