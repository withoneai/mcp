#!/usr/bin/env node

/**
 * One MCP Server - Main Entry Point
 *
 * This is the main MCP (Model Context Protocol) server implementation for One.
 *
 * @fileoverview Main MCP server implementation with One API integration
 * @author One
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { OneClient } from './client.js';
import {
  buildActionKnowledgeWithGuidance,
  filterByPermissions,
  isMethodAllowed,
  isActionAllowed,
} from './helpers.js';
import {
  listOneIntegrationsToolConfig,
  searchOnePlatformActionsToolConfig,
  getOneActionKnowledgeToolConfig,
  executeOneActionToolConfig,
  listOneIntegrationsZodSchema,
  searchOnePlatformActionsZodSchema,
  getOneActionKnowledgeZodSchema,
  executeOneActionZodSchema
} from './schemas.js';
import {
  ListOneIntegrationsArgs,
  SearchOnePlatformActionsArgs,
  GetOneActionKnowledgeArgs,
  ExecuteOneActionArgs,
  ListIntegrationsResponse,
  SearchActionsResponse,
  PermissionLevel
} from './types.js';
import { z } from 'zod';

const SERVER_NAME = "one-mcp-server";
const SERVER_VERSION = "1.0.0";

const ONE_SECRET = process.env.ONE_SECRET;
if (!ONE_SECRET) {
  console.error("ONE_SECRET environment variable is required");
  process.exit(1);
}

const ONE_BASE_URL = process.env.ONE_BASE_URL || "https://api.withone.ai";
const ONE_IDENTITY = process.env.ONE_IDENTITY;
const ONE_IDENTITY_TYPE = process.env.ONE_IDENTITY_TYPE as 'user' | 'team' | 'organization' | 'project' | undefined;

const ONE_PERMISSIONS: PermissionLevel = (process.env.ONE_PERMISSIONS as PermissionLevel) || "admin";
if (!["read", "write", "admin"].includes(ONE_PERMISSIONS)) {
  console.error(`Invalid ONE_PERMISSIONS value: "${ONE_PERMISSIONS}". Must be one of: read, write, admin`);
  process.exit(1);
}

const ONE_CONNECTION_KEYS: string[] = process.env.ONE_CONNECTION_KEYS
  ? process.env.ONE_CONNECTION_KEYS.split(",").map(s => s.trim()).filter(Boolean)
  : ["*"];

const ONE_ACTION_IDS: string[] = process.env.ONE_ACTION_IDS
  ? process.env.ONE_ACTION_IDS.split(",").map(s => s.trim()).filter(Boolean)
  : ["*"];

const ONE_KNOWLEDGE_AGENT: boolean = process.env.ONE_KNOWLEDGE_AGENT === "true";

const oneClient = new OneClient({
  secret: ONE_SECRET,
  baseUrl: ONE_BASE_URL,
  identity: ONE_IDENTITY,
  identityType: ONE_IDENTITY_TYPE,
  connectionKeys: ONE_CONNECTION_KEYS,
});

let oneInitialized = false;
let initializationPromise: Promise<void> | null = null;

const initializeOne = async () => {
  if (oneInitialized) {
    return;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      await oneClient.initialize();
      oneInitialized = true;
    } catch (error) {
      console.error("Failed to initialize One client:", error);
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
};

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  }
);

server.registerTool(
  "list_one_integrations",
  listOneIntegrationsToolConfig,
  async (args: z.infer<typeof listOneIntegrationsZodSchema>) => {
    await initializeOne();
    return await handleGetIntegrations(args as ListOneIntegrationsArgs);
  }
);

server.registerTool(
  "search_one_platform_actions",
  searchOnePlatformActionsToolConfig,
  async (args: z.infer<typeof searchOnePlatformActionsZodSchema>) => {
    await initializeOne();
    return await handleSearchPlatformActions(args as SearchOnePlatformActionsArgs);
  }
);

server.registerTool(
  "get_one_action_knowledge",
  getOneActionKnowledgeToolConfig,
  async (args: z.infer<typeof getOneActionKnowledgeZodSchema>) => {
    await initializeOne();
    return await handleGetActionKnowledge(args as GetOneActionKnowledgeArgs);
  }
);

if (!ONE_KNOWLEDGE_AGENT) {
  server.registerTool(
    "execute_one_action",
    executeOneActionToolConfig,
    async (args: z.infer<typeof executeOneActionZodSchema>) => {
      await initializeOne();
      return await handleExecuteOneAction(args as ExecuteOneActionArgs);
    }
  );
}

async function handleGetIntegrations(args: ListOneIntegrationsArgs) {
  try {
    const connectedIntegrations = oneClient.getUserConnections();
    const availableIntegrations = oneClient.getAvailableConnectors();

    const activeConnections = connectedIntegrations.filter(conn => conn.active);
    let activePlatforms = availableIntegrations.filter(def => def.active && !def.deprecated);

    // When connection keys are scoped, only show platforms that match active connections
    if (!ONE_CONNECTION_KEYS.includes("*")) {
      const connectedPlatforms = new Set(activeConnections.map(conn => conn.platform));
      activePlatforms = activePlatforms.filter(def => connectedPlatforms.has(def.platform));
    }

    const structuredResponse: ListIntegrationsResponse = {
      connections: activeConnections.map(conn => ({
        platform: conn.platform,
        key: conn.key,
        tags: conn.tags ?? []
      })),
      availablePlatforms: activePlatforms.map(def => ({
        platform: def.platform,
        name: def.name,
        category: def.category
      })),
      summary: {
        connectedCount: activeConnections.length,
        availableCount: activePlatforms.length
      }
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(structuredResponse, null, 2),
        },
      ],
      structuredContent: structuredResponse,
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to retrieve integrations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

async function handleSearchPlatformActions(args: SearchOnePlatformActionsArgs) {
  try {
    // Force knowledge mode when ONE_KNOWLEDGE_AGENT is enabled
    const agentType = ONE_KNOWLEDGE_AGENT ? "knowledge" : args.agentType;
    let actions = await oneClient.searchAvailableActions(args.platform, args.query, agentType);

    // Apply permission-level filtering
    actions = filterByPermissions(actions, ONE_PERMISSIONS);

    // Apply action allowlist filtering
    actions = actions.filter(a => isActionAllowed(a.systemId, ONE_ACTION_IDS));

    const cleanedActions = actions.map(action => ({
      actionId: action.systemId,
      title: action.title,
      method: action.method,
      path: action.path
    }));

    // Handle empty results with helpful suggestions
    if (cleanedActions.length === 0) {
      const suggestionsText = `No actions found for platform '${args.platform}' matching query '${args.query}'.

SUGGESTIONS:
- Try a more general query (e.g., 'list', 'get', 'search', 'create')
- Verify the platform name is correct
- Check that actions exist for this platform using list_one_integrations

EXAMPLES OF GOOD QUERIES:
- "search contacts"
- "send email"
- "create customer"
- "list orders"`;

      return {
        content: [
          {
            type: "text" as const,
            text: suggestionsText,
          },
        ],
      };
    }

    // Build structured response
    const structuredResponse: SearchActionsResponse = {
      actions: cleanedActions,
      metadata: {
        platform: args.platform,
        query: args.query,
        count: cleanedActions.length
      }
    };

    const responseText = `Found ${cleanedActions.length} action(s) for platform '${args.platform}' matching query '${args.query}':

${JSON.stringify(structuredResponse, null, 2)}

NEXT STEP: Use get_one_action_knowledge with an actionId to get detailed documentation before building requests or executing actions.`;

    return {
      content: [
        {
          type: "text" as const,
          text: responseText,
        },
      ],
      structuredContent: structuredResponse,
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to search platform actions: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

async function handleGetActionKnowledge(args: GetOneActionKnowledgeArgs) {
  try {
    const actionId = args.actionId;

    if (!isActionAllowed(actionId, ONE_ACTION_IDS)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Action "${actionId}" is not in the allowed action list`
      );
    }

    if (!ONE_CONNECTION_KEYS.includes("*")) {
      const connectedPlatforms = oneClient.getUserConnections().map(c => c.platform);
      if (!connectedPlatforms.includes(args.platform)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Platform "${args.platform}" has no allowed connections`
        );
      }
    }

    const { knowledge, method } = await oneClient.getActionKnowledge(actionId);

    const knowledgeWithGuidance = buildActionKnowledgeWithGuidance(
      knowledge,
      method,
      oneClient.getBaseUrl(),
      args.platform,
      actionId
    );

    return {
      content: [
        {
          type: "text" as const,
          text: knowledgeWithGuidance,
        },
      ],
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to retrieve action knowledge: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

async function handleExecuteOneAction(args: ExecuteOneActionArgs) {
  try {
    if (!isActionAllowed(args.actionId, ONE_ACTION_IDS)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Action "${args.actionId}" is not in the allowed action list`
      );
    }

    if (!ONE_CONNECTION_KEYS.includes("*")) {
      const allowedKeys = oneClient.getUserConnections().map(c => c.key);
      if (!allowedKeys.includes(args.connectionKey)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Connection key "${args.connectionKey}" is not allowed`
        );
      }
    }

    const actionDetails = await oneClient.getActionDetails(args.actionId);

    if (!isMethodAllowed(actionDetails.method, ONE_PERMISSIONS)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Method "${actionDetails.method}" is not allowed under "${ONE_PERMISSIONS}" permission level`
      );
    }

    const result = await oneClient.executePassthroughRequest(args, actionDetails);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to execute One action: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.error('Shutting down server...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('Shutting down server...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
