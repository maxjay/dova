import { describe, it, expect } from 'vitest';
import { runAzRestJson, toAsciiSafeJson, AZURE_DEVOPS_AAD_RESOURCE } from '../src/lib/exec.js';
import { createFakeRunner, okJson } from './fixtures/fake-runner.js';

describe('toAsciiSafeJson', () => {
  it('leaves plain-ASCII JSON untouched', () => {
    expect(toAsciiSafeJson({ a: 'hello', b: 1 })).toBe('{"a":"hello","b":1}');
  });

  it('escapes an em dash, curly quotes, and accented characters to \\uXXXX', () => {
    // The exact case that trips Azure/azure-cli#30366 / #22616 — a body
    // string containing a character outside Latin-1 can crash `az rest`
    // while it sends it, on any az CLI version.
    const result = toAsciiSafeJson({ content: 'em dash — “curly” café' });
    expect(result).toBe('{"content":"em dash \\u2014 \\u201ccurly\\u201d caf\\u00e9"}');
    // The whole output is plain ASCII, so it's safe under any encoding az might apply.
    expect(/^[\x00-\x7E]*$/.test(result)).toBe(true);
  });

  it('round-trips through JSON.parse back to the original string', () => {
    const original = { content: '✅ done — thanks!' };
    const escaped = toAsciiSafeJson(original);
    expect(JSON.parse(escaped)).toEqual(original);
  });
});

describe('runAzRestJson', () => {
  it('always passes --resource for Azure DevOps — dova never targets anything else', async () => {
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
      body: { a: 1 },
      headers: ['Content-Type=application/json'],
    });

    expect(seenArgs).toContain('--body');
    expect(seenArgs[seenArgs.indexOf('--body') + 1]).toBe('{"a":1}');
    expect(seenArgs).toContain('--headers');
    expect(seenArgs[seenArgs.indexOf('--headers') + 1]).toBe('Content-Type=application/json');
  });

  it('passes rawBody straight through, untouched (e.g. az\'s own @file.json syntax)', async () => {
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
      rawBody: '@path/to/file.json',
    });

    expect(seenArgs[seenArgs.indexOf('--body') + 1]).toBe('@path/to/file.json');
  });
});
