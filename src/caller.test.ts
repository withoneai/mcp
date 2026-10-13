import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callerHeaders } from './caller.js';

describe('callerHeaders', () => {
  it('always names the source, and nothing else when nothing is known', () => {
    assert.deepEqual(callerHeaders(), { 'x-one-source': 'cli' });
  });

  it('names the MCP client with its version, as core reads it', () => {
    assert.equal(callerHeaders({ client: { name: 'claude-code', version: '2.4.1' } })['x-one-agent'], 'claude-code/2.4.1');
    assert.equal(callerHeaders({ client: { name: 'cursor' } })['x-one-agent'], 'cursor');
    assert.equal(callerHeaders({ client: { name: '  ', version: '1.0' } })['x-one-agent'], undefined);
  });

  it('names the model only when the agent gave one', () => {
    assert.equal(callerHeaders({ model: ' claude-sonnet-5 ' })['x-one-agent-model'], 'claude-sonnet-5');
    assert.equal(callerHeaders({ model: '   ' })['x-one-agent-model'], undefined);
  });
});
