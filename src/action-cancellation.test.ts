import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ACTION_ID = 'test::SEND';
const CALL = { name: 'execute_one_action', arguments: { platform: 'test', actionId: ACTION_ID, connectionKey: 'test-key' } };
const APPROVED = { action: 'accept' as const, content: { approve: true } };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function harness(hold?: 'connections' | 'knowledge') {
  const reached = deferred();
  const release = deferred();
  let passthroughs = 0;
  const api = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if ((hold === 'connections' && pathname === '/v1/vault/connections') ||
        (hold === 'knowledge' && pathname === '/v1/knowledge')) {
      reached.resolve();
      await release.promise;
    }
    res.setHeader('Content-Type', 'application/json');
    if (pathname === '/v1/vault/connections') {
      res.end(JSON.stringify({ rows: [{ key: 'test-key', platform: 'test' }], total: 1 }));
    } else if (pathname === '/v1/knowledge') {
      res.end(JSON.stringify({ rows: [{ _id: ACTION_ID, title: 'Send', method: 'POST', path: '/send', access: 'write' }] }));
    } else if (pathname === '/v1/passthrough/send') {
      passthroughs++;
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ONE_SECRET: 'test-secret-not-a-real-key',
      ONE_BASE_URL: baseUrl,
      ONE_APPROVAL: 'write',
      ONE_PERMISSIONS: 'admin',
      ONE_CONNECTION_KEYS: '*',
      ONE_ACTION_IDS: '*',
      ONE_KNOWLEDGE_AGENT: 'false',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'cancellation-test', version: '1.0.0' }, { capabilities: { elicitation: {} } });
  await client.connect(transport);
  return {
    client, reached: reached.promise, release: () => release.resolve(),
    count: () => passthroughs,
    close: async () => { release.resolve(); await transport.close(); await new Promise<void>((resolve) => api.close(() => resolve())); },
  };
}

describe('execute_one_action cancellation across authorization', () => {
  for (const stage of ['connections', 'knowledge'] as const) {
    it(`does not dispatch after cancellation during ${stage}`, async () => {
      const h = await harness(stage);
      try {
        h.client.setRequestHandler(ElicitRequestSchema, async () => APPROVED);
        const controller = new AbortController();
        const pending = h.client.callTool(CALL, undefined, { signal: controller.signal });
        await h.reached;
        controller.abort();
        await assert.rejects(pending);
        h.release();
        await h.client.ping();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(h.count(), 0);
      } finally { await h.close(); }
    });
  }

  it('does not dispatch when cancelled immediately after approval', async () => {
    const h = await harness();
    try {
      const controller = new AbortController();
      h.client.setRequestHandler(ElicitRequestSchema, async () => {
        controller.abort();
        return APPROVED;
      });
      await assert.rejects(h.client.callTool(CALL, undefined, { signal: controller.signal }));
      await h.client.ping();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(h.count(), 0);
    } finally { await h.close(); }
  });

  it('does not dispatch when cancelled while approval is pending', async () => {
    const h = await harness();
    try {
      const prompted = deferred();
      const answer = deferred<typeof APPROVED>();
      const controller = new AbortController();
      h.client.setRequestHandler(ElicitRequestSchema, async () => {
        prompted.resolve();
        return answer.promise;
      });
      const pending = h.client.callTool(CALL, undefined, { signal: controller.signal });
      await prompted.promise;
      controller.abort();
      answer.resolve(APPROVED);
      await assert.rejects(pending);
      await h.client.ping();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(h.count(), 0);
    } finally { await h.close(); }
  });

  it('runs an approved, uncancelled action', async () => {
    const h = await harness();
    try {
      h.client.setRequestHandler(ElicitRequestSchema, async () => APPROVED);
      const result = await h.client.callTool(CALL);
      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as { status: number }).status, 200);
      assert.equal(h.count(), 1);
    } finally { await h.close(); }
  });
});
