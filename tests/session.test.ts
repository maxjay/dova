import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthSession, assertAzureDevOpsUrl, orgUrlOf, parseAzToken, type AccessToken } from '../src/auth/session.js';
import { withAutoLogin } from '../src/lib/transport.js';
import { NotSignedInError, PrereqError, UserError } from '../src/lib/errors.js';

const ORG = 'https://dev.azure.com/contoso';

function jwt(claims: Record<string, string>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
}

/**
 * A token source standing in for az: each call hands out a new token
 * whose `tid` claim is the tenant asked for (or `home`), and records
 * which tenant was asked for.
 */
function fakeAz(lifetimeMs = 60 * 60 * 1000) {
  let n = 0;
  return vi.fn(async (tenant?: string): Promise<AccessToken> => ({
    accessToken: jwt({ n: String(++n), tid: tenant ?? 'home', upn: 'jane@contoso.com' }),
    expiresAt: Date.now() + lifetimeMs,
  }));
}

function tokenNumber(authorization: string): string {
  return JSON.parse(Buffer.from(authorization.split('.')[1]!, 'base64url').toString('utf8')).n;
}

/** Stands in for Azure DevOps; records the Authorization header of every request. */
function fakeAdo(answer: (authorization: string, n: number) => { status: number; tenant?: string } = () => ({ status: 200 })) {
  const auth: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init: RequestInit = {}) => {
      const authorization = (init.headers as Record<string, string>).Authorization!;
      auth.push(authorization);
      const { status, tenant } = answer(authorization, auth.length);
      return Response.json({ message: 'x' }, { status, headers: tenant ? { 'x-vss-resourcetenant': tenant } : {} });
    })
  );
  return auth;
}

const get = { method: 'GET' as const, url: `${ORG}/_apis/projects` };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthSession', () => {
  it('asks az once, then reuses the token for every request', async () => {
    const az = fakeAz();
    const auth = fakeAdo();
    const session = new AuthSession({ source: az, azProfile: null });
    await session.send(get);
    await session.send(get);
    expect(az).toHaveBeenCalledTimes(1);
    expect(auth.map(tokenNumber)).toEqual(['1', '1']);
  });

  it('shares one az run between requests that arrive together', async () => {
    const az = fakeAz();
    fakeAdo();
    const session = new AuthSession({ source: az, azProfile: null });
    await Promise.all([1, 2, 3, 4].map(() => session.send(get)));
    expect(az).toHaveBeenCalledTimes(1);
  });

  it('asks az again once the token is near expiry', async () => {
    const az = fakeAz(60 * 1000); // inside the refresh margin from the start
    fakeAdo();
    const session = new AuthSession({ source: az, azProfile: null });
    await session.send(get);
    await session.send(get);
    expect(az).toHaveBeenCalledTimes(2);
  });

  it('retries once with a fresh token when the same tenant rejects the cached one', async () => {
    const az = fakeAz();
    const auth = fakeAdo((_a, n) => ({ status: n === 1 ? 401 : 200 }));
    const res = await new AuthSession({ source: az, azProfile: null }).send(get);
    expect(res.status).toBe(200);
    expect(auth.map(tokenNumber)).toEqual(['1', '2']);
    expect(az.mock.calls).toEqual([[undefined], [undefined]]);
  });

  it("gets a token for the org's own tenant when it names one, and remembers it for that org", async () => {
    const az = fakeAz();
    // The org is in tenant `guest`: anything else gets a 401 naming it.
    fakeAdo((authorization) =>
      JSON.parse(Buffer.from(authorization.split('.')[1]!, 'base64url').toString('utf8')).tid === 'guest'
        ? { status: 200 }
        : { status: 401, tenant: 'guest' }
    );
    const session = new AuthSession({ source: az, azProfile: null });
    expect((await session.send(get)).status).toBe(200);
    expect((await session.send(get)).status).toBe(200);
    expect(az.mock.calls).toEqual([[undefined], ['guest']]);
  });

  it('notices a new az login by itself, with no dova command to run', async () => {
    const profile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dova-az-')), 'azureProfile.json');
    fs.writeFileSync(profile, '{}');
    const az = fakeAz();
    const auth = fakeAdo();
    const session = new AuthSession({ source: az, azProfile: profile });
    await session.send(get);
    await session.send(get);
    // `az login` rewrites the profile.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(profile, later, later);
    await session.send(get);
    expect(auth.map(tokenNumber)).toEqual(['1', '1', '2']);
  });

  it('passes az failures through, and reports them in status', async () => {
    const session = new AuthSession({ source: () => Promise.reject(new NotSignedInError('Not logged in to Azure CLI.')), azProfile: null });
    await expect(session.send(get)).rejects.toBeInstanceOf(NotSignedInError);
    expect(await session.status()).toMatchObject({ signedIn: false, error: 'Not logged in to Azure CLI.' });
  });

  it("reads who's signed in from the token itself", async () => {
    const session = new AuthSession({
      source: async () => ({ accessToken: jwt({ upn: 'jane@contoso.com', tid: 'tenant-1' }), expiresAt: Date.now() + 3600_000 }),
      azProfile: null,
    });
    expect(await session.status()).toMatchObject({ signedIn: true, account: 'jane@contoso.com', tenant: 'tenant-1' });
  });

  it('never attaches the token to a URL outside Azure DevOps', async () => {
    const az = fakeAz();
    const auth = fakeAdo();
    await expect(new AuthSession({ source: az, azProfile: null }).send({ method: 'GET', url: 'https://evil.example/_apis' })).rejects.toBeInstanceOf(
      UserError
    );
    expect(az).not.toHaveBeenCalled();
    expect(auth).toHaveLength(0);
  });
});

