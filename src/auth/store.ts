import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Where a sign-in survives a restart.
 *
 * The credential itself — a refresh token is a couple of kilobytes —
 * is AES-256-GCM encrypted into a file, and only the 32-byte key goes
 * in the OS keychain (Keychain on macOS, Credential Manager on Windows,
 * the Secret Service on Linux). Windows caps a stored credential at
 * 2560 bytes, which a refresh token can blow through on its own, so the
 * key-in-keychain split is what makes one scheme work everywhere.
 *
 * With no keychain at all (a headless Linux box with no Secret Service)
 * the credential is written in the clear to a 0600 file instead, the
 * same trade gh makes, and `dova auth status` says so.
 * ------------------------------------------------------------------ */

export interface StoredAccount {
  username?: string;
  name?: string;
}

export type StoredCredential =
  | {
      kind: 'entra';
      clientId: string;
      /** The authority signed in against: `organizations`, or a tenant the user named. */
      tenant: string;
      /** The user's own tenant, from the id token. */
      homeTenant?: string;
      refreshToken: string;
      account: StoredAccount;
    }
  | {
      kind: 'pat';
      token: string;
      account: StoredAccount;
    };

export type StorageKind = 'keychain' | 'file';

export interface CredentialStore {
  load(): Promise<StoredCredential | null>;
  /** Returns where it ended up. */
  save(credential: StoredCredential): Promise<StorageKind>;
  clear(): Promise<void>;
  /** Where the current credential is, or null if there isn't one. */
  storage(): Promise<StorageKind | null>;
}

/** The slice of a keychain this needs — injectable so tests never touch the real one. */
export interface Keychain {
  get(): string | null;
  set(value: string): void;
  delete(): void;
}

type FileFormat =
  | { v: 1; scheme: 'keychain-aes-256-gcm'; iv: string; tag: string; data: string }
  | { v: 1; scheme: 'plaintext'; credential: StoredCredential };

export async function osKeychain(): Promise<Keychain | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    const entry = new Entry('dova', 'credentials-key');
    const keychain: Keychain = {
      get: () => entry.getPassword() ?? null,
      set: (value) => entry.setPassword(value),
      delete: () => {
        entry.deletePassword();
      },
    };
    // Some platforms only fail on first use (no Secret Service running),
    // so probe it here rather than discover that halfway through a save.
    keychain.get();
    return keychain;
  } catch {
    return null;
  }
}

export function fileCredentialStore(file: string, keychain: () => Promise<Keychain | null> = osKeychain): CredentialStore {
  async function read(): Promise<FileFormat | null> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as FileFormat;
    } catch {
      return null;
    }
  }

  return {
    async load() {
      const stored = await read();
      if (!stored) return null;
      if (stored.scheme === 'plaintext') return stored.credential;

      const kc = await keychain();
      const key = kc?.get();
      // The key is gone (keychain reset, a different machine): the file is
      // unreadable, which is the same as not being signed in.
      if (!key) return null;
      try {
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(stored.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
        const plain = Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]);
        return JSON.parse(plain.toString('utf8')) as StoredCredential;
      } catch {
        return null;
      }
    },

    async save(credential) {
      let format: FileFormat;
      const kc = await keychain();
      let key: string | null = null;
      if (kc) {
        try {
          key = kc.get();
          if (!key) {
            key = randomBytes(32).toString('base64');
            kc.set(key);
          }
        } catch {
          key = null;
        }
      }
      if (key) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
        const data = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()]);
        format = { v: 1, scheme: 'keychain-aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      } else {
        format = { v: 1, scheme: 'plaintext', credential };
      }
      await writePrivateFile(file, JSON.stringify(format));
      return format.scheme === 'plaintext' ? 'file' : 'keychain';
    },

    async clear() {
      await fs.rm(file, { force: true });
      try {
        (await keychain())?.delete();
      } catch {
        // Nothing stored there — fine.
      }
    },

    async storage() {
      const stored = await read();
      if (!stored) return null;
      return stored.scheme === 'plaintext' ? 'file' : 'keychain';
    },
  };
}

/** Writes a file only this user can read, via a rename so a crash never leaves half a credential. */
export async function writePrivateFile(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, contents, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** A credential held only in memory — `$DOVA_TOKEN`. */
export function memoryCredentialStore(credential: StoredCredential | null): CredentialStore {
  let current = credential;
  return {
    load: async () => current,
    save: async (c) => {
      current = c;
      return 'file';
    },
    clear: async () => {
      current = null;
    },
    storage: async () => null,
  };
}
