import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonClient, daemonPaths, fromWire, serve, type Paths } from '../src/daemon.js';
import { ExitCode, NotFoundError, NotSignedInError } from '../src/errors.js';

let paths: Paths;
let daemon: { close(): void };

beforeAll(async () => {
  paths = daemonPaths({ DOVA_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dova-d-')) });
  // A token source failing the way az does when nobody's logged in: no az, no network.
  daemon = await serve({ paths, tokenSource: () => Promise.reject(new NotSignedInError('Not logged in to Azure CLI.')) });
});
afterAll(() => daemon.close());

describe('daemon', () => {
  it('is private to this user', () => {
    if (process.platform === 'win32') return;
    expect(fs.statSync(paths.socket).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.key).mode & 0o777).toBe(0o600);
  });

  it('answers hello and several calls at once on one connection', async () => {
    const open = (await DaemonClient.open(paths))!;
    expect(open.status.pid).toBe(process.pid);
    const [a, b] = await Promise.all([open.client.call('daemon.status'), open.client.call('auth.status')]);
    expect(a).toMatchObject({ pid: process.pid });
    expect(b).toMatchObject({ signedIn: false });
    open.client.close();
  });

  it('hands back errors as the same class, so the CLI can run az login', async () => {
    const open = (await DaemonClient.open(paths))!;
    const err = (await open.client.call('ado.request', { method: 'GET', url: 'https://dev.azure.com/contoso/_apis/x?secret=1' }).catch((e: unknown) => e)) as NotSignedInError;
    expect(err).toBeInstanceOf(NotSignedInError);
    expect(err.exitCode).toBe(ExitCode.PrereqError);
    open.client.close();
    expect(fs.readFileSync(paths.log, 'utf8')).not.toContain('secret');
  });

  it('turns away a client without the key', async () => {
    const key = fs.readFileSync(paths.key);
    fs.writeFileSync(paths.key, 'wrong');
    try {
      expect(await DaemonClient.open(paths)).toBeNull();
    } finally {
      fs.writeFileSync(paths.key, key);
    }
  });

  it('keeps the tenant of a NotSignedInError across the wire', () => {
    expect(fromWire({ name: 'NotSignedInError', message: 'x', hints: [], exitCode: 3, tenant: 'guest' })).toMatchObject({ tenant: 'guest' });
    expect(fromWire({ name: 'NotFoundError', message: 'x', hints: ['h'], exitCode: 2 })).toBeInstanceOf(NotFoundError);
  });

  it('puts a socket that would be too long somewhere short', () => {
    const p = daemonPaths({ DOVA_HOME: `/home/j/${'deep/'.repeat(25)}dova` }, 'linux');
    expect(p.socket).toMatch(/^\/tmp\/dova-.+\/dovad\.sock$/);
  });
});
