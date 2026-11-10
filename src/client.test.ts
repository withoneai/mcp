import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';

import { OneClient, stripReservedHeaders, answeredByPlatform } from './client.js';
import { describeError, fetchPaginatedData } from './helpers.js';
import { ToolError } from './tool-error.js';
import type { ActionDetails, ExecuteOneActionArgs } from './types.js';

// A passthrough call must never let the caller override One's own routing/auth
// headers (the scoping bypass), and a failed call must never log the secret.

const SECRET = 'test-one-secret-not-a-real-key';
const ACTION = { _id: 'conn_mod_def::ALLOWED_ACTION', method: 'GET', path: '/v1/things', tags: [] } as unknown as ActionDetails;

const exec = (extra: Partial<ExecuteOneActionArgs>): ExecuteOneActionArgs =>
  ({
    platform: 'test',
    actionId: 'conn_mod_def::ALLOWED_ACTION',
    connectionKey: 'live::allowed::default::aaaa',
    ...extra,
  }) as ExecuteOneActionArgs;

describe("executePassthroughRequest keeps One's headers authoritative", () => {
  let server: http.Server;
  let base = '';
  let received: { headers: http.IncomingHttpHeaders }[] = [];
  let reply: { status: number; headers?: Record<string, string>; body: string } | null = null;

  before(async () => {
    server = http.createServer((req, res) => {
      received.push({ headers: req.headers });
      if (reply !== null) {
        res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
        res.end(reply.body);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  beforeEach(() => {
    received = [];
    reply = null;
  });

  it('a caller cannot override the x-one-* routing/auth headers', async () => {
    const client = new OneClient(SECRET, base);
    await client.executePassthroughRequest(
      exec({
        headers: {
          'x-one-connection-key': 'live::EXCLUDED::default::zzzz',
          'X-One-Secret': 'sk_live_stolen',
          'X-ONE-ACTION-ID': 'conn_mod_def::OTHER',
          'x-custom-trace': 't-1',
        },
      }),
      ACTION
    );
    const h = received[0].headers;
    assert.equal(h['x-one-connection-key'], 'live::allowed::default::aaaa');
    assert.equal(h['x-one-secret'], SECRET);
    assert.equal(h['x-one-action-id'], 'conn_mod_def::ALLOWED_ACTION');
    assert.equal(h['x-custom-trace'], 't-1', 'a non-reserved custom header still passes through');
    assert.equal(h['content-type'], 'application/json', 'the default content type is kept');
  });

  it('a caller cannot set the headers that control the connection', async () => {
    const client = new OneClient(SECRET, base);
    await client.executePassthroughRequest(
      exec({
        data: { a: 1 },
        headers: { Host: 'attacker.example', 'Content-Length': '1', Connection: 'close', 'x-custom-trace': 't-1' },
      }),
      { ...ACTION, method: 'POST' } as ActionDetails
    );
    const h = received[0].headers;
    assert.equal(h.host, new URL(base).host);
    assert.equal(h['content-length'], '7', 'the length comes from the body that is sent');
    assert.notEqual(h.connection, 'close');
    assert.equal(h['x-custom-trace'], 't-1', 'a custom header still passes through');
  });

  it('names the expected path variables instead of sending an unfilled template', async () => {
    const client = new OneClient(SECRET, base);
    const templated = { ...ACTION, path: '/v1/things/{{thingId}}' } as ActionDetails;
    await assert.rejects(client.executePassthroughRequest(exec({}), templated), /pass pathVariables with: thingId/);
    assert.equal(received.length, 0, 'nothing is sent upstream');

    await client.executePassthroughRequest(exec({ pathVariables: { thing_id: 7 } }), templated);
    assert.equal(received.length, 1);
  });

  it('sends nothing when a path variable would leave the action route', async () => {
    const client = new OneClient(SECRET, base);
    const templated = { ...ACTION, path: '/v0/{{a}}/{{b}}/{{c}}' } as ActionDetails;
    await assert.rejects(
      client.executePassthroughRequest(exec({ pathVariables: { a: '..', b: '..', c: 'connections' } }), templated),
      ToolError
    );
    assert.equal(received.length, 0, 'nothing is sent upstream');
  });

  it('sends nothing when an action path resolves outside passthrough', async () => {
    const client = new OneClient(SECRET, base);
    const encoded = { ...ACTION, path: '/%2e%2e/%2E%2e/connections' } as ActionDetails;
    await assert.rejects(client.executePassthroughRequest(exec({}), encoded), ToolError);
    assert.equal(received.length, 0, 'nothing is sent upstream');
  });

  it('keeps ordinary paths working under a base URL with a path prefix', async () => {
    const client = new OneClient(SECRET, `${base}/prefix`);
    await client.executePassthroughRequest(exec({}), ACTION);
    assert.equal(received.length, 1);
  });

  it('a caller may still set Content-Type, in any casing', async () => {
    const client = new OneClient(SECRET, base);
    await client.executePassthroughRequest(exec({ headers: { 'content-type': 'text/plain' } }), ACTION);
    assert.equal(received[0].headers['content-type'], 'text/plain');
  });

  it("a platform's 4xx or 5xx is returned as its answer, with the status and body", async () => {
    const client = new OneClient(SECRET, base);
    for (const status of [404, 500]) {
      reply = { status, headers: { 'X-Passthrough-Content-Type': 'application/json' }, body: JSON.stringify({ error: 'no such contact' }) };
      const result = await client.executePassthroughRequest(exec({}), ACTION);
      assert.equal(result.status, status);
      assert.deepEqual(result.responseData, { error: 'no such contact' });
      assert.deepEqual(Object.keys(result).slice(0, 2), ['responseData', 'status'], 'the payload leads');
    }
  });

  it("a call One refuses throws a tool error with One's reason and reference", async () => {
    reply = {
      status: 404,
      body: JSON.stringify({ type: 'passthrough_error', status: 404, key: 'not_found', message: 'Connection not found', correlation_id: 'corr-1' }),
    };
    const client = new OneClient(SECRET, base);
    await assert.rejects(
      client.executePassthroughRequest(exec({}), ACTION),
      (e: Error) => e instanceof ToolError && e.message.includes('Connection not found') && e.message.includes('corr-1')
    );
  });

  it('One being unreachable is a tool error that warns against a blind retry', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', () => resolve()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const client = new OneClient(SECRET, `http://127.0.0.1:${port}`);
    const original = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        client.executePassthroughRequest(exec({}), ACTION),
        (e: Error) => e instanceof ToolError && /could not be reached/.test(e.message) && /check whether it took effect/.test(e.message)
      );
    } finally {
      console.error = original;
    }
  });

  it('a refused call never logs the secret, and bounds the body', async () => {
    reply = { status: 422, body: JSON.stringify({ message: 'upstream said no', padding: 'x'.repeat(2000) }) };
    const client = new OneClient(SECRET, base);

    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    let message = '';
    try {
      await client.executePassthroughRequest(exec({}), ACTION);
    } catch (error) {
      message = (error as Error).message;
    } finally {
      console.error = original;
    }

    const log = logged.join('\n');
    assert.ok(!log.includes(SECRET), 'the secret never reaches the log');
    assert.ok(log.includes('422') && log.includes('upstream said no'), 'the log still says what failed');
    assert.ok(log.includes('truncated'), 'a huge upstream body is bounded');
    assert.ok(message.includes('422') && message.includes('upstream said no'), "the tool error carries the status and One's reason");
  });
});

describe('ensureConnectionInScope', () => {
  let server: http.Server;
  let base = '';
  let rows: string[] = [];
  let listQueries: URLSearchParams[] = [];
  let failLists = false;

  const client = (options: { identity?: string; connectionKeys?: string[] } = {}) =>
    new OneClient({ secret: SECRET, baseUrl: base, fetchConnectors: false, ...options });

  before(async () => {
    server = http.createServer((req, res) => {
      listQueries.push(new URL(req.url ?? '', 'http://x').searchParams);
      res.writeHead(failLists ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(failLists ? { message: 'boom' } : { rows: rows.map((key) => ({ key, platform: 'test' })), total: rows.length }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  beforeEach(() => {
    rows = ['key_a'];
    listQueries = [];
    failLists = false;
  });

  it('allows any key when the server has no scope, without listing', async () => {
    const c = client();
    await c.ensureConnectionInScope('key_b');
    assert.equal(listQueries.length, 0);
  });

  it("allows the identity's own key without listing again", async () => {
    const c = client({ identity: 'user_a' });
    await c.initialize();
    await c.ensureConnectionInScope('key_a');
    assert.equal(listQueries.length, 1);
  });

  it("refuses another identity's key, using the identity-filtered list", async () => {
    const c = client({ identity: 'user_a' });
    await c.initialize();
    await assert.rejects(c.ensureConnectionInScope('key_b'), (e: Error) => e instanceof ToolError && /is not one this server may use/.test(e.message));
    assert.equal(listQueries.at(-1)?.get('identity'), 'user_a', 'the check reads the same filtered list');
  });

  it('allows a connection made after the list was loaded', async () => {
    const c = client({ identity: 'user_a' });
    await c.initialize();
    rows = ['key_a', 'key_new'];
    await c.ensureConnectionInScope('key_new');
    assert.deepEqual(c.getUserConnections().map((x) => x.key), ['key_a', 'key_new']);
  });

  const silenced = async (run: () => Promise<unknown>) => {
    const original = console.error;
    console.error = () => {};
    try {
      return await run();
    } finally {
      console.error = original;
    }
  };

  it('recovers when the first load failed', async () => {
    const c = client({ identity: 'user_a' });
    failLists = true;
    await silenced(() => c.initialize());
    failLists = false;
    await c.ensureConnectionInScope('key_a');
  });

  it('refuses when the list cannot be read, and keeps the loaded list', async () => {
    const c = client({ identity: 'user_a' });
    await c.initialize();
    failLists = true;
    await silenced(() =>
      assert.rejects(c.ensureConnectionInScope('key_b'), (e: Error) => e instanceof ToolError && /Could not confirm/.test(e.message))
    );
    assert.deepEqual(c.getUserConnections().map((x) => x.key), ['key_a']);
  });

  it('still applies ONE_CONNECTION_KEYS', async () => {
    const c = client({ connectionKeys: ['key_a'] });
    await c.initialize();
    await assert.rejects(c.ensureConnectionInScope('key_b'), ToolError);
    await c.ensureConnectionInScope('key_a');
  });
});

describe('a failed paginated fetch', () => {
  // Rendered the way console.error renders its arguments, which is what prints
  // a whole axios error's request headers.
  const captureLog = async (run: () => Promise<unknown>): Promise<string> => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: null }))).join(' '));
    };
    try {
      await assert.rejects(run());
    } finally {
      console.error = original;
    }
    return logged.join('\n');
  };

  it('never logs the secret when One answers with an error', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'upstream said no' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/vault/connections`;
    try {
      const log = await captureLog(() => fetchPaginatedData(url, { 'x-one-secret': SECRET }));
      assert.ok(!log.includes(SECRET), 'the secret never reaches the log');
      assert.ok(log.includes('500') && log.includes('upstream said no'), 'the log still says what failed');
    } finally {
      server.close();
    }
  });

  it('never logs the secret when One cannot be reached', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', () => resolve()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const log = await captureLog(() => fetchPaginatedData(`http://127.0.0.1:${port}/v1/vault/connections`, { 'x-one-secret': SECRET }));
    assert.ok(!log.includes(SECRET), 'the secret never reaches the log');
    assert.ok(log.includes('ECONNREFUSED'), 'the log still says what failed');
  });
});

