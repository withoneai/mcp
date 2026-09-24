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
  buildKnowledgeModeGuidance,
  buildKnowledgeResponse,
  filterByPermissions,
  isMethodAllowed,
  isActionAllowed,
  buildIntegrationsResponse,
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
  // The platform catalog is only listed in knowledge/code-gen mode.
  fetchConnectors: ONE_KNOWLEDGE_AGENT,
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
    // Resolve the action allowlist to per-platform metadata (method-filtered by
    // the permission level) once, so each connection can report the exact
    // actions it may run. Only needed when an action allowlist is set.
    const resolvedAllowed = (await oneClient.resolveAllowedActions(ONE_ACTION_IDS))
      .filter(action => isMethodAllowed(action.method, ONE_PERMISSIONS));

    // Execute mode lists only connections: every connection carries its
    // access, and the full catalog (800+ platforms) would sit in the agent's
    // context for the rest of the session. Knowledge/code-gen mode also lists
    // available platforms so code can target one that is not connected yet,
    // unless connection keys are scoped.
    const includeAvailable = ONE_KNOWLEDGE_AGENT && ONE_CONNECTION_KEYS.includes("*");
    const structuredResponse: ListIntegrationsResponse = buildIntegrationsResponse(
      oneClient.getUserConnections(),
      { permissions: ONE_PERMISSIONS, actionIds: ONE_ACTION_IDS, resolvedAllowed },
      includeAvailable ? oneClient.getAvailableConnectors() : undefined
    );

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

    if (ONE_KNOWLEDGE_AGENT) {
      // Knowledge/code-gen mode returns the full document: the appended
      // Integration Code Guide tells the agent to reproduce the complete
      // input and output structure, which the digest would defer. Digesting
      // is for the execute flow below, where the agent only needs to build
      // one request.
      const details = await oneClient.getActionDetails(actionId);
      const knowledgeWithGuide = buildKnowledgeModeGuidance(
        details,
        args.platform,
        oneClient.getBaseUrl()
      );

      return {
        content: [
          {
            type: "text" as const,
            text: knowledgeWithGuide,
          },
        ],
      };
    }

    const { knowledge, method } = await oneClient.getActionKnowledge(actionId);
    const response = buildKnowledgeResponse(knowledge, method, args.platform, actionId, {
      section: args.section,
      full: args.full,
      toc: args.toc,
    });

    const text = response.wrap
      ? buildActionKnowledgeWithGuidance(response.text, method, oneClient.getBaseUrl(), args.platform, actionId)
      : response.text;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
      structuredContent: response.structured,
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
