import { describe, it, expect } from 'vitest';
import {
  applyBlock,
  resolveAgentsFile,
  TARGETS,
  runInstructionsInstall,
  checkCopilotDisabled,
  BLOCK_START,
  BLOCK_END,
  type FileSystemLike,
} from '../src/lib/instructions-install.js';

const BLOCK = 'RULES GO HERE';

/**
 * In-memory FileSystemLike, seeded with whatever files should already
 * exist. Keys are normalized to forward slashes so the fixtures below
 * can be written POSIX-style and still match on Windows, where
 * path.join hands back backslash-separated paths.
 */
const norm = (p: string) => p.replace(/\\/g, '/');

function fakeFs(seed: Record<string, string> = {}, dirs: string[] = []) {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(seed)) files[norm(k)] = v;
  const existingDirs = new Set(dirs.map(norm));
  const made: string[] = [];
  const fs: FileSystemLike = {
    readFile: (file) => files[norm(file)] ?? null,
    writeFile: (file, content) => {
      files[norm(file)] = content;
    },
    mkdirp: (dir) => {
      made.push(norm(dir));
    },
    exists: (target) => existingDirs.has(norm(target)) || files[norm(target)] !== undefined,
  };
  return { fs, files, made };
}

/** VS Code's user dir on this platform, so the fixtures below match wherever they run. */
function vscodeUserDir(home: string): string {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA ?? `${home}/AppData/Roaming`
      : process.platform === 'darwin'
        ? `${home}/Library/Application Support`
        : `${home}/.config`;
  return norm(`${base}/Code/User`);
}

describe('applyBlock', () => {
  it('creates a standalone block when there is no file yet', () => {
    const { content, action } = applyBlock(null, BLOCK);
    expect(action).toBe('created');
    expect(content).toContain(BLOCK_START);
    expect(content).toContain(BLOCK);
    expect(content.trimEnd().endsWith(BLOCK_END)).toBe(true);
  });

  it('appends to a file that already says other things, keeping them', () => {
    const existing = '# Our repo\n\nRun `npm test` before pushing.\n';
    const { content, action } = applyBlock(existing, BLOCK);
    expect(action).toBe('appended');
    expect(content.startsWith(existing)).toBe(true);
    expect(content).toContain(BLOCK);
  });

  it('replaces an existing block in place, preserving text on BOTH sides', () => {
    const first = applyBlock('# Top matter\n', BLOCK).content + '\n## Trailing section\nKeep me.\n';
    const { content, action } = applyBlock(first, 'REPLACEMENT RULES');

    expect(action).toBe('updated');
    expect(content).toContain('# Top matter');
    expect(content).toContain('Keep me.');
    expect(content).toContain('REPLACEMENT RULES');
    expect(content).not.toContain(BLOCK);
    // Exactly one block — the whole point of the markers.
    expect(content.split(BLOCK_START)).toHaveLength(2);
  });

  it('reports "unchanged" when the block is already exactly right, so a re-run is a no-op', () => {
    const first = applyBlock(null, BLOCK).content;
    expect(applyBlock(first, BLOCK).action).toBe('unchanged');
  });

  it('does not grow the file on repeated runs', () => {
    let content = applyBlock(null, BLOCK).content;
    for (let i = 0; i < 5; i++) content = applyBlock(content, BLOCK).content;
    expect(content.split(BLOCK_START)).toHaveLength(2);
  });
});

describe('checkCopilotDisabled', () => {
  it('spots useInstructionFiles:false even in a settings file with comments and trailing commas', () => {
    // Real VS Code settings files are JSONC — JSON.parse would throw on
    // this, and a parse failure must not take the install down with it.
    const { fs } = fakeFs({
      '/repo/.vscode/settings.json': '{\n  // from our template\n  "github.copilot.chat.codeGeneration.useInstructionFiles": false,\n}',
    });
    expect(checkCopilotDisabled(fs, '/repo')).toMatch(/useInstructionFiles/);
  });

  it('says nothing when the setting is absent or true', () => {
    expect(checkCopilotDisabled(fakeFs({}).fs, '/repo')).toBeNull();
    const { fs } = fakeFs({
      '/repo/.vscode/settings.json': '{"github.copilot.chat.codeGeneration.useInstructionFiles": true}',
    });
    expect(checkCopilotDisabled(fs, '/repo')).toBeNull();
  });
});

describe('TARGETS', () => {
  it('names files with forward slashes on every platform', () => {
    // These strings are printed and returned in --json, so they must not
    // vary by platform — building them with path.join would yield
    // `.github\\copilot-instructions.md` on Windows.
    for (const target of TARGETS) {
      expect(target.file).not.toContain('\\');
    }
  });
});

