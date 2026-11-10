import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_REQUEST_CHARS,
  APPROVAL_SCHEMA,
  ApprovalDeps,
  ApprovalLevel,
  ApprovalRequest,
  ElicitAnswer,
  approvalMessage,
  needsApproval,
  requireApproval,
  supportsFormElicitation,
} from './approval.js';
import { ToolError } from './tool-error.js';

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  actionId: 'act_1',
  title: 'Send Email',
  method: 'post',
  path: '/v1/gmail/send-email',
  platform: 'gmail',
  connectionKey: 'live::gmail::default::k',
  access: 'write',
  data: { to: 'a@example.com', subject: 'Hi' },
  ...overrides,
});

/** A session that answers `answer`, recording every prompt it was asked to show. */
function session(answer: ElicitAnswer | Error, ...declared: [ApprovalDeps['capabilities']] | []) {
  const capabilities = declared.length > 0 ? declared[0] : { elicitation: {} };
  const asked: { message: string; requestedSchema: unknown }[] = [];
  const deps: ApprovalDeps = {
    capabilities,
    async elicit(params) {
      asked.push(params);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { deps, asked };
}

describe('needsApproval', () => {
  const cases: [string | undefined, ApprovalLevel, boolean][] = [
    ['read', 'off', false],
    ['write', 'off', false],
    ['delete', 'off', false],
    [undefined, 'off', false],
    ['read', 'delete', false],
    ['write', 'delete', false],
    ['delete', 'delete', true],
    [undefined, 'delete', true],
    ['execute', 'delete', true],
    ['read', 'write', false],
    ['write', 'write', true],
    ['delete', 'write', true],
    [undefined, 'write', true],
  ];
  for (const [access, level, expected] of cases) {
    it(`${String(access)} at ${level} ${expected ? 'asks' : 'does not ask'}`, () => {
      assert.equal(needsApproval(access, level), expected);
    });
  }
});

describe('supportsFormElicitation', () => {
  it('reads an empty elicitation capability as form, and needs form when modes are named', () => {
    assert.equal(supportsFormElicitation(undefined), false);
    assert.equal(supportsFormElicitation({}), false);
    assert.equal(supportsFormElicitation({ elicitation: {} }), true);
    assert.equal(supportsFormElicitation({ elicitation: { form: {} } }), true);
    assert.equal(supportsFormElicitation({ elicitation: { form: {}, url: {} } }), true);
    assert.equal(supportsFormElicitation({ elicitation: { url: {} } }), false);
  });
});

describe('requireApproval', () => {
  it('runs a read without asking, even with approval on', async () => {
    const s = session(new Error('should not ask'));
    await requireApproval(request({ access: 'read' }), 'write', s.deps);
    assert.equal(s.asked.length, 0);
  });

  it('runs anything without asking when approval is off', async () => {
    const s = session(new Error('should not ask'), undefined);
    await requireApproval(request({ access: 'delete' }), 'off', s.deps);
    assert.equal(s.asked.length, 0);
  });

  it('runs once the user ticks the box', async () => {
    const s = session({ action: 'accept', content: { approve: true } });
    await requireApproval(request(), 'write', s.deps);
    assert.equal(s.asked.length, 1);
    assert.deepEqual(s.asked[0].requestedSchema, APPROVAL_SCHEMA);
  });

  for (const [label, answer] of [
    ['declined', { action: 'decline' }],
    ['accepted without ticking the box', { action: 'accept', content: { approve: false } }],
    ['accepted with no content', { action: 'accept' }],
    ['accepted with a truthy non-boolean', { action: 'accept', content: { approve: 'yes' } }],
    ['dismissed', { action: 'cancel' }],
  ] as [string, ElicitAnswer][]) {
    it(`refuses when the prompt is ${label}`, async () => {
      const s = session(answer);
      await assert.rejects(requireApproval(request(), 'write', s.deps), (e: unknown) => e instanceof ToolError && /was not run/.test(e.message));
    });
  }

  it('refuses when the prompt fails or times out', async () => {
    const s = session(new Error('Request timed out'));
    await assert.rejects(requireApproval(request({ access: 'delete' }), 'delete', s.deps), (e: unknown) => e instanceof ToolError && /Request timed out/.test(e.message));
  });

  it('refuses without asking when the client cannot show a prompt', async () => {
    for (const capabilities of [undefined, {}, { elicitation: { url: {} } }]) {
      const s = session({ action: 'accept', content: { approve: true } }, capabilities);
      await assert.rejects(requireApproval(request(), 'write', s.deps), (e: unknown) => e instanceof ToolError && /cannot show an approval prompt/.test(e.message));
      assert.equal(s.asked.length, 0);
    }
  });

  it('asks for an unclassified action at the delete level', async () => {
    const s = session({ action: 'accept', content: { approve: true } });
    await requireApproval(request({ access: undefined }), 'delete', s.deps);
    assert.ok(s.asked[0].message.includes('wants to run an unclassified action'));
  });
});

describe('approvalMessage', () => {
  it('names the action, where it runs and what it sends', () => {
    const text = approvalMessage(request({ pathVariables: { id: '42' }, queryParams: { dry: false } }));
    for (const part of ['write action on gmail', 'Send Email', 'POST /v1/gmail/send-email', 'live::gmail::default::k', '"to": "a@example.com"', '"id": "42"', '"dry": false']) {
      assert.ok(text.includes(part), part);
    }
  });

  it('shortens a large request and says so', () => {
    const text = approvalMessage(request({ data: { body: 'x'.repeat(10_000) } }));
    assert.ok(text.length < APPROVAL_REQUEST_CHARS + 500);
    assert.match(text, /more characters not shown/);
  });

  it('says when there is nothing to send', () => {
    const text = approvalMessage(request({ data: undefined }));
    assert.ok(text.includes('(no parameters)'));
  });
});
