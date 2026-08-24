import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { readTextArg, stdinHasData } from '../src/lib/stdin.js';
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

describe('stdinHasData', () => {
  it('is false for a terminal or /dev/null — "not a TTY" is not the same as "has input"', () => {
    // Every agent and CI run has a non-TTY stdin with nothing on it.
    // Treating that as piped input would break `dova pr create` for
    // exactly the callers it is meant to serve.
    const devNull = fs.openSync('/dev/null', 'r');
    try {
      expect(stdinHasData(devNull)).toBe(false);
    } finally {
      fs.closeSync(devNull);
    }
  });

  it('is true for a regular file with contents, as `< body.md` gives', () => {
    const path = `${tmpdir()}/dova-stdin-${process.pid}.txt`;
    fs.writeFileSync(path, 'a description');
    const fd = fs.openSync(path, 'r');
    try {
      expect(stdinHasData(fd)).toBe(true);
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(path);
    }
  });

  it('is false for an empty file — nothing to lose, so nothing to warn about', () => {
    const path = `${tmpdir()}/dova-stdin-empty-${process.pid}.txt`;
    fs.writeFileSync(path, '');
    const fd = fs.openSync(path, 'r');
    try {
      expect(stdinHasData(fd)).toBe(false);
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(path);
    }
  });

  it('is false rather than throwing on a closed descriptor', () => {
    expect(stdinHasData(9999)).toBe(false);
  });
});
