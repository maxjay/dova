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
  /** git isn't installed, or dova isn't signed in (or its daemon can't start). */
  PrereqError = 3,
  /** An underlying git/REST call failed for a reason other than "not found". */
  ExternalError = 4,
  /** Anything we didn't anticipate. */
  Unexpected = 5,
}

/** Base class for all errors dova raises deliberately (as opposed to bugs). */
export class DovaError extends Error {
  readonly exitCode: ExitCode;
  /** Extra lines of guidance printed under the main message (e.g. "Run: az login"). */
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

/**
 * az has no usable login — none at all, or none for the tenant an org
 * belongs to. Its own class because a terminal session answers it by
 * running `az login` on the spot (see transport.ts) rather than failing.
 */
export class NotSignedInError extends PrereqError {
  constructor(message: string, readonly tenant?: string) {
    super(message, [tenant ? `Run: az login --tenant ${tenant}` : 'Run: az login']);
    this.name = 'NotSignedInError';
  }
}

export class ExternalCommandError extends DovaError {
  constructor(message: string, hints: string[] = []) {
    super(message, ExitCode.ExternalError, hints);
    this.name = 'ExternalCommandError';
  }
}
