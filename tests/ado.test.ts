import { describe, it, expect } from 'vitest';
import { adoJson, adoText, adoUrl, projectBase, throwForStatus } from '../src/lib/ado.js';
import { ExternalCommandError, NotFoundError, PrereqError } from '../src/lib/errors.js';
import { createFakeRunner, adoOk, adoError, adoTextOk, type FakeAdoRequest } from './fixtures/fake-runner.js';

const ORG = 'https://dev.azure.com/contoso';

describe('adoUrl', () => {
  it('adds api-version, and drops undefined query values', () => {
    const url = new URL(adoUrl(ORG, '_apis/wit/wiql', { $top: 5, skip: undefined }));
    expect(url.pathname).toBe('/contoso/_apis/wit/wiql');
    expect(url.searchParams.get('api-version')).toBe('7.1');
    expect(url.searchParams.get('$top')).toBe('5');
    expect(url.searchParams.has('skip')).toBe(false);
  });

  it('keeps an api-version the caller chose', () => {
    expect(new URL(adoUrl(ORG, '_apis/connectionData', { 'api-version': '7.1-preview' })).searchParams.get('api-version')).toBe(
      '7.1-preview'
    );
  });

  it('encodes project and team names', () => {
    expect(projectBase(ORG, 'My Project', 'Team #1')).toBe('https://dev.azure.com/contoso/My%20Project/Team%20%231');
  });
});

describe('adoJson', () => {
  it('serializes the body as UTF-8 JSON, untouched — no ASCII escaping, no temp files', async () => {
    let seen: FakeAdoRequest | undefined;
    const runner = createFakeRunner({
      ado: (req) => {
        seen = req;
        return adoOk({ id: 1 });
      },
    });
    await adoJson(runner, { method: 'POST', url: `${ORG}/_apis/x`, body: { content: 'Line one\nLine two — “quoted” $total `npm test`' } });
    expect(seen?.contentType).toBe('application/json');
    expect(seen?.body).toBe(JSON.stringify({ content: 'Line one\nLine two — “quoted” $total `npm test`' }));
  });

  it('passes a raw body through with the content type asked for', async () => {
    let seen: FakeAdoRequest | undefined;
    const runner = createFakeRunner({
      ado: (req) => {
        seen = req;
        return adoOk(null);
      },
    });
    await adoJson(runner, { method: 'PATCH', url: `${ORG}/_apis/x`, rawBody: '[{"op":"add"}]', contentType: 'application/json-patch+json' });
    expect(seen?.body).toBe('[{"op":"add"}]');
    expect(seen?.contentType).toBe('application/json-patch+json');
  });

  it('returns null for an empty 2xx body', async () => {
    const runner = createFakeRunner({ ado: () => ({ status: 204, contentType: null, body: '' }) });
    expect(await adoJson(runner, { method: 'DELETE', url: `${ORG}/_apis/x` })).toBeNull();
  });

  it('fails clearly on a body that is not JSON', async () => {
    const runner = createFakeRunner({ ado: () => adoTextOk('<html>') });
    await expect(adoJson(runner, { method: 'GET', url: `${ORG}/_apis/x` })).rejects.toBeInstanceOf(ExternalCommandError);
  });
});

describe('adoText', () => {
  it('asks for text and returns the body as-is', async () => {
    let accept: string | undefined;
    const runner = createFakeRunner({
      ado: (req) => {
        accept = req.accept;
        return adoTextOk('line 1\nline 2\n');
      },
    });
    expect(await adoText(runner, { method: 'GET', url: `${ORG}/_apis/build/builds/1/logs/2` })).toBe('line 1\nline 2\n');
    expect(accept).toBe('text');
  });
});

describe('throwForStatus', () => {
  const call = { method: 'GET' as const, url: `${ORG}/_apis/wit/workitems/9?api-version=7.1` };

  it('treats 401 and 203 alike: sign in again', () => {
    for (const status of [401, 203]) {
      try {
        throwForStatus({ status, contentType: 'text/html', body: '<html>' }, call);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(PrereqError);
        expect((err as PrereqError).hints).toContain('Run: dova auth login');
      }
    }
  });

  it("maps 404 to NotFoundError, carrying the service's own message", () => {
    expect(() => throwForStatus(adoError(404, 'TF401232: Work item 9 does not exist.'), call)).toThrow(NotFoundError);
    expect(() => throwForStatus(adoError(404, 'TF401232: Work item 9 does not exist.'), call)).toThrow(/TF401232/);
  });

  it('names the request on any other failure, without the api-version noise', () => {
    expect(() => throwForStatus(adoError(400, 'VS402323: bad field'), call)).toThrow(
      /400 for GET \/contoso\/_apis\/wit\/workitems\/9:\nVS402323/
    );
  });

  it('passes a 2xx', () => {
    expect(() => throwForStatus(adoOk({}), call)).not.toThrow();
  });
});
