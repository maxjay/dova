import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { commands } from '../src/cli/commands/index.js';
import { serveMcp } from '../src/cli/mcp.js';
import { batch, restPr, testApp, wi, type Req, type Route } from './fixtures.js';

async function mcp(messages: object[], route: Route = () => undefined) {
  const input = new PassThrough();
  let output = '';
  const { app, ado } = testApp({ route });
  const done = serveMcp(commands, { input, output: { write: (s: string) => (output += s) }, app: () => app });
  for (const m of messages) input.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  input.end();
  await done;
  return { replies: output.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), requests: ado.requests };
}

const call = (id: number, name: string, args: object) => ({ id, method: 'tools/call', params: { name, arguments: args } });

describe('dova mcp', () => {
  it('handshakes, and lists ten tools with schemas', async () => {
    const { replies } = await mcp([
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
    ]);
    expect(replies).toHaveLength(2); // the notification gets no reply
    expect(replies[0].result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dova' } });
    const tools = replies[1].result.tools;
    expect(tools).toHaveLength(10);
    expect(tools.find((t: { name: string }) => t.name === 'view').inputSchema).toMatchObject({ type: 'object', required: ['id'], properties: { id: {}, cwd: {} } });
  });

  it('returns a tool result as JSON text', async () => {
    const { replies } = await mcp([call(1, 'view', { id: 4821 })], (r) => (r.path.endsWith('/wiql') ? { workItems: [] } : batch([wi(4821)])(r)));
    expect(JSON.parse(replies[0].result.content[0].text)).toMatchObject({ kind: 'work-item', id: 4821 });
  });

  it('review_thread replies and resolves in one call', async () => {
    const route = (r: Req) =>
      r.path.endsWith('/pullrequests/7') ? restPr(7) : r.path.endsWith('/threads/3') && r.method === 'GET' ? { id: 3, comments: [{ id: 5, content: 'x' }] } : r.method === 'POST' ? { id: 6 } : r.method === 'PATCH' ? {} : undefined;
    const { replies, requests } = await mcp([call(1, 'review_thread', { pr: 7, thread: 3, text: 'Fixed `$x` in 9f2c', status: 'resolved' })], route);
    expect(JSON.parse(replies[0].result.content[0].text)).toEqual({ prId: 7, threadId: 3, status: 'fixed' });
    expect(requests.find((r) => r.method === 'POST')!.body).toMatchObject({ content: 'Fixed `$x` in 9f2c', parentCommentId: 5 });
    expect(requests.find((r) => r.method === 'PATCH')!.body).toEqual({ status: 'fixed' });
  });

  it("reports a failed call as a result the agent can read, with dova's error kind", async () => {
    const { replies } = await mcp([call(1, 'view', { id: 9 }), call(2, 'nope', {})], (r) => (r.path.endsWith('workitemsbatch') ? { value: [null] } : undefined));
    const byId = new Map(replies.map((r) => [r.id, r]));
    expect(byId.get(1).result.isError).toBe(true);
    expect(JSON.parse(byId.get(1).result.content[0].text)).toMatchObject({ name: 'NotFoundError', exitCode: 2 });
    expect(byId.get(2).error.code).toBe(-32602);
  });
});
