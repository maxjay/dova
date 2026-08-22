import { describe, it, expect } from 'vitest';
import { looksLikeUrl, parseIdArgument, parseWorkItemUrl, parsePrUrl } from '../src/lib/urls.js';

describe('looksLikeUrl', () => {
  it('is true for http(s) urls', () => {
    expect(looksLikeUrl('https://dev.azure.com/contoso/MyProject/_workitems/edit/123')).toBe(true);
    expect(looksLikeUrl('http://dev.azure.com/x')).toBe(true);
  });

  it('is false for a bare id or anything else', () => {
    expect(looksLikeUrl('123')).toBe(false);
    expect(looksLikeUrl('MyProject')).toBe(false);
  });
});

describe('parseIdArgument', () => {
  it('parses a bare positive integer', () => {
    expect(parseIdArgument('123')).toBe(123);
    expect(parseIdArgument('  42 ')).toBe(42);
  });

  it('rejects zero, negatives, and non-numeric input', () => {
    expect(parseIdArgument('0')).toBeNull();
    expect(parseIdArgument('-5')).toBeNull();
    expect(parseIdArgument('12a')).toBeNull();
    expect(parseIdArgument('https://example.com')).toBeNull();
  });
});

describe('parseWorkItemUrl', () => {
  it('parses the "edit" browser URL form', () => {
    expect(parseWorkItemUrl('https://dev.azure.com/contoso/MyProject/_workitems/edit/456')).toEqual({
      org: 'contoso',
      orgUrl: 'https://dev.azure.com/contoso',
      project: 'MyProject',
      id: 456,
    });
  });

  it("parses dova's own generated query-string form", () => {
    expect(parseWorkItemUrl('https://dev.azure.com/contoso/MyProject/_workitems?id=456')).toEqual({
      org: 'contoso',
      orgUrl: 'https://dev.azure.com/contoso',
      project: 'MyProject',
      id: 456,
    });
  });

  it('handles a project name with spaces', () => {
    expect(parseWorkItemUrl('https://dev.azure.com/contoso/My%20Project/_workitems/edit/456')?.project).toBe('My Project');
  });

  it('returns null for a PR link', () => {
    expect(parseWorkItemUrl('https://dev.azure.com/contoso/MyProject/_git/my-repo/pullrequest/42')).toBeNull();
  });

  it('returns null for an unrelated URL', () => {
    expect(parseWorkItemUrl('https://github.com/example/repo')).toBeNull();
  });
});

describe('parsePrUrl', () => {
  it('parses a modern PR URL', () => {
    expect(parsePrUrl('https://dev.azure.com/contoso/MyProject/_git/my-repo/pullrequest/42')).toEqual({
      org: 'contoso',
      orgUrl: 'https://dev.azure.com/contoso',
      project: 'MyProject',
      repo: 'my-repo',
      id: 42,
    });
  });

  it('returns null for a work item link', () => {
    expect(parsePrUrl('https://dev.azure.com/contoso/MyProject/_workitems/edit/456')).toBeNull();
  });
});
