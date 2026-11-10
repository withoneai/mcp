import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { accessRefusal, buildIntegrationsResponse, isAccessAllowed } from './helpers.js';
import type { Connection, ConnectionDefinition } from './types.js';

const conn = (platform: string, active = true): Connection => ({ key: `live::${platform}::default::k`, platform, tags: [], active });
const def = (platform: string, extra: Partial<ConnectionDefinition> = {}) =>
  ({ platform, name: platform.toUpperCase(), category: 'Test', active: true, deprecated: false, ...extra }) as ConnectionDefinition;

const FULL = { permissions: 'admin' as const, actionIds: ['*'], resolvedAllowed: [] };

describe('buildIntegrationsResponse', () => {
  it('lists only active connections, without the platform catalog', () => {
    const r = buildIntegrationsResponse([conn('gmail'), conn('slack', false)], FULL);
    assert.deepEqual(r.connections.map((c) => c.platform), ['gmail']);
    assert.equal(r.availablePlatforms, undefined);
    assert.deepEqual(r.summary, { connectedCount: 1 });
  });

  it('keeps the per-connection access', () => {
    const r = buildIntegrationsResponse([conn('gmail')], { permissions: 'read', actionIds: ['*'], resolvedAllowed: [] });
    assert.deepEqual(r.connections[0].access, { policy: 'levels', levels: ['read'] });

    const writer = buildIntegrationsResponse([conn('gmail')], { permissions: 'write', actionIds: ['*'], resolvedAllowed: [] });
    assert.deepEqual(writer.connections[0].access, { policy: 'levels', levels: ['read', 'write'] });

    const scoped = buildIntegrationsResponse([conn('gmail')], {
      permissions: 'admin',
      actionIds: ['act_1'],
      resolvedAllowed: [{ actionId: 'act_1', title: 'Send Email', method: 'POST', access: 'write', platform: 'gmail' }],
    });
    assert.deepEqual(scoped.connections[0].access, {
      policy: 'actions',
      actions: [{ actionId: 'act_1', title: 'Send Email', method: 'POST' }],
    });
  });

  it('adds active, non-deprecated platforms when a catalog is passed (code-gen mode)', () => {
    const r = buildIntegrationsResponse([conn('gmail')], FULL, [
      def('gmail'),
      def('hubspot'),
      def('old-crm', { deprecated: true }),
      def('beta-thing', { active: false }),
    ]);
    assert.deepEqual(r.availablePlatforms, [
      { platform: 'gmail', name: 'GMAIL', category: 'Test' },
      { platform: 'hubspot', name: 'HUBSPOT', category: 'Test' },
    ]);
    assert.deepEqual(r.summary, { connectedCount: 1, availableCount: 2 });
  });
});

describe('isAccessAllowed', () => {
  const cases: [string | undefined | null, 'read' | 'write' | 'admin', boolean][] = [
    ['read', 'read', true],
    ['write', 'read', false],
    ['delete', 'read', false],
    ['read', 'write', true],
    ['write', 'write', true],
    ['delete', 'write', false],
    ['read', 'admin', true],
    ['write', 'admin', true],
    ['delete', 'admin', true],
    [undefined, 'read', false],
    [undefined, 'write', false],
    [null, 'write', false],
    ['READ', 'read', false],
    ['execute', 'write', false],
    [undefined, 'admin', true],
  ];

  for (const [access, level, expected] of cases) {
    it(`${String(access)} at ${level} is ${expected ? 'allowed' : 'refused'}`, () => {
      assert.equal(isAccessAllowed(access, level), expected);
    });
  }
});

describe('accessRefusal', () => {
  it('names the action, its level and the server level', () => {
    assert.equal(
      accessRefusal('act_1', 'delete', 'write'),
      `Action "act_1" is classified as delete, which this server's "write" permission level does not allow, so it cannot be run here.`
    );
  });

  it('says so when the action has no level', () => {
    assert.equal(
      accessRefusal('act_1', undefined, 'read'),
      `Action "act_1" has no access level, so this server's "read" permission level does not allow it and it cannot be run here.`
    );
  });
});
