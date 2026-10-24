import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileCredentialStore, type Keychain, type StoredCredential } from '../src/auth/store.js';

const credential: StoredCredential = {
  kind: 'entra',
  clientId: 'client',
  tenant: 'organizations',
  refreshToken: 'a-very-secret-refresh-token',
  account: { username: 'jane@contoso.com' },
};

function memoryKeychain(): Keychain & { value: string | null } {
  const kc = {
    value: null as string | null,
    get: () => kc.value,
    set: (v: string) => {
      kc.value = v;
    },
    delete: () => {
      kc.value = null;
    },
  };
  return kc;
}

let file: string;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dova-store-')), 'nested', 'credentials.json');
});

describe('fileCredentialStore with a keychain', () => {
  it('round-trips, with nothing secret on disk and only the key in the keychain', async () => {
    const kc = memoryKeychain();
    const store = fileCredentialStore(file, async () => kc);
    expect(await store.save(credential)).toBe('keychain');

    expect(fs.readFileSync(file, 'utf8')).not.toContain('a-very-secret-refresh-token');
    expect(kc.value).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(await store.load()).toEqual(credential);
    expect(await store.storage()).toBe('keychain');
  });

  it('reads as signed out once the key is gone', async () => {
    const kc = memoryKeychain();
    const store = fileCredentialStore(file, async () => kc);
    await store.save(credential);
    kc.value = null;
    expect(await store.load()).toBeNull();
  });

  it('clears both halves', async () => {
    const kc = memoryKeychain();
    const store = fileCredentialStore(file, async () => kc);
    await store.save(credential);
    await store.clear();
    expect(fs.existsSync(file)).toBe(false);
    expect(kc.value).toBeNull();
    expect(await store.load()).toBeNull();
  });
});

describe('fileCredentialStore without a keychain', () => {
  it('falls back to a file only this user can read, and says so', async () => {
    const store = fileCredentialStore(file, async () => null);
    expect(await store.save(credential)).toBe('file');
    expect(await store.load()).toEqual(credential);
    expect(await store.storage()).toBe('file');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it('is empty when nothing was ever saved', async () => {
    const store = fileCredentialStore(file, async () => null);
    expect(await store.load()).toBeNull();
    expect(await store.storage()).toBeNull();
  });
});
