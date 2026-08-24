import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readTextArg } from '../src/lib/stdin.js';
import { UserError } from '../src/lib/errors.js';

function pipe(text: string) {
  return Object.assign(Readable.from([Buffer.from(text, 'utf8')]), { isTTY: false });
}
function terminal() {
  return Object.assign(Readable.from([]), { isTTY: true });
}

describe('readTextArg', () => {
  it('returns the argument untouched when one was given', async () => {
    const stdin = pipe('SHOULD NOT BE READ');
    expect(await readTextArg('a title', { what: 'title', stdin })).toBe('a title');
  });

  it('reads stdin when the argument is omitted', async () => {
    expect(await readTextArg(undefined, { what: 'title', stdin: pipe('from stdin') })).toBe('from stdin');
  });

  it("reads stdin when the argument is '-'", async () => {
    expect(await readTextArg('-', { what: 'title', stdin: pipe('from stdin') })).toBe('from stdin');
  });

  it('preserves shell metacharacters exactly — the whole point of taking text this way', async () => {
    const raw = 'Use `npm test`; the "total" is $null and it\'s fine\n';
    expect(await readTextArg('-', { what: 'text', stdin: pipe(raw) })).toBe(
      'Use `npm test`; the "total" is $null and it\'s fine'
    );
  });

  it('strips the trailing newline a heredoc always adds, but keeps interior blank lines', async () => {
    expect(await readTextArg('-', { what: 'text', stdin: pipe('line one\n\nline two\n') })).toBe('line one\n\nline two');
  });

  it('normalizes CRLF to LF', async () => {
    expect(await readTextArg('-', { what: 'text', stdin: pipe('a\r\nb\r\n') })).toBe('a\nb');
  });

  it('throws on empty stdin rather than posting an empty comment', async () => {
    await expect(readTextArg('-', { what: 'comment text', stdin: pipe('   \n\n') })).resolves.toBe('   ');
    await expect(readTextArg('-', { what: 'comment text', stdin: pipe('') })).rejects.toBeInstanceOf(UserError);
  });

  it('throws instead of blocking forever when there is no argument and stdin is a terminal', async () => {
    await expect(readTextArg(undefined, { what: 'title', stdin: terminal() })).rejects.toBeInstanceOf(UserError);
  });
});
