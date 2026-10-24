import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDaemon } from '../src/daemon/server.js';
import { DaemonConnection } from '../src/daemon/client.js';
import { fromWireError, toWireError, type DaemonStatus } from '../src/daemon/protocol.js';
import { dovaPaths, type DovaPaths } from '../src/lib/paths.js';
import { ExitCode, NotFoundError, PrereqError, UserError } from '../src/lib/errors.js';

/**
 * The real daemon, in this process, on a socket in a temp dir. Its token
 * source fails as az does when nobody's logged in, so nothing here runs
 * az or touches the network.
 */
let paths: DovaPaths;
let daemon: { close: () => Promise<void> };

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dova-d-'));
  paths = dovaPaths({ DOVA_HOME: home });
  daemon = await runDaemon({
    paths,
    tokenSource: () => Promise.reject(new PrereqError('Not logged in to Azure CLI (or the login expired).', ['Run: dova auth login'])),
  });
});

afterAll(async () => {
  await daemon.close();
});

describe('dova daemon', () => {
  it('writes its key and socket for this user only', () => {
    if (process.platform === 'win32') return;
    expect(fs.statSync(paths.keyFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.socket).mode & 0o777).toBe(0o600);
  });

  it('answers hello and status', async () => {
    const { connection, hello } = await DaemonConnection.open(paths);
    expect(hello.pid).toBe(process.pid);
    const status = (await connection.call('daemon.status')) as DaemonStatus;
    expect(status).toMatchObject({ socket: paths.socket, logFile: paths.logFile, service: false });
    connection.close();
  });

  it('turns away a client without the session key', async () => {
    const realKey = fs.readFileSync(paths.keyFile, 'utf8');
    fs.writeFileSync(paths.keyFile, 'wrong');
    try {
      await expect(DaemonConnection.open(paths)).rejects.toThrow(/session key/);
    } finally {
      fs.writeFileSync(paths.keyFile, realKey);
    }
  });

  it('reports not signed in, as the same error class and exit code the CLI would raise itself', async () => {
    const { connection } = await DaemonConnection.open(paths);
    expect(await connection.call('auth.status')).toMatchObject({ signedIn: false });
    const err = await connection.call('ado.request', { method: 'GET', url: 'https://dev.azure.com/contoso/_apis/projects' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrereqError);
    expect((err as PrereqError).exitCode).toBe(ExitCode.PrereqError);
    expect((err as PrereqError).hints).toContain('Run: dova auth login');
    connection.close();
  });

  it('keeps several calls in flight on one connection', async () => {
    const { connection } = await DaemonConnection.open(paths);
    const results = await Promise.all([
      connection.call('daemon.status'),
      connection.call('auth.status'),
      connection.call('nope').catch((e: unknown) => e),
      connection.call('daemon.status'),
    ]);
    expect((results[0] as DaemonStatus).pid).toBe(process.pid);
    expect(results[1]).toMatchObject({ signedIn: false });
    expect(results[2]).toBeInstanceOf(UserError);
    expect((results[3] as DaemonStatus).pid).toBe(process.pid);
    connection.close();
  });

  it('logs request paths, never query strings', async () => {
    const { connection } = await DaemonConnection.open(paths);
    await connection.call('ado.request', { method: 'GET', url: 'https://dev.azure.com/contoso/_apis/x?secret=hunter2' }).catch(() => {});
    connection.close();
    const log = fs.readFileSync(paths.logFile, 'utf8');
    expect(log).toContain('/contoso/_apis/x');
    expect(log).not.toContain('hunter2');
  });
});

describe('wire errors', () => {
  it('round-trip the class, hints and exit code', () => {
    const back = fromWireError(toWireError(new NotFoundError('gone', ['look elsewhere'])));
    expect(back).toBeInstanceOf(NotFoundError);
    expect((back as NotFoundError).hints).toEqual(['look elsewhere']);
  });

  it('keep an unexpected error unexpected', () => {
    const back = fromWireError(toWireError(new TypeError('boom')));
    expect(back).not.toBeInstanceOf(UserError);
    expect(back.message).toBe('boom');
  });
});
