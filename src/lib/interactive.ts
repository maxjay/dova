import { UserError } from './errors.js';

/* ------------------------------------------------------------------ *
 * Whether dova may ask the user a question.
 *
 * An agent, a CI job, and `dova ... | jq` all run without a terminal on
 * stdin. Prompting there doesn't fail — it *hangs*, waiting on input
 * that will never arrive, which is the worst failure mode available:
 * no output, no exit code, nothing to act on. So every prompt goes
 * through this gate, and non-interactive callers get an immediate,
 * actionable error naming the flag that would have answered the
 * question instead.
 * ------------------------------------------------------------------ */

let forcedNonInteractive = false;

/** Set by `--no-input` at the CLI entrypoint. */
export function setNonInteractive(value: boolean): void {
  forcedNonInteractive = value;
}

export function isInteractive(): boolean {
  if (forcedNonInteractive) return false;
  if (process.env.DOVA_NO_INPUT) return false;
  return Boolean(process.stdin.isTTY);
}

/**
 * The error raised in place of a prompt dova can't show. `choices` is
 * folded into the hints so the caller can pick the right flag value
 * straight out of the error, without a second exploratory command.
 */
export function nonInteractiveError(
  question: string,
  hints: string[] = [],
  choices: string[] = []
): UserError {
  const all = [...hints];
  if (choices.length > 0) {
    all.push(`Available: ${choices.join(', ')}`);
  }
  all.push('(dova is running without a terminal, so it cannot ask.)');
  return new UserError(question, all);
}
