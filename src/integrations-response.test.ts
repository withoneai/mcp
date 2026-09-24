import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildIntegrationsResponse } from './helpers.js';
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
    assert.deepEqual(r.connections[0].access, { policy: 'methods', methods: ['GET'] });

    const scoped = buildIntegrationsResponse([conn('gmail')], {
      permissions: 'admin',
      actionIds: ['act_1'],
      resolvedAllowed: [{ actionId: 'act_1', title: 'Send Email', method: 'POST', platform: 'gmail' }],
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
