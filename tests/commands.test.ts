import { describe, expect, it } from 'vitest';
import { batch, cli, fakePrompts, restPr, testApp, wi, type Req } from './fixtures.js';

const links = { 'branch.feature/x.dova-workitems': '11,12', 'branch.feature/x.dova-primary': '12' };

describe('status', () => {
  it('without a PR: the linked work items, branch runs, no threads — in one round', async () => {
    const { app, ado } = testApp({
      git: { config: links },
      route: (r) =>
        r.path.endsWith('/pullrequests') ? { value: [] } : r.path.endsWith('/builds') ? { value: [{ id: 5, status: 'completed', result: 'failed', sourceBranch: 'refs/heads/feature/x' }] } : batch([wi(11), wi(12)])(r),
    });
    const res = await cli(app, 'status', '--json');
    expect(res.code).toBe(0);
    expect(res.json()).toMatchObject({ branch: 'feature/x', pr: null, workItems: [{ id: 11, primary: false }, { id: 12, primary: true }], runs: [{ id: 5, result: 'failed' }], threads: [] });
    expect(ado.requests.filter((r) => r.path.endsWith('/builds'))).toHaveLength(1);
  });

  it("with a PR: its work items, validation runs first, open threads first", async () => {
    const { app } = testApp({
      route: (r: Req) => {
        if (r.path.endsWith('/pullrequests')) return { value: [restPr(7)] };
        if (r.path.endsWith('/builds')) return { value: [{ id: r.query.get('branchName')!.includes('pull') ? 2 : 1, status: 'completed', result: 'succeeded' }] };
        if (r.path.endsWith('/workitems')) return { value: [{ id: '30' }] };
        if (r.path.endsWith('/threads'))
          return { value: [{ id: 1, status: 'fixed', comments: [{ id: 1, content: 'ok' }] }, { id: 2, status: 'active', comments: [{ id: 1, content: 'fix', author: { displayName: 'Ann' } }] }] };
        return batch([wi(30)])(r);
      },
    });
    const r = (await cli(app, 'status', '--json')).json();
    expect(r.pr.id).toBe(7);
    expect(r.workItems.map((w: { id: number }) => w.id)).toEqual([30]);
    expect(r.runs.map((x: { id: number }) => x.id)).toEqual([2, 1]);
    expect(r.threads.map((t: { id: number }) => t.id)).toEqual([2, 1]);
  });
});

describe('link', () => {
  it('adds to what the branch already links, keeping the primary', async () => {
    const { app, git } = testApp({ git: { config: links }, route: (r) => (r.path.endsWith('/wiql') ? { workItems: [] } : batch([wi(11), wi(12), wi(13)])(r)) });
    const res = await cli(app, 'link', '13', '--json');
    expect(res.json().workItems.map((w: { id: number; primary: boolean }) => [w.id, w.primary])).toEqual([[11, false], [12, true], [13, false]]);
    expect(git.config.get('branch.feature/x.dova-workitems')).toBe('11,12,13');
  });

  it("asks which open children to link — and without a terminal says how to answer instead", async () => {
    const route = (r: Req) => {
      if (r.path.endsWith('/wiql')) return { workItems: [{ id: 21 }, { id: 22 }] };
      if (r.path.endsWith('/states')) return { value: [{ name: 'Active', category: 'InProgress' }, { name: 'Done', category: 'Completed' }] };
      return batch([wi(20, { 'System.WorkItemType': 'Feature' }), wi(21, { 'System.Parent': 20 }), wi(22, { 'System.Parent': 20, 'System.State': 'Done' })])(r);
    };
    const noTerminal = await cli(testApp({ route }).app, 'link', '20');
    expect(noTerminal.code).toBe(1);
    expect(noTerminal.stderr).toContain('dova link 21');

    const { app, git } = testApp({ route, prompts: fakePrompts({ checkbox: ['21'] }) });
    expect((await cli(app, 'link', '20')).code).toBe(0);
    expect(git.config.get('branch.feature/x.dova-workitems')).toBe('21');
  });

  it('unlink removes, moving primary to what remains', async () => {
    const { app, git } = testApp({ git: { config: links }, route: batch([wi(11)]) });
    expect((await cli(app, 'unlink', '12', '--json')).json().workItems).toEqual([{ id: 11, title: 'Item 11', type: 'Task', primary: true }]);
    expect(git.config.get('branch.feature/x.dova-primary')).toBe('11');
  });
});

