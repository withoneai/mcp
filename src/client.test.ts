import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { OneClient, stripReservedHeaders, describeError } from './client.js';
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
  let failBody: string | null = null;

  before(async () => {
    server = http.createServer((req, res) => {
      received.push({ headers: req.headers });
      if (failBody !== null) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(failBody);
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
    failBody = null;
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

  it('a failed call throws with the status, never logs the secret, and bounds the body', async () => {
    failBody = JSON.stringify({ error: 'upstream said no', padding: 'x'.repeat(2000) });
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
    assert.ok(message.includes('422'), 'the thrown tool error carries the status');
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
