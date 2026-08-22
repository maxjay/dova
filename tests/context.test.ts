import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAzureRepoRemoteUrl,
  parseOrgUrl,
  resolveContext,
} from '../src/lib/context.js';
import { UserError } from '../src/lib/errors.js';
import { createFakeRunner, ok, fail } from './fixtures/fake-runner.js';
import { remotes, orgUrls } from './fixtures/remotes.js';

describe('parseAzureRepoRemoteUrl', () => {
  it('parses the modern HTTPS form', () => {
    expect(parseAzureRepoRemoteUrl(remotes.httpsModern)).toEqual({
      org: 'contoso',
      project: 'MyProject',
      repo: 'my-repo',
      orgUrl: 'https://dev.azure.com/contoso',
    });
  });

  it('parses the modern HTTPS form with a userinfo prefix', () => {
    expect(parseAzureRepoRemoteUrl(remotes.httpsModernWithUser)?.org).toBe('contoso');
  });

  it('decodes a percent-encoded (spaced) project name', () => {
    expect(parseAzureRepoRemoteUrl(remotes.httpsModernSpacedProject)?.project).toBe('My Project');
  });

  it('strips a trailing .git suffix from the repo name', () => {
    expect(parseAzureRepoRemoteUrl(remotes.httpsModernDotGit)?.repo).toBe('my-repo');
  });

  it('parses the modern SSH (scp-like) form', () => {
    expect(parseAzureRepoRemoteUrl(remotes.sshModern)).toEqual({
      org: 'contoso',
      project: 'MyProject',
      repo: 'my-repo',
      orgUrl: 'https://dev.azure.com/contoso',
    });
  });

  it('parses the legacy visualstudio.com HTTPS form', () => {
    expect(parseAzureRepoRemoteUrl(remotes.httpsLegacy)).toEqual({
      org: 'contoso',
      project: 'MyProject',
      repo: 'my-repo',
      orgUrl: 'https://contoso.visualstudio.com',
    });
  });

  it('parses the legacy visualstudio.com form with a /DefaultCollection/ segment', () => {
    expect(parseAzureRepoRemoteUrl(remotes.httpsLegacyDefaultCollection)).toEqual({
      org: 'contoso',
      project: 'MyProject',
      repo: 'my-repo',
      orgUrl: 'https://contoso.visualstudio.com',
    });
  });

  it('parses the legacy vs-ssh SSH form', () => {
    expect(parseAzureRepoRemoteUrl(remotes.sshLegacy)).toEqual({
      org: 'contoso',
      project: 'MyProject',
      repo: 'my-repo',
      orgUrl: 'https://contoso.visualstudio.com',
    });
  });

  it('returns null for a non-Azure-Repos remote instead of guessing', () => {
    expect(parseAzureRepoRemoteUrl(remotes.notAzureRepos)).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseAzureRepoRemoteUrl(remotes.malformed)).toBeNull();
  });
});

describe('parseOrgUrl', () => {
  it('parses a modern org URL', () => {
    expect(parseOrgUrl(orgUrls.modern)).toEqual({ org: 'contoso', orgUrl: 'https://dev.azure.com/contoso' });
  });

  it('parses a legacy org URL', () => {
    expect(parseOrgUrl(orgUrls.legacy)).toEqual({ org: 'contoso', orgUrl: 'https://contoso.visualstudio.com' });
  });

  it('returns null for an unrelated URL', () => {
    expect(parseOrgUrl('https://example.com')).toBeNull();
  });
});

describe('resolveContext', () => {
  const originalConfigDir = process.env.AZURE_CONFIG_DIR;
  const originalDevopsConfigDir = process.env.AZURE_DEVOPS_EXT_CONFIG_DIR;
  let tmpDir: string | undefined;

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.AZURE_CONFIG_DIR;
    else process.env.AZURE_CONFIG_DIR = originalConfigDir;
    if (originalDevopsConfigDir === undefined) delete process.env.AZURE_DEVOPS_EXT_CONFIG_DIR;
    else process.env.AZURE_DEVOPS_EXT_CONFIG_DIR = originalDevopsConfigDir;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function withAzDevopsDefaults(iniBody: string): void {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dova-test-'));
    const devopsDir = path.join(tmpDir, 'azuredevops');
    fs.mkdirSync(devopsDir);
    fs.writeFileSync(path.join(devopsDir, 'config'), iniBody);
    process.env.AZURE_CONFIG_DIR = tmpDir;
    delete process.env.AZURE_DEVOPS_EXT_CONFIG_DIR;
  }

  it('prefers explicit flags over everything else', async () => {
    const runner = createFakeRunner({});
    const result = await resolveContext(runner, { org: 'contoso', project: 'MyProject', repo: 'my-repo' });
    expect(result).toEqual({
      org: 'contoso',
      project: 'MyProject',
      repo: 'my-repo',
      orgUrl: 'https://dev.azure.com/contoso',
      source: 'flags',
    });
  });

  it('resolves from the git remote when inside a repo', async () => {
    const runner = createFakeRunner({
      git: (args) => {
        const joined = args.join(' ');
        if (joined === 'rev-parse --is-inside-work-tree') return ok('true');
        if (joined === 'remote get-url origin') return ok(remotes.httpsModern);
        if (joined === 'rev-parse --abbrev-ref HEAD') return ok('feature/my-branch');
        return fail(`unexpected git call: ${joined}`);
      },
    });

    const result = await resolveContext(runner, {});
    expect(result).toEqual({
      org: 'contoso',
      project: 'MyProject',
      repo: 'my-repo',
      orgUrl: 'https://dev.azure.com/contoso',
      branch: 'feature/my-branch',
      source: 'git-remote',
    });
  });

  it('lets an explicit flag override a single field from the git remote', async () => {
    const runner = createFakeRunner({
      git: (args) => {
        const joined = args.join(' ');
        if (joined === 'rev-parse --is-inside-work-tree') return ok('true');
        if (joined === 'remote get-url origin') return ok(remotes.httpsModern);
        if (joined === 'rev-parse --abbrev-ref HEAD') return ok('main');
        return fail();
      },
    });

    const result = await resolveContext(runner, { project: 'OtherProject' });
    expect(result.org).toBe('contoso');
    expect(result.project).toBe('OtherProject');
    expect(result.repo).toBe('my-repo');
  });

  it('falls back to az devops configure defaults when not in a repo', async () => {
    withAzDevopsDefaults('[defaults]\norganization = https://dev.azure.com/contoso\nproject = MyProject\n');
    const runner = createFakeRunner({
      git: (args) => (args.join(' ') === 'rev-parse --is-inside-work-tree' ? fail('not a git repo', 128) : fail()),
    });

    const result = await resolveContext(runner, {});
    expect(result).toEqual({
      org: 'contoso',
      project: 'MyProject',
      repo: undefined,
      orgUrl: 'https://dev.azure.com/contoso',
      source: 'az-devops-defaults',
    });
  });

  it('throws a specific, actionable error when nothing resolves', async () => {
    withAzDevopsDefaults('[defaults]\n');
    const runner = createFakeRunner({
      git: () => fail('not a git repo', 128),
    });

    await expect(resolveContext(runner, {})).rejects.toBeInstanceOf(UserError);
  });
});
