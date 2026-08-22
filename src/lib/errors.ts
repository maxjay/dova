/**
 * Exit codes, mirrored across every command so dova is scriptable
 * (see gh's convention, which this follows closely).
 */
export enum ExitCode {
  Success = 0,
  /** Bad input from the user: missing/contradictory flags, malformed args. */
  UserError = 1,
  /** The thing the user asked about doesn't exist (no PR, no work item, no team). */
  NotFound = 2,
  /** az/git isn't installed, isn't logged in, or the azure-devops extension is missing. */
  PrereqError = 3,
  /** An underlying az/git/REST call failed for a reason other than "not found". */
  ExternalError = 4,
  /** Anything we didn't anticipate. */
  Unexpected = 5,
}

/** Base class for all errors dova raises deliberately (as opposed to bugs). */
export class DovaError extends Error {
  readonly exitCode: ExitCode;
  /** Extra lines of guidance printed under the main message (e.g. "run: az login"). */
  readonly hints: string[];

  constructor(message: string, exitCode: ExitCode = ExitCode.UserError, hints: string[] = []) {
    super(message);
    this.name = 'DovaError';
    this.exitCode = exitCode;
    this.hints = hints;
  }
}

export class UserError extends DovaError {
  constructor(message: string, hints: string[] = []) {
    super(message, ExitCode.UserError, hints);
    this.name = 'UserError';
  }
}

export class NotFoundError extends DovaError {
  constructor(message: string, hints: string[] = []) {
    super(message, ExitCode.NotFound, hints);
    this.name = 'NotFoundError';
  }
}

export class PrereqError extends DovaError {
  constructor(message: string, hints: string[] = []) {
    super(message, ExitCode.PrereqError, hints);
    this.name = 'PrereqError';
  }
}

export class ExternalCommandError extends DovaError {
  constructor(message: string, hints: string[] = []) {
    super(message, ExitCode.ExternalError, hints);
    this.name = 'ExternalCommandError';
  }
}

/**
 * A nonexistent id (work item, PR, ...) surfaces as a nonzero `az` exit,
 * not a clean empty result — e.g. "TF401232: Work item 999 does not
 * exist, or you do not have permissions to read it." This is a
 * best-effort text match over that class of error, used to turn an
 * `ExternalCommandError` into a `NotFoundError` where it's worth telling
 * those apart (e.g. `dova view`'s "try work item, then try PR" fallback).
 */
export function looksLikeAzNotFoundError(message: string): boolean {
  return /does not exist|was not found|no such (pull request|work item)|TF401232|TF401180|404/i.test(message);
}
