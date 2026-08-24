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

    expect(result.files.map((f) => f.file)).toContain('AGENTS.md');
    expect(result.files.map((f) => f.file)).toContain('.github/copilot-instructions.md');
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

describe('the skill', () => {
  it('installs beside the always-on block, in the cross-agent location', () => {
    const { fs, files } = fakeFs({}, [vscodeUserDir('/home/u')]);
    const result = runInstructionsInstall({ home: '/home/u', fs, block: BLOCK });

    // ~/.agents/skills is what Devin Desktop and Copilot both read.
    expect(files['/home/u/.agents/skills/dova/SKILL.md']).toBeDefined();
    expect(files['/home/u/.agents/skills/dova/references/work-items.md']).toBeDefined();
    expect(result.files.some((f) => f.file.endsWith('.agents/skills/dova/'))).toBe(true);
  });

  it('writes the skill for a --repo install too', () => {
    const { fs, files } = fakeFs();
    runInstructionsInstall({ scope: 'repo', root: '/repo', fs, block: BLOCK });
    expect(files['/repo/.agents/skills/dova/SKILL.md']).toBeDefined();
  });

  it('writes nothing on --dry-run', () => {
    const { fs, files } = fakeFs({}, [vscodeUserDir('/home/u')]);
    runInstructionsInstall({ home: '/home/u', dryRun: true, fs, block: BLOCK });
    expect(Object.keys(files)).toHaveLength(0);
  });

  it('is a no-op on re-run', () => {
    const { fs } = fakeFs({}, [vscodeUserDir('/home/u')]);
    runInstructionsInstall({ home: '/home/u', fs, block: BLOCK });
    const second = runInstructionsInstall({ home: '/home/u', fs, block: BLOCK });
    expect(second.files.find((f) => f.file.endsWith('skills/dova/'))!.action).toBe('unchanged');
  });

  it('keeps SKILL.md surface-level and puts the depth in references', async () => {
    const { SKILL_FILES } = await import('../src/lib/instructions-install.js');
    const skill = SKILL_FILES.find((f) => f.relative === 'SKILL.md')!;
    const references = SKILL_FILES.filter((f) => f.relative.startsWith('references/'));

    // The point of the split: SKILL.md is what gets loaded when the
    // skill matches, so depth belongs one level further down where it
    // costs nothing until a reference is actually opened.
    const depth = references.reduce((n, f) => n + f.content.length, 0);
    expect(depth).toBeGreaterThan(skill.content.length * 3);

    // A description is what hosts show always-on; without one the skill
    // never triggers at all.
    expect(skill.content).toMatch(/^---\nname: dova\ndescription: .+/);
    // Sharp conditions, not "read everything" — that defeats the point.
    expect(skill.content).toMatch(/references\/work-items\.md/);
    expect(skill.content).toMatch(/Do not read them all/i);
  });

  it('never sends the reader to the browser or to raw az', async () => {
    const { SKILL_FILES } = await import('../src/lib/instructions-install.js');
    for (const file of SKILL_FILES) {
      expect(file.content).not.toMatch(/dev\.azure\.com\/(?!contoso)/);
      expect(file.content).not.toMatch(/\byou may want to\b|\bit'?s worth\b/i);
    }
  });
});

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

  it('fits the tightest cap it is installed under, so one block serves both scopes', async () => {
    const { default: instructions } = await import('../src/instructions/block.md');

    // A workspace rule file allows 12,000; a global rules file only
    // 6,000. Holding the single block to the smaller number is what
    // removes the need for a second, shorter copy to keep in step.
    //
    // Measured wrapped and in *bytes*. Wrapped because the markers and
    // generated-by note are part of what gets loaded; bytes because the
    // cap comes from a secondary source that doesn't say which it
    // counts, and the block carries multi-byte glyphs (✗ ✓ —). Bytes is
    // the stricter reading.
    const wrapped = applyBlock(null, instructions).content;
    expect(Buffer.byteLength(wrapped, 'utf8')).toBeLessThan(6_000);
  });

  it('shows worked examples and states prohibitions outright', async () => {
    const { default: instructions } = await import('../src/instructions/block.md');

    // Deliberately few: two command-and-output walkthroughs for the
    // flows an agent actually runs, and the prohibitions as a bare list
    // rather than a worked example each. Examples are the expensive
    // form; spend them only where output shape is the lesson.
    expect(countWorkedExamples(instructions)).toBeGreaterThanOrEqual(2);
    expect(countWrongRightPairs(instructions)).toBeGreaterThanOrEqual(1);
    expect((instructions.match(/\*\*Never\*\*/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('commands rather than explains — imperative, not hedged', async () => {
    const { default: instructions } = await import('../src/instructions/block.md');

    // Hedging wastes the budget and reads as optional. An instruction
    // block tells the agent what to do; it does not reason with it.
    expect(instructions).not.toMatch(/\byou may want to\b|\bit'?s worth\b|\bconsider (?:using|running)\b/i);
    expect(instructions).toMatch(/\bNever\b/);
  });
});
