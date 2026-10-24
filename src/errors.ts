/** Exit codes, distinct per kind of failure so scripts can branch on them. */
export enum ExitCode {
  Success = 0,
  /** Bad input: missing or contradictory flags, malformed arguments. */
  UserError = 1,
  /** The thing asked about doesn't exist (no PR, no work item, no team). */
  NotFound = 2,
  /** Something dova needs is missing: az, a login, the daemon. */
  PrereqError = 3,
  /** A git command or Azure DevOps request failed. */
  ExternalError = 4,
  Unexpected = 5,
}

/** An error dova raises on purpose, as opposed to a bug. `hints` print under the message. */
export class DovaError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = ExitCode.UserError,
    readonly hints: string[] = []
  ) {
    super(message);
    this.name = 'DovaError';
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
 * belongs to. In a terminal, dova answers this by running `az login`.
 */
export class NotSignedInError extends PrereqError {
  constructor(
    message: string,
    readonly tenant?: string
  ) {
    super(message, [tenant ? `Run: az login --tenant ${tenant}` : 'Run: az login']);
    this.name = 'NotSignedInError';
  }
}

export class ExternalError extends DovaError {
  constructor(message: string, hints: string[] = []) {
    super(message, ExitCode.ExternalError, hints);
    this.name = 'ExternalError';
  }
}
