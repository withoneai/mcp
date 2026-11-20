import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OneClient } from './client.js';
import { fetchPaginatedData } from './helpers.js';
import type { ActionDetails, ExecuteOneActionArgs } from './types.js';

const secret = 'dummy-one-secret';
const connectionKey = 'dummy-connection-key';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('authenticated redirects', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`does not forward credentials to another origin on ${status}`, async () => {
      const received: http.IncomingHttpHeaders[] = [];
      const destination = http.createServer((req, res) => {
        received.push(req.headers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows: [], total: 0 }));
      });
      const destinationUrl = await listen(destination);
      const source = http.createServer((_req, res) => {
        res.writeHead(status, { Location: `${destinationUrl}/capture` });
        res.end();
      });
      const sourceUrl = await listen(source);

      try {
        const client = new OneClient(secret, sourceUrl);
        const logs: string[] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => logs.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
        let results: PromiseSettledResult<unknown>[];
        try {
          results = await Promise.allSettled([
            client.findActions([], undefined, false),
            client.getActionDetails('dummy-action'),
            client.executePassthroughRequest({
              platform: 'test', actionId: 'dummy-action', connectionKey,
            } as ExecuteOneActionArgs, {
              _id: 'dummy-action', method: 'GET', path: '/things', tags: [],
            } as unknown as ActionDetails),
            fetchPaginatedData(`${sourceUrl}/v1/vault/connections`, {
              'x-one-secret': secret,
              'x-one-connection-key': connectionKey,
              Authorization: 'Bearer dummy-token',
              Cookie: 'session=dummy-cookie',
            }),
          ]);
        } finally {
          console.error = originalError;
        }
        assert.deepEqual(received, [], 'the other origin must receive no request');
        assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected', 'rejected', 'rejected']);
        assert.ok(!logs.join(' ').includes(secret), 'error paths must not log the secret');
      } finally {
        await close(source);
        await close(destination);
      }
    });
  }

  it('follows same-origin redirects for direct and paginated requests', async () => {
    const received: { method: string; headers: http.IncomingHttpHeaders }[] = [];
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/redirected')) {
        received.push({ method: req.method ?? '', headers: req.headers });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.method === 'POST' ? '[]' : JSON.stringify({ rows: [], total: 0 }));
      } else {
        res.writeHead(307, { Location: '/redirected' });
        res.end();
      }
    });
    const baseUrl = await listen(server);
    try {
      const client = new OneClient(secret, baseUrl);
      assert.deepEqual(await client.findActions([], undefined, false), []);
      assert.deepEqual(await fetchPaginatedData(`${baseUrl}/v1/vault/connections`, { 'x-one-secret': secret }), []);
      assert.deepEqual(received.map((request) => request.method), ['POST', 'GET']);
      assert.ok(received.every((request) => request.headers['x-one-secret'] === secret));
    } finally {
      await close(server);
    }
  });
});
