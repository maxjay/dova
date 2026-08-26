import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import { withAzFileArg } from '../src/lib/az-file-arg.js';

/* ------------------------------------------------------------------ *
 * A literal newline cannot survive a command-line argument on Windows:
 * `az` is `az.cmd`, so the spawn goes through `cmd.exe /c`, which
 * rebuilds the command line as one string with no escape for a newline
 * inside an argument. Azure CLI expands any argument starting with `@`
 * by reading that file, before argparse and for every command — so the
 * body travels on disk and only a short path goes on the command line.
 * ------------------------------------------------------------------ */

const BODY = '## Summary\n\nAdds a thing.\n\n- **One**: does it\n\n---\n\nRefs #4164156';

describe('withAzFileArg', () => {
  it('passes an @-prefixed path, not the text', async () => {
    const arg = await withAzFileArg(BODY, async (a) => a);
    expect(arg.startsWith('@')).toBe(true);
    expect(arg).not.toContain('\n');
    expect(arg).not.toContain('Summary');
  });

  it('writes the text verbatim, so az reads back exactly what was sent', async () => {
    const seen = await withAzFileArg(BODY, async (arg) => fs.readFile(arg.slice(1), 'utf8'));
    expect(seen).toBe(BODY);
  });

  it('never puts `=` in the path — az splits an argument on the first `=` before finding the `@`', async () => {
    const arg = await withAzFileArg(BODY, async (a) => a);
    expect(arg).not.toContain('=');
  });

  it('removes the file once the call settles', async () => {
    const arg = await withAzFileArg(BODY, async (a) => a);
    await expect(fs.readFile(arg.slice(1), 'utf8')).rejects.toThrow();
  });

  it('removes the file even when the az call throws, and propagates the error', async () => {
    let path = '';
    await expect(
      withAzFileArg(BODY, async (arg) => {
        path = arg.slice(1);
        throw new Error('az failed');
      })
    ).rejects.toThrow('az failed');
    await expect(fs.readFile(path, 'utf8')).rejects.toThrow();
  });

  it('handles text az would otherwise mangle: leading @, CRLF, unicode, empty lines', async () => {
    const nasty = '@Deprecated is missing\r\n\r\n— em dash, curly ’quote’\r\n\r\n---\r\n';
    const seen = await withAzFileArg(nasty, async (arg) => fs.readFile(arg.slice(1), 'utf8'));
    expect(seen).toBe(nasty);
  });

  it('gives each concurrent call its own file', async () => {
    const [a, b] = await Promise.all([
      withAzFileArg('one', async (x) => x),
      withAzFileArg('two', async (x) => x),
    ]);
    expect(a).not.toBe(b);
  });

  it('returns whatever the az call returned', async () => {
    expect(await withAzFileArg(BODY, async () => ({ pullRequestId: 42 }))).toEqual({ pullRequestId: 42 });
  });
});
