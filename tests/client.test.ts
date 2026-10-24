import { describe, expect, it } from 'vitest';
import { AdoClient } from '../src/ado/client.js';
import { ExternalError, NotFoundError, PrereqError } from '../src/errors.js';
import { batch, fakeAdo, json, restPr, wi } from './fixtures.js';

const client = (route: Parameters<typeof fakeAdo>[0]) => {
  const ado = fakeAdo(route);
  return { c: new AdoClient(ado.http, 'https://dev.azure.com/contoso'), requests: ado.requests };
};

describe('AdoClient', () => {
  it('batches work items 200 at a time, keeps the order asked, and drops missing ones', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    const { c, requests } = client(batch(ids.filter((id) => id !== 3).map((id) => wi(id))));
    const items = await c.workItems([...ids].reverse());
    expect(requests.map((r) => r.body.ids.length)).toEqual([200, 200, 50]);
    expect(items[0]!.id).toBe(450);
    expect(items).toHaveLength(449);
  });

  it('maps a work item, HTML stripped, only the body sections it has', async () => {
    const { c } = client(batch([wi(5, { 'System.Parent': 2, 'Microsoft.VSTS.TCM.ReproSteps': '<p>Click&nbsp;it</p>', 'System.AssignedTo': { displayName: 'Jane' } })]));
    expect(await c.workItem(5)).toMatchObject({ id: 5, parentId: 2, assignedTo: 'Jane', body: [{ label: 'Repro Steps', text: 'Click it' }], url: 'https://dev.azure.com/contoso/MyProject/_workitems/edit/5' });
  });

  it('says which work item is missing', async () => {
    await expect(client(batch([])).c.workItem(9)).rejects.toThrow(new NotFoundError('Work item #9 was not found.'));
  });

  it('creates a work item and its parent link in one request', async () => {
    const { c, requests } = client(() => wi(10));
    await c.createWorkItem({ project: 'MyProject', type: 'User Story', title: 'T', areaPath: 'A', parentId: 3 });
    expect(requests[0]!.path).toBe('/MyProject/_apis/wit/workitems/$User Story');
    expect(requests[0]!.raw.contentType).toBe('application/json-patch+json');
    expect(requests[0]!.body).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'T' },
      { op: 'add', path: '/fields/System.AreaPath', value: 'A' },
      { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/contoso/_apis/wit/workItems/3' } },
    ]);
  });

  it("keeps only runs for the ref asked about, even if the service sends others", async () => {
    const { c, requests } = client(() => ({ value: [{ id: 1, status: 'completed', sourceBranch: 'refs/heads/other' }, { id: 2, status: 'completed', sourceBranch: 'refs/heads/feature/x' }] }));
    expect((await c.runs('MyProject', 'feature/x', 3)).map((r) => r.id)).toEqual([2]);
    expect(requests[0]!.query.get('branchName')).toBe('refs/heads/feature/x');
    expect(requests[0]!.query.get('$top')).toBe('20');
  });

  it('maps a pull request and drops system-only threads', async () => {
    const { c } = client((r) =>
      r.path.endsWith('/threads')
        ? { value: [{ id: 1, status: 'active', comments: [{ id: 1, content: 'Fix this', commentType: 'text' }] }, { id: 2, comments: [{ id: 1, content: 'Jane pushed', commentType: 'system' }] }] }
        : restPr(7)
    );
    const pr = await c.pullRequest(7);
    expect(pr).toMatchObject({ id: 7, sourceBranch: 'feature/x', targetBranch: 'main', repo: 'web', url: 'https://dev.azure.com/contoso/MyProject/_git/web/pullrequest/7' });
    expect((await c.threads(pr)).map((t) => [t.id, t.unresolved])).toEqual([[1, true]]);
  });

  it('turns statuses into errors that say what happened', async () => {
    await expect(client(() => json({ message: 'TF401019' }, 404)).c.pullRequest(1)).rejects.toThrow('Pull request #1 was not found.');
    await expect(client(() => json({ message: 'TF400813: not authorized' }, 401)).c.teams('P')).rejects.toBeInstanceOf(PrereqError);
    await expect(client(() => json({ message: 'VS402323: bad' }, 400)).c.teams('P')).rejects.toThrow(ExternalError);
  });
});
