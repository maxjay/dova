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
 * Azure CLI expands any argument beginning with `@` by reading that file
 * (`_expand_file_prefixed_files`, run from `_pre_command_table_create`,
 * so it applies to every command and every argument — extensions
 * included, not just `az rest --body`). Writing the text to a temp file
 * and passing `@<path>` means the only thing on the command line is a
 * short, newline-free path, and Python reads the real text off disk.
 *
 * This also lifts Windows' ~32k command-line limit off long bodies.
 *
 * The file lives in its own temp directory, removed when `run` settles.
 */
export async function withAzFileArg<T>(text: string, run: (arg: string) => Promise<T>): Promise<T> {
  // Its own directory: the name is then ours to control, so it can't
  // contain `=` — az splits an argument on the first `=` before looking
  // for the `@`, and a path containing one would be truncated.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dova-'));
  const file = path.join(dir, 'body.txt');
  try {
    await fs.writeFile(file, text, 'utf8');
    return await run(`@${file}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {
      // A leftover temp file is not worth failing a created PR over.
    });
  }
}
