import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildKnowledgeResponse } from './helpers.js';

// Pure: string in, response out. No network, no home-directory access.

const bigSection = (label: string) =>
  `## ${label}\n` +
  Array.from({ length: 120 }, (_, i) => `- ${label} field ${i}: descriptive text adding length to the section body.`).join('\n');

const LARGE = [
  '# Send Email',
  '## Method\nPOST',
  '## URL\n/gmail/v1/messages/send',
  '## Headers\n- Authorization: Bearer',
  '## Request Body\n### Required Request Body Fields\n- to: string\n- subject: string',
  bigSection('Response Fields'),
  bigSection('Success Response'),
  bigSection('Optional Request Body Fields'),
].join('\n\n');

const SMALL = '# Tiny\n\n## Method\nGET\n\n## URL\n/x';

describe('buildKnowledgeResponse', () => {
  it('digests a large doc: request-building sections in full, omitted ones named in the envelope', () => {
    const r = buildKnowledgeResponse(LARGE, 'POST', 'gmail', 'act_1', {});
    assert.equal(r.wrap, true);
    assert.equal(r.structured.truncated, true);
    assert.ok((r.structured.omitted as number) >= 1);
    assert.ok(Array.isArray(r.structured.sections) && (r.structured.sections as unknown[]).length >= 1);
    assert.ok(r.text.includes('**Digest.**'));
    assert.ok(r.text.includes('get_one_action_knowledge'));
    // A deferred body is not inlined into the digest text.
    assert.ok(!r.text.includes('Response Fields field 100'));
    // No CLI-flag phrasing leaks into agent-visible text.
    assert.ok(!/--section|one --agent|--full|--toc/.test(r.text));
  });

  it('returns the whole table of contents for toc, with no bodies', () => {
    const r = buildKnowledgeResponse(LARGE, 'POST', 'gmail', 'act_1', { toc: true });
    assert.equal(r.wrap, false);
    assert.ok((r.structured.sections as unknown[]).length >= 5);
    assert.ok(r.text.includes('[response-fields]'));
    assert.ok(!r.text.includes('Response Fields field 100'));
  });

  it('returns a named section with its body and what it resolved to', () => {
    const r = buildKnowledgeResponse(LARGE, 'POST', 'gmail', 'act_1', { section: 'Response Fields' });
    assert.equal(r.wrap, false);
    assert.deepEqual((r.structured.resolved as { heading: string }[]).map((s) => s.heading), ['Response Fields']);
    assert.ok(r.text.includes('Response Fields field 100'));
  });

  it('reports a not-found section with a bounded candidate list', () => {
    const r = buildKnowledgeResponse(LARGE, 'POST', 'gmail', 'act_1', { section: 'nope' });
    assert.equal(r.wrap, false);
    assert.ok(r.structured.error);
    assert.equal(r.structured.reason, 'not-found');
    assert.ok((r.structured.sections as unknown[]).length >= 1);
    assert.ok(r.text.startsWith('No section named "nope"'));
  });

  it('treats section: "all" and full: true as the verbatim whole document', () => {
    for (const opts of [{ section: 'all' }, { full: true }]) {
      const r = buildKnowledgeResponse(LARGE, 'POST', 'gmail', 'act_1', opts);
      assert.equal(r.wrap, true);
      assert.equal(r.text, LARGE);
      assert.equal(r.structured.truncated, false);
    }
  });

  it('returns a small doc verbatim with no digest', () => {
    const r = buildKnowledgeResponse(SMALL, 'GET', 'gmail', 'act_1', {});
    assert.equal(r.wrap, true);
    assert.equal(r.text, SMALL);
    assert.equal(r.structured.truncated, false);
  });

  it('section wins over full when both are set', () => {
    const r = buildKnowledgeResponse(LARGE, 'POST', 'gmail', 'act_1', { section: 'Response Fields', full: true });
    assert.equal(r.wrap, false);
    assert.notEqual(r.text, LARGE);
    assert.ok(r.text.includes('Response Fields field 100'));
  });
});
