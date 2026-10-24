import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuthSession, assertAzureDevOpsUrl, parseAzToken, type AccessToken } from '../src/auth/session.js';
import { PrereqError, UserError } from '../src/lib/errors.js';

const ORG = 'https://dev.azure.com/contoso';

/** A token source standing in for az: hands out `at-1`, `at-2`, … and counts how often it was asked. */
function fakeAz(lifetimeMs = 60 * 60 * 1000) {
  let n = 0;
  const source = vi.fn(async (): Promise<AccessToken> => ({ accessToken: `at-${++n}`, expiresAt: Date.now() + lifetimeMs }));
  return source;
}

/** Stands in for Azure DevOps; records the Authorization header of every request. */
function fakeAdo(answer: (n: number) => number = () => 200) {
  const auth: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init: RequestInit = {}) => {
      auth.push((init.headers as Record<string, string>).Authorization!);
      return Response.json({ ok: true }, { status: answer(auth.length) });
    })
  );
  return auth;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthSession', () => {
  it('asks az once, then reuses the token for every request', async () => {
    const az = fakeAz();
    const auth = fakeAdo();
    const session = new AuthSession(az);
    await session.send({ method: 'GET', url: `${ORG}/_apis/projects` });
    await session.send({ method: 'GET', url: `${ORG}/_apis/projects` });
    expect(az).toHaveBeenCalledTimes(1);
    expect(auth).toEqual(['Bearer at-1', 'Bearer at-1']);
  });

  it('shares one az run between requests that arrive together', async () => {
    const az = fakeAz();
    fakeAdo();
    const session = new AuthSession(az);
    await Promise.all([1, 2, 3, 4].map(() => session.send({ method: 'GET', url: `${ORG}/_apis/projects` })));
    expect(az).toHaveBeenCalledTimes(1);
  });

  it('asks az again once the token is near expiry', async () => {
    const az = fakeAz(60 * 1000); // inside the refresh margin from the start
    fakeAdo();
    const session = new AuthSession(az);
    await session.send({ method: 'GET', url: `${ORG}/_apis/projects` });
    await session.send({ method: 'GET', url: `${ORG}/_apis/projects` });
    expect(az).toHaveBeenCalledTimes(2);
  });

  it('retries once with a fresh token when Azure DevOps rejects the cached one', async () => {
    const az = fakeAz();
    const auth = fakeAdo((n) => (n === 1 ? 401 : 200));
    const res = await new AuthSession(az).send({ method: 'GET', url: `${ORG}/_apis/projects` });
    expect(res.status).toBe(200);
    expect(auth).toEqual(['Bearer at-1', 'Bearer at-2']);
  });

  it('forgets the token on reset, so a new az login takes effect', async () => {
    const az = fakeAz();
    const auth = fakeAdo();
    const session = new AuthSession(az);
    await session.send({ method: 'GET', url: `${ORG}/_apis/projects` });
    session.reset();
    await session.send({ method: 'GET', url: `${ORG}/_apis/projects` });
    expect(auth).toEqual(['Bearer at-1', 'Bearer at-2']);
  });

  it('passes az failures through, and reports them in status', async () => {
    const session = new AuthSession(() => Promise.reject(new PrereqError('Not logged in to Azure CLI.', ['Run: dova auth login'])));
    await expect(session.send({ method: 'GET', url: `${ORG}/_apis/projects` })).rejects.toBeInstanceOf(PrereqError);
    expect(await session.status()).toMatchObject({ signedIn: false, error: 'Not logged in to Azure CLI.' });
  });

  it("reads who's signed in from the token itself", async () => {
    const payload = Buffer.from(JSON.stringify({ upn: 'jane@contoso.com', tid: 'tenant-1' })).toString('base64url');
    const session = new AuthSession(async () => ({ accessToken: `x.${payload}.y`, expiresAt: Date.now() + 3600_000 }));
    expect(await session.status()).toMatchObject({ signedIn: true, account: 'jane@contoso.com', tenant: 'tenant-1' });
  });

  it('never attaches the token to a URL outside Azure DevOps', async () => {
    const az = fakeAz();
    const auth = fakeAdo();
    await expect(new AuthSession(az).send({ method: 'GET', url: 'https://evil.example/_apis' })).rejects.toBeInstanceOf(UserError);
    expect(az).not.toHaveBeenCalled();
    expect(auth).toHaveLength(0);
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