describe('withAutoLogin', () => {
  const ok = { status: 200, contentType: null, body: '' };

  it('runs az login once for everything that found it missing, then retries each request', async () => {
    let loggedIn = false;
    const login = vi.fn(async () => {
      loggedIn = true;
    });
    const send = withAutoLogin(async () => {
      if (!loggedIn) throw new NotSignedInError('Not logged in to Azure CLI.');
      return ok;
    }, { interactive: () => true, login });
    expect(await Promise.all([send(get), send(get), send(get)])).toEqual([ok, ok, ok]);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('logs in to the tenant the org named', async () => {
    const login = vi.fn(async () => {});
    let first = true;
    const send = withAutoLogin(async () => {
      if (first) {
        first = false;
        throw new NotSignedInError('needs guest', 'guest');
      }
      return ok;
    }, { interactive: () => true, login });
    await send(get);
    expect(login).toHaveBeenCalledWith('guest');
  });

  it('follows one login with the next when it uncovers another tenant, once each', async () => {
    const done = new Set<string>();
    const login = vi.fn(async (tenant?: string) => {
      done.add(tenant ?? 'home');
    });
    const send = withAutoLogin(async () => {
      if (!done.has('home')) throw new NotSignedInError('not logged in');
      if (!done.has('guest')) throw new NotSignedInError('needs guest', 'guest');
      return ok;
    }, { interactive: () => true, login });
    expect(await send(get)).toEqual(ok);
    expect(login.mock.calls).toEqual([[undefined], ['guest']]);
  });

  it('gives up rather than logging in to the same tenant twice', async () => {
    const login = vi.fn(async () => {});
    const send = withAutoLogin(() => Promise.reject(new NotSignedInError('still not')), { interactive: () => true, login });
    await expect(send(get)).rejects.toBeInstanceOf(NotSignedInError);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('without a terminal, hands the error back instead of prompting', async () => {
    const login = vi.fn(async () => {});
    const send = withAutoLogin(() => Promise.reject(new NotSignedInError('Not logged in to Azure CLI.')), { interactive: () => false, login });
    await expect(send(get)).rejects.toBeInstanceOf(NotSignedInError);
    expect(login).not.toHaveBeenCalled();
  });

  it('leaves every other error alone', async () => {
    const login = vi.fn(async () => {});
    const send = withAutoLogin(() => Promise.reject(new PrereqError('az is not installed')), { interactive: () => true, login });
    await expect(send(get)).rejects.toBeInstanceOf(PrereqError);
    expect(login).not.toHaveBeenCalled();
  });
});

describe('orgUrlOf', () => {
  it.each([
    ['https://dev.azure.com/contoso/Proj/_apis/x', 'https://dev.azure.com/contoso'],
    ['https://vssps.dev.azure.com/contoso/_apis/x', 'https://dev.azure.com/contoso'],
    ['https://contoso.visualstudio.com/_apis/x', 'https://dev.azure.com/contoso'],
    ['https://app.vssps.visualstudio.com/_apis/profile', null],
  ])('%s -> %s', (url, expected) => {
    expect(orgUrlOf(new URL(url))).toBe(expected);
  });
});

describe('parseAzToken', () => {
  it('prefers the epoch expires_on newer az versions print', () => {
    expect(parseAzToken(JSON.stringify({ accessToken: 't', expires_on: 1_800_000_000, expiresOn: '2000-01-01 00:00:00.000000' }))).toEqual({
      accessToken: 't',
      expiresAt: 1_800_000_000_000,
    });
  });

  it('falls back to the local-time expiresOn every version prints', () => {
    const { expiresAt } = parseAzToken(JSON.stringify({ accessToken: 't', expiresOn: '2026-10-24 19:41:07.000000' }));
    expect(expiresAt).toBe(new Date('2026-10-24T19:41:07').getTime());
  });

  it('rejects output that is not a token', () => {
    expect(() => parseAzToken('WARNING: something')).toThrow(PrereqError);
  });
});

describe('assertAzureDevOpsUrl', () => {
  it.each([
    'https://dev.azure.com/contoso/_apis/projects',
    'https://vssps.dev.azure.com/contoso/_apis/identities',
    'https://contoso.visualstudio.com/_apis/projects',
  ])('allows %s', (url) => {
    expect(() => assertAzureDevOpsUrl(url)).not.toThrow();
  });

  it.each([
    'http://dev.azure.com/contoso/_apis',
    'https://dev.azure.com.evil.example/x',
    'https://user:pw@dev.azure.com/contoso',
    'https://example.com/',
  ])('rejects %s', (url) => {
    expect(() => assertAzureDevOpsUrl(url)).toThrow(UserError);
  });
});
