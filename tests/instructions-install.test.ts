import { describe, it, expect } from 'vitest';
import {
  applyBlock,
  resolveAgentsFile,
  runInstructionsInstall,
  checkCopilotDisabled,
  BLOCK_START,
  BLOCK_END,
  type FileSystemLike,
} from '../src/lib/instructions-install.js';

const BLOCK = 'RULES GO HERE';

/** In-memory FileSystemLike, seeded with whatever files should already exist. */
function fakeFs(seed: Record<string, string> = {}) {
  const files = { ...seed };
  const made: string[] = [];
  const fs: FileSystemLike = {
    readFile: (file) => files[file] ?? null,
    writeFile: (file, content) => {
      files[file] = content;
    },
    mkdirp: (dir) => {
      made.push(dir);
    },
  };
  return { fs, files, made };
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

describe('runInstructionsInstall', () => {
  it('writes both files — neither target reads the other one by default', () => {
    const { fs, files } = fakeFs();
    const result = runInstructionsInstall({ root: '/repo', fs, block: BLOCK });

    expect(result.files.map((f) => f.file)).toEqual(['AGENTS.md', '.github/copilot-instructions.md']);
    expect(files['/repo/AGENTS.md']).toContain(BLOCK);
    expect(files['/repo/.github/copilot-instructions.md']).toContain(BLOCK);
  });

  it('appends into an existing lowercase agents.md instead of making a duplicate', () => {
    const { fs, files } = fakeFs({ '/repo/agents.md': '# Our repo\n' });
    const result = runInstructionsInstall({ root: '/repo', fs, block: BLOCK });

    expect(result.files[0]!.file).toBe('agents.md');
    expect(result.files[0]!.action).toBe('appended');
    expect(files['/repo/AGENTS.md']).toBeUndefined();
    expect(files['/repo/agents.md']).toContain(BLOCK);
  });

  it('writes nothing at all on --dry-run', () => {
    const { fs, files, made } = fakeFs();
    const result = runInstructionsInstall({ root: '/repo', dryRun: true, fs, block: BLOCK });

    expect(result.files.every((f) => f.action === 'created')).toBe(true);
    expect(Object.keys(files)).toHaveLength(0);
    expect(made).toHaveLength(0);
  });

  it('creates .github/ when it does not exist', () => {
    const { fs, made } = fakeFs();
    runInstructionsInstall({ root: '/repo', fs, block: BLOCK });
    expect(made.some((d) => d.endsWith('.github'))).toBe(true);
  });

  it('surfaces the Copilot-disabled warning alongside a successful write', () => {
    const { fs } = fakeFs({
      '/repo/.vscode/settings.json': '{"github.copilot.chat.codeGeneration.useInstructionFiles": false}',
    });
    const result = runInstructionsInstall({ root: '/repo', fs, block: BLOCK });

    // The files are still written correctly — they'd just be ignored.
    expect(result.files.every((f) => f.action === 'created')).toBe(true);
    expect(result.warnings).toHaveLength(1);
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

    // Few-shot: complete command-plus-output scenarios, and explicit
    // wrong/right pairs for the mistakes that are otherwise silent.
    expect(instructions.match(/### Worked example/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(instructions).toContain('### Common mistakes');
    expect(instructions).toMatch(/✗ dova pr view 612/);
    expect(instructions).toMatch(/✓ dova summarize 612/);
  });
});
