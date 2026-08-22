import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Conf from 'conf';
import {
  resolveProject,
  resolveTeam,
  resolveAreaPath,
  resolveIterationPath,
  resolveTeamContext,
  type TeamResolverPrompts,
} from '../src/lib/team-resolver.js';
import { setCacheInstance, type DovaCacheSchema } from '../src/lib/config.js';
import { NotFoundError, UserError } from '../src/lib/errors.js';
import { createFakeRunner, ok, okJson, fail } from './fixtures/fake-runner.js';
import {
  oneTeam,
  multipleTeams,
  areaWithDefault,
  areaNoDefaultSingleValue,
  areaNoDefaultMultipleValues,
  currentIteration,
  noCurrentIteration,
} from './fixtures/az-output.js';

const ORG_URL = 'https://dev.azure.com/contoso';
const PROJECT = 'MyProject';

function fakePrompts(overrides: Partial<TeamResolverPrompts> = {}): TeamResolverPrompts {
  return {
    select: vi.fn().mockRejectedValue(new Error('select() should not have been called')),
    confirm: vi.fn().mockRejectedValue(new Error('confirm() should not have been called')),
    ...overrides,
  };
}

/** git handler that only knows how to answer `git config [--global] --get <key>` and `git config <key> <value>`. */
function gitConfigRunner(values: Record<string, string>, sets: Record<string, string> = {}) {
  return createFakeRunner({
    git: (args) => {
      if (args[0] === 'config' && args.includes('--get')) {
        const key = args[args.length - 1]!;
        return key in values ? ok(values[key]!) : fail('', 1);
      }
      if (args[0] === 'config') {
        const withoutGlobal = args.filter((a) => a !== '--global');
        const [, key, value] = withoutGlobal;
        if (key && value !== undefined) sets[key] = value;
        return ok('');
      }
      return fail(`unexpected git call: ${args.join(' ')}`);
    },
  });
}

describe('resolveProject', () => {
  it('prefers the --project flag', async () => {
    const runner = gitConfigRunner({});
    const result = await resolveProject(runner, 'ContextProject', { project: 'FlagProject' });
    expect(result).toEqual({ project: 'FlagProject', source: 'flag' });
  });

  it('falls back to the global override', async () => {
    const runner = gitConfigRunner({ 'dova.project.override': 'GlobalProject' });
    const result = await resolveProject(runner, 'ContextProject', {});
    expect(result).toEqual({ project: 'GlobalProject', source: 'global-override' });
  });

  it('falls back to the repo-local config', async () => {
    const runner = gitConfigRunner({ 'dova.project': 'RepoLocalProject' });
    const result = await resolveProject(runner, 'ContextProject', {});
    expect(result).toEqual({ project: 'RepoLocalProject', source: 'repo-local' });
  });

  it('falls back to the project implied by context resolution', async () => {
    const runner = gitConfigRunner({});
    const result = await resolveProject(runner, 'ContextProject', {});
    expect(result).toEqual({ project: 'ContextProject', source: 'context' });
  });

  it('throws when nothing resolves', async () => {
    const runner = gitConfigRunner({});
    await expect(resolveProject(runner, undefined, {})).rejects.toBeInstanceOf(UserError);
  });
});

