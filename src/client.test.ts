import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { OneClient, stripReservedHeaders, describeError, answeredByPlatform } from './client.js';
import { ToolError } from './tool-error.js';
import type { ActionDetails, ExecuteOneActionArgs } from './types.js';

// A passthrough call must never let the caller override One's own routing/auth
// headers (the scoping bypass), and a failed call must never log the secret.

const SECRET = 'sk_test_REALSECRET_abc123';
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

  it('names the expected path variables instead of sending an unfilled template', async () => {
    const client = new OneClient(SECRET, base);
    const templated = { ...ACTION, path: '/v1/things/{{thingId}}' } as ActionDetails;
    await assert.rejects(client.executePassthroughRequest(exec({}), templated), /pass pathVariables with: thingId/);
    assert.equal(received.length, 0, 'nothing is sent upstream');

    await client.executePassthroughRequest(exec({ pathVariables: { thing_id: 7 } }), templated);
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
});

describe('describeError', () => {
  it('summarizes a plain error to its name and message', () => {
    const described = describeError(new Error('boom'));
    assert.equal(described.name, 'Error');
    assert.equal(described.message, 'boom');
  });
});
