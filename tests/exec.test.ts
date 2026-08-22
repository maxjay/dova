import { describe, it, expect } from 'vitest';
import { runAzRestJson, AZURE_DEVOPS_AAD_RESOURCE } from '../src/lib/exec.js';
import { createFakeRunner, okJson } from './fixtures/fake-runner.js';

describe('runAzRestJson', () => {
  it('always passes --resource for Azure DevOps by default', async () => {
    let seenArgs: string[] = [];
    const runner = createFakeRunner({
      az: (args) => {
        seenArgs = args;
        return okJson({ ok: true });
      },
    });

    await runAzRestJson(runner, { method: 'get', uri: 'https://dev.azure.com/contoso/_apis/projects?api-version=7.1' });

    expect(seenArgs).toContain('--resource');
    expect(seenArgs[seenArgs.indexOf('--resource') + 1]).toBe(AZURE_DEVOPS_AAD_RESOURCE);
  });

  it('lets the caller override the AAD resource', async () => {
    let seenArgs: string[] = [];
    const runner = createFakeRunner({
      az: (args) => {
        seenArgs = args;
        return okJson({ ok: true });
      },
    });

    await runAzRestJson(runner, { method: 'get', uri: 'https://management.azure.com/subscriptions?api-version=2020-01-01', resource: 'https://management.azure.com/' });

    expect(seenArgs[seenArgs.indexOf('--resource') + 1]).toBe('https://management.azure.com/');
  });

  it('passes body and headers through when given', async () => {
    let seenArgs: string[] = [];
    const runner = createFakeRunner({
      az: (args) => {
        seenArgs = args;
        return okJson({ ok: true });
      },
    });

    await runAzRestJson(runner, {
      method: 'post',
      uri: 'https://dev.azure.com/contoso/_apis/x?api-version=7.1',
      body: '{"a":1}',
      headers: ['Content-Type=application/json'],
    });

    expect(seenArgs).toContain('--body');
    expect(seenArgs[seenArgs.indexOf('--body') + 1]).toBe('{"a":1}');
    expect(seenArgs).toContain('--headers');
    expect(seenArgs[seenArgs.indexOf('--headers') + 1]).toBe('Content-Type=application/json');
  });
});
