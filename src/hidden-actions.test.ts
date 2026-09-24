import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isHiddenFromAgents } from './helpers.js';

describe('isHiddenFromAgents', () => {
  it('flags only actions tagged hidden:agents', () => {
    assert.equal(isHiddenFromAgents(['hidden:agents']), true);
    assert.equal(isHiddenFromAgents(['custom', 'hidden:agents']), true);
    assert.equal(isHiddenFromAgents(['custom']), false);
    assert.equal(isHiddenFromAgents([]), false);
    assert.equal(isHiddenFromAgents(undefined), false);
  });
});
