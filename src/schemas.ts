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
    task: z.string().optional().describe('The whole task in one line, in general terms (e.g. "email a report to a contact"): what it does, without names, addresses, IDs or message text. Send it with every find: it helps tell similar actions apart. Never the chat history. Only with `requests`.'),
    load: z.array(z.object({
        action_id: z.string().describe("The actionId from a find_one_actions answer."),
        section: z.string().optional().describe('Section name(s) to load, comma-separated (e.g. "Response Fields"). Omit, with `full` and `toc` unset, for the digest. In knowledge mode every load returns the whole document, so `section` and `toc` do not narrow it.'),
        full: z.boolean().optional().describe("Load the whole document. Ignored when `section` is set."),
        toc: z.boolean().optional().describe("Load only the table of contents. Ignored when `section` is set.")
    })).min(1).max(10).optional().describe("More documentation for actions already found (1 to 10): a section the digest omitted, the whole document, the table of contents, or an alternative's documentation. Use instead of `requests`."),
    ai_model: z.string().optional().describe('Your model name as you know it (e.g. "claude-sonnet-5", "gpt-5"), recorded with this find. Send it with every find; leave it out only if you do not know which model you are.')
};

/**
 * Schema for executing One actions
 */
export const executeOneActionInputSchema = {
    platform: z.string().describe('The kebab-case platform of the connection (e.g. "gmail"), as list_one_integrations names it.'),
    actionId: z.string().describe("The actionId of the action to run, as returned when the action was found (or from the connection's `access` list)."),
    connectionKey: z.string().describe("The connection key for the caller's connection (from list_one_integrations)."),
    data: z.any().optional().describe("The request body. JSON by default; encoded as form data when isFormData or isFormUrlEncoded is set."),
    pathVariables: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Substitutions for {var} / {{var}} placeholders in the action path."),
    queryParams: z.record(z.any()).optional().describe("Query-string parameters appended to the request."),
    headers: z.record(z.string()).optional().describe("Extra request headers to forward to the upstream platform."),
    isFormData: z.boolean().optional().describe("Encode the body as multipart/form-data."),
    isFormUrlEncoded: z.boolean().optional().describe("Encode the body as application/x-www-form-urlencoded.")
};

/**
 * Output schema for execute_one_action. `responseData` comes first so a client
 * that cuts long output short still shows the payload.
 */
export const executeOneActionOutputSchema = {
    responseData: z.any().describe("The platform's response body, whatever its status."),
    status: z.number().describe("The platform's HTTP status. A 4xx or 5xx is the platform's answer: read `responseData` for its reason."),
    requestConfig: z.object({
        url: z.string(),
        method: z.string(),
        headers: z.record(z.string()),
        params: z.record(z.any()).optional(),
        data: z.any().optional()
    }).describe("The request as sent, with the One secret redacted.")
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
 * Hints for a tool that only reads One's own data, matching the remote MCP's:
 * clients may run it without asking the user.
 */
const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
};

/**
 * Tool configuration objects for registerTool
 */
export const listOneIntegrationsToolConfig = {
    title: "List One Integrations",
    description: "List the platforms the user has connected on One. ALWAYS call this tool first in any workflow. Each connection has the kebab-case `platform` name (e.g., 'ship-station', 'shopify') and the `key` (the connectionKey for execute_one_action) you'll need for subsequent tool calls. Each connection carries an `access` field describing what you may run on it: `full`, a set of allowed HTTP `methods`, or a specific list of `actions` (each with `actionId`, `title`, `method`). When a connection is action-scoped, its `actions` are exactly what may run, so you need not search.",
    inputSchema: listOneIntegrationsInputSchema,
    outputSchema: listOneIntegrationsOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS
};

export const findOneActionsToolConfig = {
    title: "Find Platform Actions",
    description: "Use this to find the API actions a task needs, on any platforms, in one call: send one `requests` entry per operation (platform and a short intent) and get back, for each, the action to use with its documentation, plus a few alternatives. Large documents come back as a digest; call again with `load` for a section it omitted, the whole document, the table of contents, or an alternative's documentation. Results are limited to what this server's settings allow. Call list_one_integrations first to see the connected platforms.",
    inputSchema: findOneActionsInputSchema,
    annotations: READ_ONLY_ANNOTATIONS
};

export const executeOneActionToolConfig = {
    title: "Execute One Action",
    description: "Execute a One action to perform actual operations on third-party platforms. CRITICAL: Only call this when the user's intent is to EXECUTE an action (e.g., 'read my last Gmail email', 'fetch 5 contacts from HubSpot', 'create a task in Asana'). DO NOT call this when the user wants to BUILD or CREATE code/forms/applications - in those cases, stop after find_one_actions and provide implementation guidance instead. REQUIRED WORKFLOW: Must call find_one_actions first, which returns the action's documentation. If uncertain about execution intent or parameters, ask for confirmation before proceeding.",
    inputSchema: executeOneActionInputSchema,
    outputSchema: executeOneActionOutputSchema,
    annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
    }
};

/**
 * Zod object schemas for type inference (for internal use)
 */
export const listOneIntegrationsZodSchema = z.object(listOneIntegrationsInputSchema);
export const findOneActionsZodSchema = z.object(findOneActionsInputSchema);
export const executeOneActionZodSchema = z.object(executeOneActionInputSchema);