describe('answeredByPlatform', () => {
  it('reads a renamed upstream header, in any casing, as the platform answering', () => {
    assert.equal(answeredByPlatform({ 'x-passthrough-content-type': 'application/json' }), true);
    assert.equal(answeredByPlatform({ 'X-Passthrough-Date': 'now' }), true);
    assert.equal(answeredByPlatform({ 'content-type': 'application/json', 'x-one-correlation-id': 'c' }), false);
  });
});

describe('stripReservedHeaders', () => {
  it('drops x-one-* case-insensitively and stringifies values', () => {
    assert.deepEqual(stripReservedHeaders({ 'X-One-Secret': 'a', 'x-one-action-id': 'b', Accept: 'x' }), { Accept: 'x' });
    assert.deepEqual(stripReservedHeaders({ n: 5 as unknown as string }), { n: '5' });
    assert.deepEqual(stripReservedHeaders(undefined), {});
  });

  it('drops connection-level headers case-insensitively', () => {
    for (const name of ['Host', 'host', 'CONNECTION', 'Content-Length', 'Transfer-Encoding', 'Keep-Alive', 'Proxy-Connection', 'TE', 'Trailer', 'Upgrade']) {
      assert.deepEqual(stripReservedHeaders({ [name]: 'x', Accept: 'y' }), { Accept: 'y' }, name);
    }
  });

  it('ignores surrounding whitespace in a header name', () => {
    assert.deepEqual(stripReservedHeaders({ 'Host ': 'a', ' host': 'b', ' x-one-secret': 'c', Accept: 'y' }), { Accept: 'y' });
  });
});

describe('describeError', () => {
  it('summarizes a plain error to its name and message', () => {
    const described = describeError(new Error('boom'));
    assert.equal(described.name, 'Error');
    assert.equal(described.message, 'boom');
  });
});
