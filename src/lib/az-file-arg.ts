import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Hands `az` a block of text without ever putting it on a command line.
 *
 * A literal newline cannot survive an argument on Windows: `az` is
 * `az.cmd`, so spawning it goes through `cmd.exe /c`, and cmd rebuilds
 * the command line as a single string with no way to escape a newline
 * inside an argument. A multi-line `--description` therefore arrives
 * empty or cut at the first line, and `az` reports success either way —
 * a PR created with no body.
 *
 * Quotes are the other half of the same problem, and the reason a JSON
 * body is the worst case. cross-spawn wraps each argument in `"…"` and
 * escapes cmd metacharacters with `^`, which survives the *first* parse
 * — the one cmd does for `/d /s /c`. But `az` is `az.cmd`, a batch file
 * that forwards its arguments with `%*`, so everything is parsed a
 * second time with those `^` escapes already spent. Text inside the
 * surviving quotes is still safe, which is why `--title 'feat(x): y'`
 * and a WIQL `IN (4821)` work. A JSON body does not survive: it is full
 * of `"`, each one closing the quoted run and exposing whatever follows.
 * `hasViewPermission()` then reaches cmd as a bare empty group, and cmd
 * fails with `per was unexpected at this time`.
 *
 * Azure CLI expands any argument beginning with `@` by reading that file
 * (`_expand_file_prefixed_files`, run from `_pre_command_table_create`,
 * so it applies to every command and every argument — extensions
 * included, not just `az rest --body`). Writing the text to a temp file
 * and passing `@<path>` means the only thing on the command line is a
 * short path with no quote, newline or metacharacter in it, and Python
 * reads the real text off disk.
 *
 * This also lifts Windows' ~32k command-line limit off long bodies.
 *
 * Files live in one temp directory, removed when `run` settles.
 */
export async function withAzFiles<T>(run: (toFileArg: (text: string) => Promise<string>) => Promise<T>): Promise<T> {
  // Its own directory: the name is then ours to control, so it can't
  // contain `=` — az splits an argument on the first `=` before looking
  // for the `@`, and a path containing one would be truncated.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dova-'));
  let n = 0;
  try {
    return await run(async (text) => {
      const file = path.join(dir, `arg${n++}.txt`);
      await fs.writeFile(file, text, 'utf8');
      return `@${file}`;
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {
      // A leftover temp file is not worth failing a created PR over.
    });
  }
}

/** `withAzFiles` for the common single-value case. */
export async function withAzFileArg<T>(text: string, run: (arg: string) => Promise<T>): Promise<T> {
  return withAzFiles((toFileArg) => toFileArg(text).then(run));
}
