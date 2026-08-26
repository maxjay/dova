import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { runAzRestJson, runAzRestText, toAsciiSafeJson, resolveOrFetchBranchRef, AZURE_DEVOPS_AAD_RESOURCE, assertNoNewlineArgs } from '../src/lib/exec.js';
import { NotFoundError } from '../src/lib/errors.js';
import { createFakeRunner, ok, okJson, fail } from './fixtures/fake-runner.js';

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

  // A JSON body is quote-dense, and on Windows each `"` closes the
  // quoted run cmd is holding when `az.cmd` re-parses `%*` — exposing
  // any `(`, `&` or `%` after it. So the body goes to a temp file and
  // only `@path` reaches the command line.
  it('sends the body as an @file argument, not inline, and passes headers through', async () => {
    let seenArgs: string[] = [];
    let bodyOnDisk = '';
    const runner = createFakeRunner({
      az: (args) => {
        seenArgs = args;
        const arg = args[args.indexOf('--body') + 1]!;
        bodyOnDisk = readFileSync(arg.slice(1), 'utf8');
        return okJson({ ok: true });
      },
    }, { rawArgs: true });

    await runAzRestJson(runner, {
      method: 'post',
      uri: 'https://dev.azure.com/contoso/_apis/x?api-version=7.1',
      body: { content: 'enforces hasViewPermission() per row' },
      headers: ['Content-Type=application/json'],
    });

    const bodyArg = seenArgs[seenArgs.indexOf('--body') + 1]!;
    expect(bodyArg.startsWith('@')).toBe(true);
    // The text cmd would have choked on never reaches the command line.
    expect(bodyArg).not.toContain('(');
    expect(bodyArg).not.toContain('"');
    expect(bodyOnDisk).toBe('{"content":"enforces hasViewPermission() per row"}');

    expect(seenArgs).toContain('--headers');
    expect(seenArgs[seenArgs.indexOf('--headers') + 1]).toBe('Content-Type=application/json');
  });

  it('still escapes non-ASCII in the body it writes — az reads the file as Latin-1 on some hosts', async () => {
    let bodySeen = '';
    const runner = createFakeRunner({
      az: (args) => {
        bodySeen = args[args.indexOf('--body') + 1]!;
        return okJson({ ok: true });
      },
    });

    await runAzRestJson(runner, { method: 'post', uri: 'https://x/y', body: { content: 'em — dash' } });
    expect(bodySeen).toBe('{"content":"em \\u2014 dash"}');
  });

  it('removes the temp file once the call is done', async () => {
    let bodyArg = '';
    const runner = createFakeRunner({
      az: (args) => {
        bodyArg = args[args.indexOf('--body') + 1]!;
        return okJson({ ok: true });
      },
    }, { rawArgs: true });

    await runAzRestJson(runner, { method: 'post', uri: 'https://x/y', body: { a: 1 } });
    expect(existsSync(bodyArg.slice(1))).toBe(false);
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

describe('runAzRestText', () => {
  it('returns raw stdout untouched — no JSON.parse, no --output flag', async () => {
    let seenArgs: string[] = [];
    const runner = createFakeRunner({
      az: (args) => {
        seenArgs = args;
        return ok('2024-01-01T00:00:00Z Starting task\nnot valid json {{{\nBuild failed with exit code 1');
      },
    });

    const text = await runAzRestText(runner, { method: 'get', uri: 'https://dev.azure.com/contoso/_apis/build/builds/1/logs/2?api-version=7.1' });

    expect(text).toBe('2024-01-01T00:00:00Z Starting task\nnot valid json {{{\nBuild failed with exit code 1');
    expect(seenArgs).not.toContain('--output');
    expect(seenArgs).toContain('--resource');
  });
});

describe('resolveOrFetchBranchRef', () => {
  it('returns the bare branch name when it already exists locally, no fetch attempted', async () => {
    const runner = createFakeRunner({
      git: (args) => {
        if (args[0] === 'rev-parse' && args[args.length - 1] === 'refs/heads/feature/x') return ok('deadbeef');
        return fail('should not be called');
      },
    });
    expect(await resolveOrFetchBranchRef(runner, 'feature/x')).toBe('feature/x');
  });

  it('returns origin/<branch> when already fetched, no new fetch attempted', async () => {
    const runner = createFakeRunner({
      git: (args) => {
        if (args[0] === 'rev-parse' && args[args.length - 1] === 'refs/heads/feature/x') return fail('', 1);
        if (args[0] === 'rev-parse' && args[args.length - 1] === 'refs/remotes/origin/feature/x') return ok('deadbeef');
        if (args[0] === 'fetch') return fail('should not fetch — already resolved');
        return fail('unexpected');
      },
    });
    expect(await resolveOrFetchBranchRef(runner, 'feature/x')).toBe('origin/feature/x');
  });

  it('fetches from origin when the branch is not local and not already fetched', async () => {
    let fetchArgs: string[] | undefined;
    const runner = createFakeRunner({
      git: (args) => {
        if (args[0] === 'rev-parse') return fail('', 1);
        if (args[0] === 'fetch') {
          fetchArgs = args;
          return ok('');
        }
        return fail('unexpected');
      },
    });
    expect(await resolveOrFetchBranchRef(runner, 'feature/x')).toBe('origin/feature/x');
    expect(fetchArgs).toEqual(['fetch', 'origin', 'feature/x:refs/remotes/origin/feature/x']);
  });

  it('throws NotFoundError when the branch exists nowhere', async () => {
    const runner = createFakeRunner({ git: () => fail('fatal: couldn\'t find remote ref feature/ghost', 128) });
    await expect(resolveOrFetchBranchRef(runner, 'feature/ghost')).rejects.toBeInstanceOf(NotFoundError);
  });
});

/* ------------------------------------------------------------------ *
 * `az` is `az.cmd` on Windows, so the spawn goes through `cmd.exe /c`,
 * which rebuilds the command line as one string and cannot escape a
 * newline inside an argument. Multi-line text sent that way arrives
 * empty or cut at the first line while az still reports success — how a
 * PR ends up created with no description. Free text goes via
 * `withAzFileArg` instead; this makes the broken route unreachable.
 * ------------------------------------------------------------------ */

describe('assertNoNewlineArgs', () => {
  it('allows ordinary single-line arguments', () => {
    expect(() => assertNoNewlineArgs(['repos', 'pr', 'create', '--title', 'feat: a thing'])).not.toThrow();
  });

  it('allows a JSON body, where newlines are escaped to two characters', () => {
    const body = JSON.stringify({ content: 'line one\nline two' });
    expect(body).not.toContain('\n');
    expect(() => assertNoNewlineArgs(['rest', '--body', body])).not.toThrow();
  });

  it('allows the @path a temp-file argument produces', () => {
    expect(() => assertNoNewlineArgs(['--description', '@/tmp/dova-abc/body.txt'])).not.toThrow();
  });

  it('rejects a multi-line argument and names the flag that carried it', () => {
    expect(() => assertNoNewlineArgs(['--description', '## Summary\n\nBody'])).toThrow(/--description/);
  });

  it('rejects a lone carriage return too — CRLF text is just as fatal', () => {
    expect(() => assertNoNewlineArgs(['--description', 'one\r\ntwo'])).toThrow();
  });

  it('points at the fix rather than just refusing', () => {
    expect(() => assertNoNewlineArgs(['--description', 'a\nb'])).toThrow(/azText/);
  });
});