describe('resolveTeam', () => {
  it('prefers the --team flag', async () => {
    const runner = gitConfigRunner({});
    const result = await resolveTeam(runner, ORG_URL, PROJECT, { team: 'FlagTeam' });
    expect(result).toEqual({ team: 'FlagTeam', source: 'flag' });
  });

  it('falls back to the global override', async () => {
    const runner = gitConfigRunner({ 'dova.team.override': 'GlobalTeam' });
    const result = await resolveTeam(runner, ORG_URL, PROJECT, {});
    expect(result).toEqual({ team: 'GlobalTeam', source: 'global-override' });
  });

  it('falls back to the repo-local config', async () => {
    const runner = gitConfigRunner({ 'dova.team': 'RepoLocalTeam' });
    const result = await resolveTeam(runner, ORG_URL, PROJECT, {});
    expect(result).toEqual({ team: 'RepoLocalTeam', source: 'repo-local' });
  });

  it('auto-selects when the project has exactly one team, then offers to save', async () => {
    const sets: Record<string, string> = {};
    const runner = createFakeRunner({
      git: gitConfigRunner({}, sets).git,
      az: (args) => (args.join(' ').startsWith('devops team list') ? okJson(oneTeam) : fail()),
    });
    const prompts = fakePrompts({ confirm: vi.fn().mockResolvedValue(true) });

    const result = await resolveTeam(runner, ORG_URL, PROJECT, {}, { prompts });
    expect(result).toEqual({ team: 'MyTeam', source: 'interactive' });
    expect(prompts.select).not.toHaveBeenCalled();
    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(sets['dova.team']).toBe('MyTeam');
  });

  it('prompts a picker with multiple teams, and skips saving when declined', async () => {
    const sets: Record<string, string> = {};
    const runner = createFakeRunner({
      git: gitConfigRunner({}, sets).git,
      az: (args) => (args.join(' ').startsWith('devops team list') ? okJson(multipleTeams) : fail()),
    });
    const prompts = fakePrompts({
      select: vi.fn().mockResolvedValue('Website Team'),
      confirm: vi.fn().mockResolvedValue(false),
    });

    const result = await resolveTeam(runner, ORG_URL, PROJECT, {}, { prompts });
    expect(result).toEqual({ team: 'Website Team', source: 'interactive' });
    expect(prompts.select).toHaveBeenCalledOnce();
    expect(sets['dova.team']).toBeUndefined();
  });

  it('throws NotFoundError when the project has no teams', async () => {
    const runner = createFakeRunner({
      git: gitConfigRunner({}).git,
      az: () => okJson([]),
    });
    await expect(resolveTeam(runner, ORG_URL, PROJECT, {}, { prompts: fakePrompts() })).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it('--reresolve skips the override/repo-local config and goes straight to interactive resolution', async () => {
    const runner = createFakeRunner({
      git: gitConfigRunner({ 'dova.team': 'StaleTeam' }).git,
      az: (args) => (args.join(' ').startsWith('devops team list') ? okJson(oneTeam) : fail()),
    });
    const prompts = fakePrompts({ confirm: vi.fn().mockResolvedValue(false) });

    const result = await resolveTeam(runner, ORG_URL, PROJECT, {}, { prompts, reresolve: true });
    expect(result.team).toBe('MyTeam');
  });
});

describe('resolveAreaPath', () => {
  it('uses the flagged default area path with no prompt', async () => {
    const runner = createFakeRunner({ az: () => okJson(areaWithDefault) });
    const result = await resolveAreaPath(runner, ORG_URL, PROJECT, 'MyTeam', fakePrompts());
    expect(result).toEqual({ areaPath: 'MyProject\\MyTeam' });
  });

  it('warns and uses the only value when none is flagged default', async () => {
    const runner = createFakeRunner({ az: () => okJson(areaNoDefaultSingleValue) });
    const result = await resolveAreaPath(runner, ORG_URL, PROJECT, 'MyTeam', fakePrompts());
    expect(result.areaPath).toBe('MyProject\\MyTeam');
    expect(result.warning).toMatch(/no default area path/i);
  });

  it('prompts when there are multiple values and none is flagged default', async () => {
    const runner = createFakeRunner({ az: () => okJson(areaNoDefaultMultipleValues) });
    const prompts = fakePrompts({ select: vi.fn().mockResolvedValue('MyProject\\MyTeam\\Sub') });
    const result = await resolveAreaPath(runner, ORG_URL, PROJECT, 'MyTeam', prompts);
    expect(result).toEqual({ areaPath: 'MyProject\\MyTeam\\Sub' });
    expect(prompts.select).toHaveBeenCalledOnce();
  });
});

describe('resolveIterationPath', () => {
  it('uses the current sprint when one exists', async () => {
    const runner = createFakeRunner({ az: () => okJson(currentIteration) });
    const result = await resolveIterationPath(runner, ORG_URL, PROJECT, 'MyTeam');
    expect(result).toEqual({ iterationPath: 'MyProject\\Sprint 3' });
  });

  it('falls back to the project root iteration, with a warning, for a Kanban-only team', async () => {
    const runner = createFakeRunner({ az: () => okJson(noCurrentIteration) });
    const result = await resolveIterationPath(runner, ORG_URL, PROJECT, 'MyTeam');
    expect(result.iterationPath).toBe(PROJECT);
    expect(result.warning).toMatch(/no current sprint/i);
  });
});

describe('resolveTeamContext (with caching)', () => {
  let tmpDir: string;

  afterEach(() => {
    setCacheInstance(null);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function freshCache(): void {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dova-cache-test-'));
    setCacheInstance(new Conf<DovaCacheSchema>({ cwd: tmpDir, configName: 'cache', defaults: { teamContext: {} } }));
  }

  it('resolves and caches on a miss', async () => {
    freshCache();
    const runner = createFakeRunner({
      git: gitConfigRunner({ 'dova.team': 'MyTeam' }).git,
      az: (args) => {
        const joined = args.join(' ');
        if (joined.startsWith('boards area team list')) return okJson(areaWithDefault);
        if (joined.startsWith('boards iteration team list')) return okJson(currentIteration);
        return fail(`unexpected az call: ${joined}`);
      },
    });

    const result = await resolveTeamContext(runner, 'contoso', ORG_URL, PROJECT, {});
    expect(result.fromCache).toBe(false);
    expect(result.areaPath).toBe('MyProject\\MyTeam');
    expect(result.iterationPath).toBe('MyProject\\Sprint 3');
  });

  it('returns the cached mapping on a hit, without calling az again', async () => {
    freshCache();
    const az = vi.fn((args: string[]) => {
      const joined = args.join(' ');
      if (joined.startsWith('boards area team list')) return okJson(areaWithDefault);
      if (joined.startsWith('boards iteration team list')) return okJson(currentIteration);
      return fail(`unexpected az call: ${joined}`);
    });
    const runner = createFakeRunner({ git: gitConfigRunner({ 'dova.team': 'MyTeam' }).git, az });

    await resolveTeamContext(runner, 'contoso', ORG_URL, PROJECT, {});
    az.mockClear();
    const second = await resolveTeamContext(runner, 'contoso', ORG_URL, PROJECT, {});

    expect(second.fromCache).toBe(true);
    expect(second.areaPath).toBe('MyProject\\MyTeam');
    expect(az).not.toHaveBeenCalled();
  });

  it('--reresolve bypasses the cache', async () => {
    freshCache();
    // Pin the team via flag so this test isolates the area/iteration cache
    // bypass from team resolution's own (separately tested) --reresolve behavior.
    const az = vi.fn((args: string[]) => {
      const joined = args.join(' ');
      if (joined.startsWith('boards area team list')) return okJson(areaWithDefault);
      if (joined.startsWith('boards iteration team list')) return okJson(currentIteration);
      return fail(`unexpected az call: ${joined}`);
    });
    const runner = createFakeRunner({ git: gitConfigRunner({}).git, az });
    const flags = { team: 'MyTeam' };

    await resolveTeamContext(runner, 'contoso', ORG_URL, PROJECT, flags);
    az.mockClear();
    const second = await resolveTeamContext(runner, 'contoso', ORG_URL, PROJECT, flags, { reresolve: true });

    expect(second.fromCache).toBe(false);
    expect(az).toHaveBeenCalled();
  });
});
