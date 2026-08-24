import { describe, it, expect, afterEach } from 'vitest';
import { isInteractive, setNonInteractive, nonInteractiveError } from '../src/lib/interactive.js';
import { defaultPrompts } from '../src/lib/team-resolver.js';
import { UserError } from '../src/lib/errors.js';

afterEach(() => {
  setNonInteractive(false);
  delete process.env.DOVA_NO_INPUT;
});

describe('isInteractive', () => {
  it('is false once --no-input has been applied', () => {
    setNonInteractive(true);
    expect(isInteractive()).toBe(false);
  });

  it('is false when $DOVA_NO_INPUT is set, without any flag', () => {
    process.env.DOVA_NO_INPUT = '1';
    expect(isInteractive()).toBe(false);
  });

  it('follows stdin.isTTY when nothing overrides it', () => {
    expect(isInteractive()).toBe(Boolean(process.stdin.isTTY));
  });
});

describe('nonInteractiveError', () => {
  it('puts the answering flag and the real available values into the hints', () => {
    const err = nonInteractiveError('Which team?', ['Pass --team <name>.'], ['Platform', 'Payments']);
    expect(err).toBeInstanceOf(UserError);
    expect(err.hints[0]).toBe('Pass --team <name>.');
    expect(err.hints[1]).toBe('Available: Platform, Payments');
  });
});

describe('defaultPrompts under --no-input', () => {
  it('throws rather than hanging when asked to select, naming the choices', async () => {
    setNonInteractive(true);
    await expect(
      defaultPrompts.select({
        message: 'Which team?',
        choices: [{ name: 'Platform', value: 'Platform' }],
        nonInteractiveHint: ['Pass --team <name>.'],
      })
    ).rejects.toThrow(/Which team\?/);
  });

  it('answers "no" to a confirm instead of erroring — every confirm has a safe no', async () => {
    setNonInteractive(true);
    // Both call sites (save to git config, switch branches) are side
    // effects the caller never asked for, so declining is always safe.
    expect(await defaultPrompts.confirm({ message: 'Save this?', default: true })).toBe(false);
  });
});
