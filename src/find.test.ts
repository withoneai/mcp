import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIND_ARGS_ERROR,
  FIND_EXECUTE_HINT,
  FindArgsError,
  FindDeps,
  FindSettings,
  REFUSED_LOAD,
  findOneActions,
} from './find.js';
import type { ActionDetails, FindIntent, FoundAction, FoundActions } from './types.js';

// Pure: core and the knowledge endpoint are stubbed, so no network is touched.

const LARGE = [
  '# Send Email',
  '## Endpoint\nPOST /v1/gmail/send-email',
  '## Request Body\n### Required Request Body Fields\n- to: string',
  `## Response Fields\n${Array.from({ length: 400 }, (_, i) => `- field ${i}: a described response field`).join('\n')}`,
].join('\n\n');

const action = (id: string, method = 'POST', tags: string[] = []): FoundAction => ({
  systemId: id,
  title: `Action ${id}`,
  key: `key-${id}`,
  method,
  path: `/v1/${id}`,
  tags,
  knowledge: 'a digest core rendered for its own route',
});

const answer = (overrides: Partial<FoundActions> = {}): FoundActions => ({
  platform: 'gmail',
  intent: 'send an email',
  selected: [action('a')],
  alternatives: [action('b'), action('c', 'GET')],
  selector: 'model',
  confidence: 0.92,
  ...overrides,
});

const settings = (overrides: Partial<FindSettings> = {}): FindSettings => ({
  knowledgeAgent: false,
  permissions: 'admin',
  actionIds: ['*'],
  platforms: null,
  baseUrl: 'https://api.withone.ai',
  ...overrides,
});

/** Core answering `answers` in turn, and raw knowledge per action. */
function deps(answers: FoundActions[], knowledge: Record<string, string> = {}): FindDeps & { asked: FindIntent[][] } {
  const asked: FindIntent[][] = [];
  return {
    asked,
    async findActions(requests) {
      asked.push(requests);
      return answers.slice(0, requests.length);
    },
    async getActionDetails(id): Promise<ActionDetails> {
      if (id === 'missing') throw new Error('not found');
      return {
        _id: id,
        title: `Action ${id}`,
        method: id === 'c' ? 'GET' : 'POST',
        path: `/v1/${id}`,
        tags: id === 'custom' ? ['custom'] : [],
        knowledge: knowledge[id] ?? `# Action ${id}\n\nSmall doc for ${id}.`,
        connectionPlatform: 'gmail',
      };
    },
  };
}

const intent = [{ platform: 'gmail', intent: 'send an email' }];

