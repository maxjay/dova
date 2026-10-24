import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { DovaError, ExitCode, ExternalCommandError, NotFoundError, PrereqError, UserError } from '../lib/errors.js';
import { DOVA_VERSION } from '../lib/version.js';

/* ------------------------------------------------------------------ *
 * The CLI <-> daemon wire format: newline-delimited JSON over a Unix
 * socket (a named pipe on Windows).
 *
 *   client -> daemon   { id, method, params }
 *   daemon -> client   { id, result } | { id, error } | { id, event }
 *
 * `event` is progress for a call still in flight (a login waiting on
 * the browser). Several calls can be in flight on one connection —
 * `dova status` sends its requests all at once.
 *
 * The first call on every connection must be `hello`, carrying the
 * session key the daemon wrote to a user-only file when it started.
 * Socket permissions already keep other users out on Unix; on Windows
 * a named pipe's default ACL is looser than that, and the key is what
 * holds the line.
 * ------------------------------------------------------------------ */

export interface WireRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface WireError {
  name: string;
  message: string;
  hints: string[];
  exitCode: number;
}

export type WireResponse =
  | { id: number; result: unknown }
  | { id: number; error: WireError }
  | { id: number; event: unknown };

export interface HelloParams {
  key: string;
  build: string;
}

export interface HelloResult {
  build: string;
  pid: number;
  startedAt: string;
}

export interface DaemonStatus extends HelloResult {
  version: string;
  socket: string;
  logFile: string;
  requests: number;
  /** Launched by the OS at login (`dova daemon install`), rather than on demand by the CLI. */
  service: boolean;
}

/**
 * Identifies this exact build of dova, so a CLI never talks to a daemon
 * left running from before an upgrade. The version alone wouldn't catch
 * a rebuild, so the bundle's own mtime goes in too.
 */
export function buildId(): string {
  let stamp = '';
  try {
    stamp = String(Math.floor(fs.statSync(fileURLToPath(import.meta.url)).mtimeMs));
  } catch {
    // Not running from a file (bundled into something else) — version only.
  }
  return `${DOVA_VERSION}+${stamp}`;
}

export function toWireError(err: unknown): WireError {
  if (err instanceof DovaError) {
    return { name: err.name, message: err.message, hints: err.hints, exitCode: err.exitCode };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { name: 'Error', message, hints: [], exitCode: ExitCode.Unexpected };
}

/** Rebuilds the same error class on the CLI side, so exit codes and `instanceof` checks behave as if it were thrown locally. */
export function fromWireError(wire: WireError): Error {
  switch (wire.name) {
    case 'UserError':
      return new UserError(wire.message, wire.hints);
    case 'NotFoundError':
      return new NotFoundError(wire.message, wire.hints);
    case 'PrereqError':
      return new PrereqError(wire.message, wire.hints);
    case 'ExternalCommandError':
      return new ExternalCommandError(wire.message, wire.hints);
    default:
      return wire.exitCode === ExitCode.Unexpected ? new Error(wire.message) : new DovaError(wire.message, wire.exitCode, wire.hints);
  }
}

/** Calls `onMessage` for every complete JSON line arriving on `socket`. A malformed line closes the connection. */
export function readMessages(socket: Socket, onMessage: (message: unknown) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      onMessage(message);
    }
  });
}

export function writeMessage(socket: Socket, message: WireRequest | WireResponse): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}
