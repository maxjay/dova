import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { commands } from '../src/cli/commands/index.js';
import { serveRpc } from '../src/cli/rpc.js';
import { batch, testApp, wi, type Route } from './fixtures.js';

/** Sends lines to `dova rpc` and collects every reply. */
async function rpc(lines: unknown[], route: Route = batch([wi(4821)])) {
  const input = new PassThrough();
  let output = '';
  const { app } = testApp({ route });
  const done = serveRpc(commands, { input, output: { write: (s: string) => (output += s) }, app: () => app });
  for (const l of lines) input.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
  input.end();
  await done;
  return output.trim().split('\n').map((l) => JSON.parse(l));
}

describe('dova rpc', () => {
  it('runs a command as a method and returns what --json would', async () => {
    const [res] = await rpc([{ jsonrpc: '2.0', id: 1, method: 'wi.view', params: { idOrUrl: '4821' } }], (r) =>
      r.path.endsWith('/wiql') ? { workItems: [] } : batch([wi(4821)])(r)
    );
    expect(res).toMatchObject({ jsonrpc: '2.0', id: 1, result: { id: 4821, title: 'Item 4821', children: [] } });
  });

  it('lists its methods with their arguments and options', async () => {
    const [res] = await rpc([{ id: 'm', method: 'rpc.methods' }]);
    const reply = res.result.find((m: { name: string }) => m.name === 'pr.reply');
    expect(reply).toEqual({ name: 'pr.reply', description: expect.any(String), args: ['pr', 'thread', 'text'], options: ['resolve'] });
    expect(res.result.map((m: { name: string }) => m.name)).not.toContain('daemon.run');
  });

  it("reports dova's errors with their kind, and protocol errors as JSON-RPC ones", async () => {
    const replies = await rpc([
      { id: 1, method: 'wi.view', params: { idOrUrl: '9' } },
      { id: 2, method: 'nope' },
      'not json',
      { id: 3, method: 'bug', params: {} },
    ]);
    const byId = new Map(replies.map((r) => [r.id, r.error]));
    expect(byId.get(1)).toMatchObject({ code: -32000, data: { name: 'NotFoundError', exitCode: 2 } });
    expect(byId.get(2)).toMatchObject({ code: -32601 });
    expect(byId.get(null)).toMatchObject({ code: -32700 });
    expect(byId.get(3)).toMatchObject({ message: 'No title given — pass it as a param.', data: { exitCode: 1 } });
  });
});
