import { describe, it, expect } from 'vitest';
import { slugify, typeToConfigKey, buildBranchName, resolveBranchPrefix } from '../src/lib/branch-naming.js';
import { createFakeRunner, ok, fail } from './fixtures/fake-runner.js';

describe('slugify', () => {
  it('lowercases, dash-separates, and strips punctuation', () => {
    expect(slugify('Fix the login bug!')).toBe('fix-the-login-bug');
  });

  it('strips accents', () => {
    expect(slugify('Café crashes on export')).toBe('cafe-crashes-on-export');
  });

  it('collapses runs of non-alphanumeric characters into one dash', () => {
    expect(slugify('a---b   c///d')).toBe('a-b-c-d');
  });

  it('caps length and never leaves a trailing dash', () => {
    const long = 'a'.repeat(80);
    const result = slugify(long);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith('-')).toBe(false);
  });
});

describe('typeToConfigKey', () => {
  it('turns a multi-word type name into a dash-separated key', () => {
    expect(typeToConfigKey('Product Backlog Item')).toBe('product-backlog-item');
  });

  it('lowercases a single-word type', () => {
    expect(typeToConfigKey('Bug')).toBe('bug');
  });
});

describe('buildBranchName', () => {
  it('joins prefix, id, and slug', () => {
    expect(buildBranchName('bugfix', 123, 'fix-the-thing')).toBe('bugfix/123-fix-the-thing');
  });

  it('omits the slug segment when there is no slug', () => {
    expect(buildBranchName('feature', 42, '')).toBe('feature/42');
  });
});

describe('resolveBranchPrefix', () => {
  it('uses a configured per-type prefix when set', async () => {
    const runner = createFakeRunner({
      git: (args) => (args.join(' ') === 'config --global --get dova.branch-prefix.bug' ? ok('fix') : fail()),
    });
    expect(await resolveBranchPrefix(runner, 'Bug')).toBe('fix');
  });

  it('falls back to the configured default prefix when the type has none', async () => {
    const runner = createFakeRunner({
      git: (args) => {
        const joined = args.join(' ');
        if (joined === 'config --global --get dova.branch-prefix.task') return fail();
        if (joined === 'config --global --get dova.branch-prefix.default') return ok('work');
        return fail();
      },
    });
    expect(await resolveBranchPrefix(runner, 'Task')).toBe('work');
  });

  it('falls back to the built-in default (Bug -> bugfix) when nothing is configured', async () => {
    const runner = createFakeRunner({ git: () => fail() });
    expect(await resolveBranchPrefix(runner, 'Bug')).toBe('bugfix');
  });

  it('falls back to the built-in default ("feature") for any other type when nothing is configured', async () => {
    const runner = createFakeRunner({ git: () => fail() });
    expect(await resolveBranchPrefix(runner, 'User Story')).toBe('feature');
  });
});
