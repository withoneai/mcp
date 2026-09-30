/**
 * MCP Tool Schemas
 * 
 * This file contains all tool schema definitions for MCP tools using zod.
 * Centralizing schemas here improves maintainability and reusability.
 * 
 * @fileoverview Complete tool schema definitions for all MCP tools
 * @author One
 */

import { z } from 'zod';

/**
 * Schema for listing One integrations (no parameters required)
 */
export const listOneIntegrationsInputSchema = {};

/**
 * Schema for finding actions and their documentation. Worded as the remote
 * MCP's `find_one_actions`, so an agent reads one tool on either surface.
 */
export const findOneActionsInputSchema = {
    requests: z.array(z.object({
        platform: z.string().describe('The kebab-case platform identifier (e.g. "gmail", "stripe").'),
        intent: z.string().describe('The operation alone, in a few words (e.g. "send a message to a channel"), without its data: no IDs, names or message text.')
    })).min(1).max(10).optional().describe('What to do, one entry per API operation, on any platforms (1 to 10). Each is the kebab-case platform (e.g. "gmail", "hubspot") and a short intent (e.g. "send an email", "find a contact by email").'),
    task: z.string().optional().describe('The whole task in one line, in general terms (e.g. "email a report to a contact"): what it does, without names, addresses, IDs or message text. It helps choose between similar actions. Never the chat history. Only with `requests`.'),
    load: z.array(z.object({
        action_id: z.string().describe("The actionId from a find_one_actions answer."),
        section: z.string().optional().describe('Section name(s) to load, comma-separated (e.g. "Response Fields"). Omit, with `full` and `toc` unset, for the digest. In knowledge mode every load returns the whole document, so `section` and `toc` do not narrow it.'),
        full: z.boolean().optional().describe("Load the whole document. Ignored when `section` is set."),
        toc: z.boolean().optional().describe("Load only the table of contents. Ignored when `section` is set.")
    })).min(1).max(10).optional().describe("More documentation for actions already found (1 to 10): a section the digest omitted, the whole document, the table of contents, or an alternative's documentation. Use instead of `requests`."),
    ai_model: z.string().optional().describe('The AI model you are running as (e.g. "claude-sonnet-5", "gpt-5"), which helps optimize the documentation returned. Optional.')
};

/**
 * Schema for executing One actions
 */
export const executeOneActionInputSchema = {
    platform: z.string().describe("Platform name"),
    actionId: z.string().describe("The actionId from find_one_actions"),
    connectionKey: z.string().describe("Key of the connection to use"),
    data: z.any().optional().describe("Request data (for POST, PUT, etc.)"),
    pathVariables: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Variables to replace in the path"),
    queryParams: z.record(z.any()).optional().describe("Query parameters"),
    headers: z.record(z.string()).optional().describe("Additional headers"),
    isFormData: z.boolean().optional().describe("Whether to send data as multipart/form-data"),
    isFormUrlEncoded: z.boolean().optional().describe("Whether to send data as application/x-www-form-urlencoded")
};

/**
 * Output schemas for list_one_integrations tool
 */
const connectionAccessSchema = z.union([
    z.object({
        policy: z.literal("full")
    }),
    z.object({
        policy: z.literal("methods"),
        methods: z.array(z.string())
    }),
    z.object({
        policy: z.literal("actions"),
        actions: z.array(z.object({
            actionId: z.string(),
            title: z.string(),
            method: z.string()
        }))
    })
]).describe("What the access config lets you run on this connection: `full`, an allowed `methods` set, or a specific `actions` list. When `actions`, those are exactly what may run, so no search is needed.");

export const listOneIntegrationsOutputSchema = {
    connections: z.array(z.object({
        platform: z.string(),
        key: z.string(),
        tags: z.array(z.string()),
        access: connectionAccessSchema
    })).describe("Array of user's active connections, each with the access the current config confers"),
    availablePlatforms: z.array(z.object({
        platform: z.string(),
        name: z.string(),
        category: z.string()
    })).optional().describe("Platforms that can be connected. Only listed in knowledge/code-gen mode"),
    summary: z.object({
        connectedCount: z.number(),
        availableCount: z.number().optional()
    }).describe("Counts of connections (and available platforms in knowledge/code-gen mode)")
};

/**
 * Tool configuration objects for registerTool
 */
export const listOneIntegrationsToolConfig = {
    title: "List One Integrations",
    description: "List the platforms the user has connected on One. ALWAYS call this tool first in any workflow. Each connection has the kebab-case `platform` name (e.g., 'ship-station', 'shopify') and the `key` (the connectionKey for execute_one_action) you'll need for subsequent tool calls. Each connection carries an `access` field describing what you may run on it: `full`, a set of allowed HTTP `methods`, or a specific list of `actions` (each with `actionId`, `title`, `method`). When a connection is action-scoped, its `actions` are exactly what may run, so you need not search.",
    inputSchema: listOneIntegrationsInputSchema,
    outputSchema: listOneIntegrationsOutputSchema
};

export const findOneActionsToolConfig = {
    title: "Find Platform Actions",
    description: "Use this to find the API actions a task needs, on any platforms, in one call: send one `requests` entry per operation (platform and a short intent) and get back, for each, the action to use with its documentation, plus a few alternatives. Large documents come back as a digest; call again with `load` for a section it omitted, the whole document, the table of contents, or an alternative's documentation. Results are limited to what this server's settings allow. Call list_one_integrations first to see the connected platforms.",
    inputSchema: findOneActionsInputSchema
};

export const executeOneActionToolConfig = {
    title: "Execute One Action",
    description: "Execute a One action to perform actual operations on third-party platforms. CRITICAL: Only call this when the user's intent is to EXECUTE an action (e.g., 'read my last Gmail email', 'fetch 5 contacts from HubSpot', 'create a task in Asana'). DO NOT call this when the user wants to BUILD or CREATE code/forms/applications - in those cases, stop after find_one_actions and provide implementation guidance instead. REQUIRED WORKFLOW: Must call find_one_actions first, which returns the action's documentation. If uncertain about execution intent or parameters, ask for confirmation before proceeding.",
    inputSchema: executeOneActionInputSchema
};

/**
 * Zod object schemas for type inference (for internal use)
 */
export const listOneIntegrationsZodSchema = z.object(listOneIntegrationsInputSchema);
export const findOneActionsZodSchema = z.object(findOneActionsInputSchema);
export const executeOneActionZodSchema = z.object(executeOneActionInputSchema);
