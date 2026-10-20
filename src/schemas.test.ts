import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  executeOneActionToolConfig,
  findOneActionsToolConfig,
  listOneIntegrationsToolConfig,
} from './schemas.js';
import { ToolError, toolErrorResult } from './tool-error.js';
import type { ExecutePassthroughResponse } from './types.js';

// The hints and the execute output schema match the remote MCP's, so a client
// treats a tool the same on either surface.

const PLATFORM_404: ExecutePassthroughResponse = {
  responseData: { error: 'no such contact' },
  status: 404,
  requestConfig: { url: 'https://api.withone.ai/v1/passthrough/contacts/1', method: 'GET', headers: { 'x-one-secret': '***REDACTED***' } },
};

/** A client connected to a server offering the three tools, execute answering with `execute`. */
async function connect(execute: () => object) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  server.registerTool('list_one_integrations', listOneIntegrationsToolConfig, async () => ({
    content: [],
    structuredContent: { connections: [], summary: { connectedCount: 0 } },
  }));
  server.registerTool('find_one_actions', findOneActionsToolConfig, async () => ({ content: [] }));
  server.registerTool('execute_one_action', executeOneActionToolConfig, async () => execute() as never);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const CALL = { name: 'execute_one_action', arguments: { platform: 'hubspot', actionId: 'a', connectionKey: 'k' } };

describe('tool annotations', () => {
  it('mark execute destructive and open-world, and the rest read-only', async () => {
    const client = await connect(() => ({ content: [], structuredContent: PLATFORM_404 }));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 3);
    for (const tool of tools) {
      const hints = tool.annotations;
      assert.ok(hints && hints.readOnlyHint !== undefined && hints.openWorldHint !== undefined, `${tool.name} sets its hints`);
      if (tool.name === 'execute_one_action') {
        assert.deepEqual(
          [hints.readOnlyHint, hints.destructiveHint, hints.idempotentHint, hints.openWorldHint],
          [false, true, false, true]
        );
      } else {
        assert.deepEqual(
          [hints.readOnlyHint, hints.destructiveHint, hints.idempotentHint, hints.openWorldHint],
          [true, false, true, false],
          `${tool.name} is read-only`
        );
      }
    }
  });
});

describe('execute_one_action output', () => {
  it("accepts a platform's 404 as a result, not an error", async () => {
    const client = await connect(() => ({
      content: [{ type: 'text', text: JSON.stringify(PLATFORM_404) }],
      structuredContent: PLATFORM_404,
    }));
    const result = await client.callTool(CALL);
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, PLATFORM_404);
  });

  it('reports a tool error as an isError result the agent reads', async () => {
    const client = await connect(() => toolErrorResult(new ToolError('Connection key "k" is not one this server may use.')));
    const result = await client.callTool(CALL);
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: 'Connection key "k" is not one this server may use.' }]);
  });
});