describe('resolveAgentsFile', () => {
  it('prefers the canonical AGENTS.md when the repo has neither', () => {
    expect(resolveAgentsFile(fakeFs({}).fs, '/repo')).toBe('AGENTS.md');
  });

  it('writes into an existing lowercase agents.md rather than creating a second file', () => {
    // Devin Desktop reads either spelling, so on a case-sensitive
    // filesystem creating AGENTS.md alongside agents.md would leave two
    // rule files both being fed to the agent.
    const { fs } = fakeFs({ '/repo/agents.md': '# existing\n' });
    expect(resolveAgentsFile(fs, '/repo')).toBe('agents.md');
  });

  it('keeps AGENTS.md when that is the one that exists', () => {
    const { fs } = fakeFs({ '/repo/AGENTS.md': '# existing\n' });
    expect(resolveAgentsFile(fs, '/repo')).toBe('AGENTS.md');
  });
});

describe('runInstructionsInstall (global — the default)', () => {
  it('installs globally when no scope is given, because dova itself is installed globally', () => {
    const { fs, files } = fakeFs({}, [vscodeUserDir('/home/u')]);
    const result = runInstructionsInstall({ home: '/home/u', fs, block: BLOCK });

    expect(result.scope).toBe('global');
    expect(files['/home/u/.codeium/windsurf/memories/global_rules.md']).toContain(BLOCK);
    expect(files[`${vscodeUserDir('/home/u')}/prompts/dova.instructions.md`]).toContain(BLOCK);
  });

  it("gives the VS Code file an applyTo frontmatter, or it wouldn't apply outside a glob", () => {
    const { fs, files } = fakeFs({}, [vscodeUserDir('/home/u')]);
    runInstructionsInstall({ home: '/home/u', fs, block: BLOCK });

    const written = files[`${vscodeUserDir('/home/u')}/prompts/dova.instructions.md`]!;
    expect(written.startsWith("---\napplyTo: '**'\n---\n")).toBe(true);
  });

  it('does not re-add the frontmatter when updating an existing file', () => {
    const { fs, files } = fakeFs({}, [vscodeUserDir('/home/u')]);
    runInstructionsInstall({ home: '/home/u', fs, block: BLOCK });
    runInstructionsInstall({ home: '/home/u', fs, block: 'NEW RULES' });

    const written = files[`${vscodeUserDir('/home/u')}/prompts/dova.instructions.md`]!;
    expect(written.match(/applyTo/g)).toHaveLength(1);
    expect(written).toContain('NEW RULES');
  });

  it('leaves rules the user already had in global_rules.md alone', () => {
    const { fs, files } = fakeFs(
      { '/home/u/.codeium/windsurf/memories/global_rules.md': '## My own rule\nAlways use tabs.\n' },
      [vscodeUserDir('/home/u')]
    );
    runInstructionsInstall({ home: '/home/u', fs, block: BLOCK });

    const written = files['/home/u/.codeium/windsurf/memories/global_rules.md']!;
    expect(written).toContain('Always use tabs.');
    expect(written).toContain(BLOCK);
  });

  it('only targets VS Code flavours actually installed, rather than littering', () => {
    const { fs } = fakeFs({}, [vscodeUserDir('/home/u')]); // stable only
    const result = runInstructionsInstall({ home: '/home/u', fs, block: BLOCK });

    expect(result.files.filter((f) => f.file.includes('dova.instructions.md'))).toHaveLength(1);
  });
});

