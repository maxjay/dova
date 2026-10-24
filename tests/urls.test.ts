import { describe, expect, it } from 'vitest';
import { parseId, parsePullRequestLink, parseRemote, parseWorkItemLink } from '../src/core/urls.js';

describe('parseRemote', () => {
  it.each([
    ['https://dev.azure.com/contoso/MyProject/_git/web', 'contoso', 'MyProject', 'web'],
    ['https://contoso@dev.azure.com/contoso/My%20Project/_git/web.git', 'contoso', 'My Project', 'web'],
    ['git@ssh.dev.azure.com:v3/contoso/MyProject/web', 'contoso', 'MyProject', 'web'],
    ['https://contoso.visualstudio.com/DefaultCollection/MyProject/_git/web', 'contoso', 'MyProject', 'web'],
    ['https://contoso.visualstudio.com/MyProject/_git/web', 'contoso', 'MyProject', 'web'],
  ])('%s', (remote, org, project, repo) => {
    expect(parseRemote(remote)).toEqual({ org, project, repo });
  });

  it('is null for anything that is not Azure Repos', () => {
    expect(parseRemote('git@github.com:contoso/web.git')).toBeNull();
    expect(parseRemote('https://dev.azure.com/contoso/MyProject')).toBeNull();
  });
});

describe('links', () => {
  it('reads both work item link forms', () => {
    expect(parseWorkItemLink('https://dev.azure.com/contoso/MyProject/_workitems/edit/42')).toEqual({ org: 'contoso', project: 'MyProject', id: 42 });
    expect(parseWorkItemLink('https://dev.azure.com/contoso/MyProject/_workitems?id=42')).toEqual({ org: 'contoso', project: 'MyProject', id: 42 });
  });

  it('reads a pull request link', () => {
    expect(parsePullRequestLink('https://dev.azure.com/contoso/MyProject/_git/web/pullrequest/7')).toEqual({ org: 'contoso', project: 'MyProject', repo: 'web', id: 7 });
    expect(parsePullRequestLink('https://dev.azure.com/contoso/MyProject/_workitems/edit/7')).toBeNull();
  });

  it('takes ids bare or as #id, and nothing else', () => {
    expect([parseId('12'), parseId('#12'), parseId('0'), parseId('12a')]).toEqual([12, 12, null, null]);
  });
});
