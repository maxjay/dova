import { describe, it, expect } from 'vitest';
import { buildApiUrl } from '../src/commands/api.js';
import { UserError } from '../src/lib/errors.js';

const ORG_URL = 'https://dev.azure.com/contoso';

describe('buildApiUrl', () => {
  it('resolves a project-relative path against org/project and defaults api-version', () => {
    const url = buildApiUrl('_apis/wit/workitems/123', ORG_URL, 'MyProject');
    expect(url).toBe('https://dev.azure.com/contoso/MyProject/_apis/wit/workitems/123?api-version=7.1');
  });

  it('resolves a leading-slash path as org-level, without a project', () => {
    const url = buildApiUrl('/_apis/projects', ORG_URL);
    expect(url).toBe('https://dev.azure.com/contoso/_apis/projects?api-version=7.1');
  });

  it('leaves an already-absolute URL untouched apart from defaulting api-version', () => {
    const url = buildApiUrl('https://dev.azure.com/contoso/_apis/projects', ORG_URL);
    expect(url).toBe('https://dev.azure.com/contoso/_apis/projects?api-version=7.1');
  });

  it('does not override an api-version the caller already specified', () => {
    const url = buildApiUrl('/_apis/projects?api-version=6.0', ORG_URL);
    expect(url).toBe('https://dev.azure.com/contoso/_apis/projects?api-version=6.0');
  });

  it('throws a clear error for a project-relative path with no project available', () => {
    expect(() => buildApiUrl('_apis/wit/workitems/123', ORG_URL)).toThrow(UserError);
  });
});