describe('runInstructionsInstall (--repo)', () => {
  it('writes both files — neither target reads the other one by default', () => {
    const { fs, files } = fakeFs();
    const result = runInstructionsInstall({ scope: 'repo', root: '/repo', fs, block: BLOCK });

    expect(result.scope).toBe('repo');

    expect(result.files.map((f) => f.file)).toEqual(['AGENTS.md', '.github/copilot-instructions.md']);
    expect(files['/repo/AGENTS.md']).toContain(BLOCK);
    expect(files['/repo/.github/copilot-instructions.md']).toContain(BLOCK);
  });

  it('appends into an existing lowercase agents.md instead of making a duplicate', () => {
    const { fs, files } = fakeFs({ '/repo/agents.md': '# Our repo\n' });
    const result = runInstructionsInstall({ scope: 'repo', root: '/repo', fs, block: BLOCK });

    expect(result.files[0]!.file).toBe('agents.md');
    expect(result.files[0]!.action).toBe('appended');
    expect(files['/repo/AGENTS.md']).toBeUndefined();
    expect(files['/repo/agents.md']).toContain(BLOCK);
  });

  it('writes nothing at all on --dry-run', () => {
    const { fs, files, made } = fakeFs();
    const result = runInstructionsInstall({ scope: 'repo', root: '/repo', dryRun: true, fs, block: BLOCK });

    expect(result.files.every((f) => f.action === 'created')).toBe(true);
    expect(Object.keys(files)).toHaveLength(0);
    expect(made).toHaveLength(0);
  });

  it('creates .github/ when it does not exist', () => {
    const { fs, made } = fakeFs();
    runInstructionsInstall({ scope: 'repo', root: '/repo', fs, block: BLOCK });
    expect(made.some((d) => d.endsWith('.github'))).toBe(true);
  });

  it('surfaces the Copilot-disabled warning alongside a successful write', () => {
    const { fs } = fakeFs({
      '/repo/.vscode/settings.json': '{"github.copilot.chat.codeGeneration.useInstructionFiles": false}',
    });
    const result = runInstructionsInstall({ scope: 'repo', root: '/repo', fs, block: BLOCK });

    // The files are still written correctly — they'd just be ignored.
    expect(result.files.every((f) => f.action === 'created')).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});

/** A worked example is a console block that shows a command *and* its output. */
function countWorkedExamples(block: string): number {
  return (block.match(/```console\n[\s\S]*?```/g) ?? []).filter((b) => /^\$ /m.test(b) && b.split('\n').length > 3).length;
}

/** A wrong/right pair is a ✗ line — the form that teaches what not to do. */
function countWrongRightPairs(block: string): number {
  return (block.match(/^✗ /gm) ?? []).length;
}

describe('the shipped instructions block', () => {
  it('imports as real content and carries the rules that cannot be enforced in code', async () => {
    const { default: instructions } = await import('../src/instructions/block.md');

    expect(instructions.length).toBeGreaterThan(500);
    // The two irreducible rules — everything else became a guard in code.
    expect(instructions).toMatch(/dova link[\s\S]*dova pr create/);
    expect(instructions).toMatch(/az boards work-item update/);
    // dova's own standing rule: no organization-specific values anywhere.
    expect(instructions).not.toMatch(/dev\.azure\.com\/(?!contoso)/);
  });

  it('the global block fits the 6,000-character cap on a global rules file', async () => {
    const { default: globalBlock } = await import('../src/instructions/global-block.md');

    // Devin's global rules file is capped at 6,000 — half the workspace
    // limit — which is why the global install ships a separate, shorter
    // block rather than the same text.
    //
    // Measured wrapped and in *bytes*. Wrapped because the markers and
    // generated-by note are part of what gets loaded; bytes because the
    // cap comes from a secondary source that doesn't say whether it
    // counts bytes or characters, and this block is full of multi-byte
    // glyphs (✗ ✓ — ·) — 58 bytes' worth. Bytes is the stricter reading,
    // so it's the safe one to hold ourselves to.
    const wrapped = applyBlock(null, globalBlock).content;
    expect(Buffer.byteLength(wrapped, 'utf8')).toBeLessThan(6_000);
    // States the rule outright rather than making it conditional on the
    // remote: a condition would have the agent check where the repo is
    // hosted before it can act, every time, for no gain.
    expect(globalBlock).not.toMatch(/when a repo'?s git remote/i);
    // The rules that cannot be enforced in code survive the condensing.
    expect(globalBlock).toMatch(/dova link[\s\S]*dova pr create/);
    expect(globalBlock).toMatch(/az boards work-item update/);
    // And so does the few-shot. Asserted structurally rather than by
    // heading text, which is presentation and gets reworded.
    expect(countWorkedExamples(globalBlock)).toBeGreaterThanOrEqual(3);
    expect(countWrongRightPairs(globalBlock)).toBeGreaterThanOrEqual(3);
  });

  it('stays under the 12,000-character cap a workspace rule file is allowed', async () => {
    const { default: instructions } = await import('../src/instructions/block.md');

    // AGENTS.md feeds the same rules engine as .devin/rules/, where a
    // workspace rule file is capped at 12,000 characters. Going over
    // doesn't error — the content is just not all there — so this is
    // the only thing that would catch it.
    expect(instructions.length).toBeLessThan(12_000);
  });

  it('teaches by worked example, not by rules alone', async () => {
    const { default: instructions } = await import('../src/instructions/block.md');

    expect(countWorkedExamples(instructions)).toBeGreaterThanOrEqual(4);
    expect(countWrongRightPairs(instructions)).toBeGreaterThanOrEqual(4);
  });

  it('commands rather than explains — imperative, not hedged', async () => {
    const { default: instructions } = await import('../src/instructions/block.md');
    const { default: globalBlock } = await import('../src/instructions/global-block.md');

    // Hedging wastes the budget and reads as optional. An instruction
    // block should tell the agent what to do, not reason with it.
    for (const block of [instructions, globalBlock]) {
      expect(block).not.toMatch(/\byou may want to\b|\bit'?s worth\b|\bconsider (?:using|running)\b/i);
      expect(block).toMatch(/\bNever\b/);
    }
  });
});
