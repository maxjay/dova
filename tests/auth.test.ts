import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, parseAzToken, withAutoLogin, type Token } from '../src/ado/auth.js';
import { NotSignedInError, PrereqError, UserError } from '../src/errors.js';

const jwt = (claims: Record<string, string>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const tokenOf = (auth: string) => JSON.parse(Buffer.from(auth.split('.')[1]!, 'base64url').toString());
const get = { method: 'GET' as const, url: 'https://dev.azure.com/contoso/_apis/projects' };

/** az, handing out token n for the tenant asked (`home` by default). */
function fakeAz(lifetimeMs = 3600_000) {
  let n = 0;
  return vi.fn(async (tenant?: string): Promise<Token> => ({ accessToken: jwt({ n: String(++n), tid: tenant ?? 'home', upn: 'jane@contoso.com' }), expiresAt: Date.now() + lifetimeMs }));
}

/** Azure DevOps: answers with `status(token)`, optionally naming the org's tenant. */
function fakeAdo(answer: (token: Record<string, string>) => { status: number; tenant?: string } = () => ({ status: 200 })) {
  const seen: Array<Record<string, string>> = [];
  vi.stubGlobal('fetch', async (_: string, init: RequestInit) => {
    const token = tokenOf((init.headers as Record<string, string>).Authorization!);
    seen.push(token);
    const { status, tenant } = answer(token);
    return new Response('{}', { status, headers: tenant ? { 'x-vss-resourcetenant': tenant } : {} });
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('Session', () => {
  it('asks az once, shares that between concurrent requests, and reuses it', async () => {
    const az = fakeAz();
    const seen = fakeAdo();
    const s = new Session(az, null);
    await Promise.all([s.send(get), s.send(get)]);
    await s.send(get);
    expect(az).toHaveBeenCalledTimes(1);
    expect(seen.map((t) => t.n)).toEqual(['1', '1', '1']);
  });

  it('asks again when the token is close to expiring', async () => {
    const az = fakeAz(60_000);
    fakeAdo();
    const s = new Session(az, null);
    await s.send(get);
    await s.send(get);
    expect(az).toHaveBeenCalledTimes(2);
  });

  it("gets a token from the org's own tenant when it names one, and remembers that", async () => {
    const az = fakeAz();
    fakeAdo((t) => (t.tid === 'guest' ? { status: 200 } : { status: 401, tenant: 'guest' }));
    const s = new Session(az, null);
    expect((await s.send(get)).status).toBe(200);
    expect((await s.send(get)).status).toBe(200);
    expect(az.mock.calls).toEqual([[undefined], ['guest']]);
  });

  it('retries once with a fresh token when the same tenant refuses one', async () => {
    const az = fakeAz();
    const seen = fakeAdo((t) => ({ status: t.n === '1' ? 401 : 200 }));
    expect((await new Session(az, null).send(get)).status).toBe(200);
    expect(seen.map((t) => t.n)).toEqual(['1', '2']);
  });

  it('notices a new az login by itself', async () => {
    const profile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dova-')), 'azureProfile.json');
    fs.writeFileSync(profile, '{}');
    const az = fakeAz();
    const seen = fakeAdo();
    const s = new Session(az, profile);
    await s.send(get);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(profile, later, later);
    await s.send(get);
    expect(seen.map((t) => t.n)).toEqual(['1', '2']);
  });

  it('never sends the token outside Azure DevOps', async () => {
    const az = fakeAz();
    await expect(new Session(az, null).send({ method: 'GET', url: 'https://evil.example/x' })).rejects.toBeInstanceOf(UserError);
    await expect(new Session(az, null).send({ method: 'GET', url: 'https://dev.azure.com.evil.example/x' })).rejects.toBeInstanceOf(UserError);
    expect(az).not.toHaveBeenCalled();
  });

  it('reports who is signed in, or why not', async () => {
    expect(await new Session(fakeAz(), null).status()).toMatchObject({ signedIn: true, account: 'jane@contoso.com', tenant: 'home' });
    expect(await new Session(() => Promise.reject(new NotSignedInError('Not logged in to Azure CLI.')), null).status()).toMatchObject({ signedIn: false, error: 'Not logged in to Azure CLI.' });
  });
});

describe('parseAzToken', () => {
  it('prefers epoch expires_on, falls back to local-time expiresOn', () => {
    expect(parseAzToken(JSON.stringify({ accessToken: 't', expires_on: 1_800_000_000 })).expiresAt).toBe(1_800_000_000_000);
    expect(parseAzToken(JSON.stringify({ accessToken: 't', expiresOn: '2026-10-24 19:41:07.000000' })).expiresAt).toBe(new Date('2026-10-24T19:41:07').getTime());
    expect(() => parseAzToken('WARNING')).toThrow(PrereqError);
  });
});

describe('withAutoLogin', () => {
  const ok = { status: 200, contentType: null, body: '' };

  it('logs in once for concurrent failures, then follows on to the tenant the org needs', async () => {
    const done = new Set<string>();
    const login = vi.fn(async (tenant?: string) => void done.add(tenant ?? 'home'));
    const send = withAutoLogin(async () => {
      if (!done.has('home')) throw new NotSignedInError('no');
      if (!done.has('guest')) throw new NotSignedInError('no', 'guest');
      return ok;
    }, true, login);
    expect(await Promise.all([send(get), send(get)])).toEqual([ok, ok]);
    expect(login.mock.calls).toEqual([[undefined], ['guest']]);
  });

  it('without a terminal, or for any other error, passes it through', async () => {
    const login = vi.fn(async () => {});
    await expect(withAutoLogin(() => Promise.reject(new NotSignedInError('no')), false, login)(get)).rejects.toBeInstanceOf(NotSignedInError);
    await expect(withAutoLogin(() => Promise.reject(new PrereqError('az missing')), true, login)(get)).rejects.toBeInstanceOf(PrereqError);
    expect(login).not.toHaveBeenCalled();
  });

  it('gives up rather than logging in to the same tenant twice', async () => {
    const login = vi.fn(async () => {});
    await expect(withAutoLogin(() => Promise.reject(new NotSignedInError('still no')), true, login)(get)).rejects.toBeInstanceOf(NotSignedInError);
    expect(login).toHaveBeenCalledTimes(1);
  });
});