describe('pr create', () => {
  const route = (r: Req) => (r.method === 'POST' ? restPr(9, { title: r.body.title }) : r.path.includes('/repositories/') ? { defaultBranch: 'refs/heads/develop' } : undefined);

  it('links the branch’s work items and targets the repo default branch', async () => {
    const { app, ado } = testApp({ git: { config: links }, route });
    expect((await cli(app, 'pr', 'create', '--title', 'Add it', '--json', 'id')).json()).toEqual({ id: 9 });
    const post = ado.requests.find((r) => r.method === 'POST')!;
    expect(post.body).toMatchObject({ sourceRefName: 'refs/heads/feature/x', targetRefName: 'refs/heads/develop', title: 'Add it', workItemRefs: [{ id: '11' }, { id: '12' }] });
  });

  it('refuses piped text nothing asked for, rather than dropping it', async () => {
    const res = await cli(testApp({ route, stdin: 'the body' }).app, 'pr', 'create', '--title', 'x');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--body -');
  });

  it('falls back to #ids in commit messages', async () => {
    const { app, ado } = testApp({ route, git: { answers: { 'log -50 --format=%s': 'Fix #41\nMore for #41 and #42', 'log -1 --format=%s': 'Fix #41' } } });
    await cli(app, 'pr', 'create');
    expect(ado.requests.find((r) => r.method === 'POST')!.body).toMatchObject({ title: 'Fix #41', workItemRefs: [{ id: '41' }, { id: '42' }] });
  });
});

describe('wi create / bug', () => {
  it('uses the area and iteration saved for the repo, with no team lookups', async () => {
    const { app, ado } = testApp({ git: { config: { 'dova.area': 'P\\Web', 'dova.iteration': 'P\\S1' } }, route: () => wi(50) });
    expect((await cli(app, 'bug', 'Broken', '--json', 'id')).json()).toEqual({ id: 50 });
    expect(ado.requests).toHaveLength(1);
    expect(ado.requests[0]!.path).toBe('/MyProject/_apis/wit/workitems/$Bug');
    expect(ado.requests[0]!.body.map((p: { value: unknown }) => p.value)).toEqual(['Broken', 'P\\Web', 'P\\S1']);
  });

  it("works out the team's area and sprint the first time, and saves them", async () => {
    const { app, git } = testApp({
      route: (r) =>
        r.path.endsWith('/teams') ? { value: [{ name: 'Web' }] } : r.path.endsWith('/teamfieldvalues') ? { defaultValue: 'P\\Web', values: [] } : r.path.endsWith('/iterations') ? { value: [{ path: 'P\\S2' }] } : wi(51),
    });
    expect((await cli(app, 'wi', 'create', 'Task one')).code).toBe(0);
    expect([git.config.get('dova.area'), git.config.get('dova.iteration')]).toEqual(['P\\Web', 'P\\S2']);
  });

  it('without a terminal, names the flag that picks a team', async () => {
    const res = await cli(testApp({ route: (r) => (r.path.endsWith('/teams') ? { value: [{ name: 'A' }, { name: 'B' }] } : undefined) }).app, 'bug', 'x');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--team');
  });
});

describe('view', () => {
  it('falls back from a work item to a PR for a bare id', async () => {
    const { app } = testApp({ route: (r) => (r.path.endsWith('workitemsbatch') ? { value: [null] } : r.path.endsWith('/pullrequests/7') ? restPr(7) : r.path.endsWith('/threads') || r.path.endsWith('/workitems') ? { value: [] } : undefined) });
    expect((await cli(app, 'view', '7', '--json', 'kind,id')).json()).toEqual({ kind: 'pull-request', id: 7 });
  });

  it('exits 2 when it is neither', async () => {
    const { app } = testApp({ route: (r) => (r.path.endsWith('workitemsbatch') ? { value: [null] } : undefined) });
    expect((await cli(app, 'view', '8')).code).toBe(2);
  });
});

describe('summarize', () => {
  it("compares against the PR's target, with the branch's tickets and commits", async () => {
    const { app } = testApp({
      git: {
        config: links,
        answers: {
          'rev-parse --verify --quiet refs/heads/feature/x': 'abc',
          'rev-parse --verify --quiet origin/main': 'def',
          'log --format=%H%x09%s origin/main..feature/x': `${'a'.repeat(40)}\tFirst`,
          'diff --stat origin/main...feature/x': ' a.ts | 2 +-',
        },
      },
      route: (r) => (r.path.endsWith('/pullrequests') ? { value: [restPr(7)] } : batch([wi(11), wi(12)])(r)),
    });
    expect((await cli(app, 'summarize', '--json')).json()).toMatchObject({ base: 'origin/main', baseSource: 'pr-target', commits: [{ subject: 'First' }], diffStat: ' a.ts | 2 +-', workItems: [{ id: 11 }, { id: 12, primary: true }] });
  });
});

describe('output', () => {
  it('--json fields, --jq, and errors for misuse', async () => {
    const { app } = testApp({ route: (r) => (r.path.endsWith('/pullrequests') ? { value: [] } : r.path.endsWith('/builds') ? { value: [] } : batch([])(r)) });
    expect((await cli(app, 'status', '--json', 'branch')).json()).toEqual({ branch: 'feature/x' });
    expect((await cli(app, 'status', '--json', '--jq', '.branch')).stdout).toBe('feature/x\n');
    expect((await cli(app, 'status', '--jq', '.branch')).code).toBe(1);
    expect((await cli(app, 'status', '--json', 'nope')).stderr).toContain('Available: branch');
  });

  it('completes commands and flags', async () => {
    const { app } = testApp();
    expect((await cli(app, '__complete', '--', 'pi')).stdout).toBe('pipeline\n');
    expect((await cli(app, '__complete', '--', 'pr', 'create', '--dr')).stdout).toBe('--draft\n');
  });
});
