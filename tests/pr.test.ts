import { describe, it, expect } from 'vitest';
import { resolveThreadStatusInput } from '../src/lib/pr.js';
import { UserError } from '../src/lib/errors.js';

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
