import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuthSession, assertAzureDevOpsUrl, orgUrlOf } from '../src/auth/session.js';
import { memoryCredentialStore, type StoredCredential } from '../src/auth/store.js';
import { PrereqError, UserError } from '../src/lib/errors.js';

const ORG = 'https://dev.azure.com/contoso';
const TENANT = '11111111-2222-3333-4444-555555555555';

interface Call {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Stands in for the network: Azure DevOps' unauthenticated tenant probe,
 * Entra's token endpoint, and Azure DevOps itself. Each test says how the
 * last two answer.
 */
function fakeNetwork(opts: {
  token?: (form: URLSearchParams, n: number) => { status: number; body: unknown };
  ado?: (call: Call) => { status: number; body: unknown };
}) {
  const calls: Call[] = [];
  let tokenCalls = 0;
  const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const call: Call = { url, headers, body: init.body === undefined ? undefined : String(init.body) };
    calls.push(call);
    if (url.endsWith('/_apis/connectionData') && !headers.Authorization) {
      return new Response('', { status: 401, headers: { 'x-vss-resourcetenant': TENANT } });
    }
    if (url.startsWith('https://login.microsoftonline.com/')) {
      tokenCalls++;
      const answer = opts.token?.(new URLSearchParams(call.body), tokenCalls) ?? {
        status: 200,
        body: { access_token: `at-${tokenCalls}`, expires_in: 3600 },
      };
      return Response.json(answer.body, { status: answer.status });
    }
    const answer = opts.ado?.(call) ?? { status: 200, body: { ok: true } };
    return Response.json(answer.body, { status: answer.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    tokenRequests: () => calls.filter((c) => c.url.startsWith('https://login.microsoftonline.com/')),
    adoRequests: () => calls.filter((c) => c.headers.Authorization),
  };
}

function entra(overrides: Partial<Extract<StoredCredential, { kind: 'entra' }>> = {}): StoredCredential {
  return {
    kind: 'entra',
    clientId: 'client',
    tenant: 'organizations',
    homeTenant: 'home-tenant',
    refreshToken: 'rt-1',
    account: { username: 'jane@contoso.com' },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthSession.send', () => {
  it('refuses to send anything before a sign-in exists', async () => {
    fakeNetwork({});
    const session = new AuthSession(memoryCredentialStore(null));
    await expect(session.send({ method: 'GET', url: `${ORG}/_apis/projects` })).rejects.toBeInstanceOf(PrereqError);
  });

  it('sends a PAT as Basic auth, with no token exchange', async () => {
    const net = fakeNetwork({});
    const session = new AuthSession(memoryCredentialStore({ kind: 'pat', token: 'secret', account: {} }));
    const res = await session.send({ method: 'GET', url: `${ORG}/_apis/projects` });
    expect(res.status).toBe(200);
    expect(net.adoRequests()[0]!.headers.Authorization).toBe(`Basic ${Buffer.from(':secret').toString('base64')}`);
    expect(net.tokenRequests()).toHaveLength(0);
  });

  it("refreshes against the org's own tenant, found from Azure DevOps, and reuses the token after", async () => {
    const net = fakeNetwork({});
    const session = new AuthSession(memoryCredentialStore(entra()));
    await session.send({ method: 'GET', url: `${ORG}/_apis/projects` });
    await session.send({ method: 'GET', url: `${ORG}/_apis/projects` });

    expect(net.tokenRequests()).toHaveLength(1);
    expect(net.tokenRequests()[0]!.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(new URLSearchParams(net.tokenRequests()[0]!.body).get('grant_type')).toBe('refresh_token');
    expect(net.adoRequests().map((c) => c.headers.Authorization)).toEqual(['Bearer at-1', 'Bearer at-1']);
  });

  it('shares one refresh between requests that arrive together', async () => {
    const net = fakeNetwork({});
    const session = new AuthSession(memoryCredentialStore(entra()));
    await Promise.all([1, 2, 3, 4].map(() => session.send({ method: 'GET', url: `${ORG}/_apis/projects` })));
    expect(net.tokenRequests()).toHaveLength(1);
  });

  it('keeps the newest refresh token when Entra rotates it', async () => {
    fakeNetwork({ token: () => ({ status: 200, body: { access_token: 'at', expires_in: 3600, refresh_token: 'rt-2' } }) });
    const store = memoryCredentialStore(entra());
    await new AuthSession(store).send({ method: 'GET', url: `${ORG}/_apis/projects` });
    expect((await store.load()) as { refreshToken: string }).toMatchObject({ refreshToken: 'rt-2' });
  });

  it('retries once with a fresh token when Azure DevOps rejects one that has not expired', async () => {
    let n = 0;
    const net = fakeNetwork({ ado: () => (++n === 1 ? { status: 401, body: {} } : { status: 200, body: {} }) });
    const res = await new AuthSession(memoryCredentialStore(entra())).send({ method: 'GET', url: `${ORG}/_apis/projects` });
    expect(res.status).toBe(200);
    expect(net.tokenRequests()).toHaveLength(2);
    expect(net.adoRequests().map((c) => c.headers.Authorization)).toEqual(['Bearer at-1', 'Bearer at-2']);
  });

  it('turns a dead refresh token into "sign in again"', async () => {
    fakeNetwork({ token: () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS700082: expired' } }) });
    const err = await new AuthSession(memoryCredentialStore(entra()))
      .send({ method: 'GET', url: `${ORG}/_apis/projects` })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrereqError);
    expect((err as PrereqError).message).toMatch(/expired or was revoked/);
  });

  it('points at --tenant when a tenant demands MFA the refresh cannot satisfy', async () => {
    fakeNetwork({ token: () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS50076: MFA required' } }) });
    const err = await new AuthSession(memoryCredentialStore(entra()))
      .send({ method: 'GET', url: `${ORG}/_apis/projects` })
      .catch((e: unknown) => e);
    expect((err as PrereqError).hints).toEqual([`Run: dova auth login --tenant ${TENANT}`]);
  });

  it('never attaches the token to a URL outside Azure DevOps', async () => {
    const net = fakeNetwork({});
    const session = new AuthSession(memoryCredentialStore(entra()));
    await expect(session.send({ method: 'GET', url: 'https://evil.example/_apis' })).rejects.toBeInstanceOf(UserError);
    expect(net.calls).toHaveLength(0);
  });
});

describe('AuthSession.status / logout', () => {
  it('reports the account and tenant, then nothing after logout', async () => {
    const store = memoryCredentialStore(entra());
    const session = new AuthSession(store);
    expect(await session.status()).toMatchObject({ signedIn: true, method: 'entra', tenant: 'home-tenant' });
    await session.logout();
    expect(await session.status()).toMatchObject({ signedIn: false });
    expect(await store.load()).toBeNull();
  });

  it('refuses login/logout while $DOVA_TOKEN is in charge', async () => {
    const session = new AuthSession(memoryCredentialStore({ kind: 'pat', token: 't', account: {} }), { fromEnvironment: true });
    await expect(session.logout()).rejects.toBeInstanceOf(UserError);
    expect((await session.status()).storage).toBe('environment');
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

describe('orgUrlOf', () => {
  it.each([
    ['https://dev.azure.com/contoso/Proj/_apis/x', 'https://dev.azure.com/contoso'],
    ['https://vssps.dev.azure.com/contoso/_apis/x', 'https://dev.azure.com/contoso'],
    ['https://contoso.visualstudio.com/_apis/x', 'https://dev.azure.com/contoso'],
    ['https://app.vssps.visualstudio.com/_apis/profile', null],
    ['https://dev.azure.com/_apis/x', null],
  ])('%s -> %s', (url, expected) => {
    expect(orgUrlOf(new URL(url))).toBe(expected);
  });
});