describe('find_one_actions', () => {
  it('takes requests or load, never both, never neither, and no task with a load', async () => {
    for (const args of [{}, { requests: intent, load: [{ action_id: 'a' }] }, { load: [{ action_id: 'a' }], task: 't' }]) {
      await assert.rejects(findOneActions(args, deps([answer()]), settings()), (e: Error) => e instanceof FindArgsError && e.message === FIND_ARGS_ERROR);
    }
  });

  it('names each action by actionId, documents the pick from its raw knowledge, and ends on the execute arguments once', async () => {
    const text = await findOneActions({ requests: intent, ai_model: 'claude-sonnet-5' }, deps([answer()], { a: LARGE }), settings());

    assert.ok(text.startsWith('## gmail: send an email\n\nChosen with confidence 0.92.'));
    assert.ok(text.includes('### Action a · `POST /v1/a` · actionId: `a`'));
    assert.ok(!text.includes('a digest core rendered for its own route'), "core's route digest is re-rendered, not relayed");
    assert.ok(text.includes('find_one_actions with load: [{ action_id: "a"'), 'the digest sends the agent back to this tool');
    assert.ok(!text.includes('get_one_action_knowledge') && !text.includes('/v1/available-actions/find/load'));
    assert.ok(text.includes('Alternatives, not documented (load with `find_one_actions` and `load: [{ action_id }]`):\n- Action b'));
    assert.equal(text.split(FIND_EXECUTE_HINT).length, 2, 'the execute hint closes the answer once');
  });

  it('sets the runner-up apart as a substitute', async () => {
    const text = await findOneActions({ requests: intent }, deps([answer({ runnerUp: action('b'), alternatives: [] })]), settings());

    assert.ok(text.includes('If the chosen action does not fit, use this one instead: one or the other, never both.\n\n### Action b'));
  });

  it('never offers an action this server refuses, promoting the next allowed one in place of a refused pick', async () => {
    const text = await findOneActions(
      { requests: intent },
      deps([answer({ selected: [action('a')], alternatives: [action('b'), action('c', 'GET')] })]),
      settings({ permissions: 'read' })
    );

    assert.ok(text.includes('The chosen action is not allowed on this server, so this is the next allowed candidate'));
    assert.ok(text.includes('### Action c · `GET /v1/c`'));
    assert.ok(!text.includes('actionId: `a`') && !text.includes('actionId: `b`'), 'refused actions are not even listed');
  });

  it('replaces a refused pick even when a companion survives, so the companion is never shown as the pick', async () => {
    const text = await findOneActions(
      { requests: intent },
      deps([answer({ selected: [action('a'), action('c', 'GET')], runnerUp: action('d', 'GET'), alternatives: [] })]),
      settings({ permissions: 'read' })
    );

    assert.ok(text.includes('The chosen action is not allowed on this server, so this is the next allowed candidate'));
    assert.ok(text.indexOf('actionId: `d`') < text.indexOf('actionId: `c`'), 'the runner-up stands in first, the companion after it');
    assert.ok(!text.includes('use this one instead'), 'the promoted runner-up is not also offered as a substitute');
  });

  it('serves the first document a load actually returns, however large, even after a refused entry', async () => {
    const huge = `# Huge\n\n${'x'.repeat(450_000)}`;
    const text = await findOneActions(
      { load: [{ action_id: 'missing' }, { action_id: 'a', full: true }] },
      deps([], { a: huge }),
      settings()
    );

    assert.ok(text.includes(huge), 'the only served document is not refused as too large');
  });

  it('says the settings are why when they refuse every action found, rather than asking for a rephrase', async () => {
    const text = await findOneActions(
      { requests: intent },
      deps([answer({ selected: [action('a')], alternatives: [action('b')] })]),
      settings({ permissions: 'read' })
    );

    assert.ok(text.includes("this server's settings (ONE_ACTION_IDS, ONE_PERMISSIONS) allow none of them"));
    assert.ok(!text.includes('Rephrase it'));
  });

  it('answers a platform no allowed connection reaches without asking core about it', async () => {
    const core = deps([answer({ platform: 'slack', intent: 'post a message' })]);
    const text = await findOneActions(
      { requests: [intent[0], { platform: 'slack', intent: 'post a message' }] },
      core,
      settings({ platforms: ['slack'] })
    );

    assert.deepEqual(core.asked, [[{ platform: 'slack', intent: 'post a message' }]]);
    assert.ok(text.includes('## gmail: send an email\n\nPlatform "gmail" has no allowed connections on this server.'));
    assert.ok(text.includes('## slack: post a message'));
  });

  it('in knowledge mode documents the pick whole with how to call it from code, and states the rules once', async () => {
    const text = await findOneActions(
      { requests: intent },
      deps([answer({ selected: [action('custom', 'POST', ['custom']), action('b')] })], { custom: LARGE }),
      settings({ knowledgeAgent: true })
    );

    assert.ok(text.includes(LARGE), 'the whole document, not a digest');
    assert.ok(text.includes('### Action custom · `POST /v1/custom` · actionId: `custom`\n**Platform:** gmail'));
    assert.ok(text.includes('x-one-action-id: custom'));
    assert.ok(text.includes('This is a custom action'));
    assert.ok(text.includes('Also chosen for this intent, documentation left out to keep the answer small'), 'whole documents are large, so only the pick is documented');
    assert.equal(text.split('INTEGRATION CODE GUIDE').length, 2);
    assert.ok(!text.includes('execute_one_action'));
  });

  it('says why when nothing fits, and adds no closing hint when nothing was documented', async () => {
    const text = await findOneActions({ requests: intent }, deps([answer({ selected: [], alternatives: [], selector: 'none_fit' })]), settings());

    assert.ok(text.includes('No action fits this intent, and nothing close was found.'));
    assert.ok(!text.includes(FIND_EXECUTE_HINT));
  });

  it('loads what each entry asked for, refusing one this server may not use in the words for a missing one', async () => {
    const text = await findOneActions(
      { load: [{ action_id: 'a', section: 'Response Fields' }, { action_id: 'missing' }, { action_id: 'b' }] },
      deps([], { a: LARGE }),
      settings({ actionIds: ['a', 'missing'] })
    );

    assert.ok(text.includes('### Action a'));
    assert.ok(text.includes('field 399'), 'the named section is served');
    assert.ok(!text.includes('POST /v1/gmail/send-email'), 'and only that section');
    assert.ok(text.includes(`\`missing\`: ${REFUSED_LOAD}`));
    assert.ok(text.includes(`\`b\`: ${REFUSED_LOAD}`), 'an action outside ONE_ACTION_IDS reads as missing');
  });
});
