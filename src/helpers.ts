/**
 * Utility Helper Functions
 * 
 * This module contains reusable utility functions used throughout the One MCP server.
 * 
 * @fileoverview Utility functions for data processing and API interactions
 * @author One
 */

import { PaginatedResponse, PermissionLevel, ConnectionAccess, ResolvedAllowedAction, ActionDetails } from './types.js';
import axios, { AxiosResponse } from 'axios';

/**
 * Paginates through API results by repeatedly calling a fetch function until all data is retrieved.
 * @param fetchFn - Function that fetches paginated data, takes skip and limit parameters
 * @param limit - Maximum number of items to fetch per request (default: 100)
 * @returns Promise that resolves to an array of all paginated results
 */
export async function paginateResults<T>(
  fetchFn: (page: number, limit: number) => Promise<{
    rows: T[],
    total: number,
  }>,
  limit = 100
): Promise<T[]> {
  let page = 1;
  let allResults: T[] = [];
  let total = 0;

  try {
    do {
      const response = await fetchFn(page, limit);
      const { rows, total: totalCount } = response;
      total = totalCount;
      allResults = [...allResults, ...rows];
      page++;
    } while (allResults.length < total);

    return allResults;
  } catch (error) {
    console.error("Error in pagination:", error);
    throw error;
  }
}

/**
 * Generic function to fetch paginated data from any API endpoint
 * @param baseUrl - The base URL for the API endpoint (without query parameters)
 * @param headers - Headers to include in the request
 * @param additionalParams - Optional additional parameters to include in the request
 * @returns Promise that resolves to an array of all paginated results
 */
export async function fetchPaginatedData<T>(
  baseUrl: string,
  headers: Record<string, string>,
  additionalParams?: Record<string, string | number | boolean>
): Promise<T[]> {
  const fetchFn = async (page: number, limit: number): Promise<PaginatedResponse<T>> => {
    const params = {
      page,
      limit,
      ...additionalParams
    };

    try {
      const response: AxiosResponse<PaginatedResponse<T>> = await axios.get(baseUrl, {
        headers,
        params
      });
      return response.data;
    } catch (error) {
      console.error(`Failed to fetch from ${baseUrl}:`, error);
      throw error;
    }
  };

  return paginateResults<T>(fetchFn);
}

/**
 * Builds action knowledge with API request structure guidance.
 * @param knowledge - The raw knowledge content for the action
 * @param method - The HTTP method for the action
 * @param baseUrl - The base URL for One API
 * @param platform - The platform name (used for connection key)
 * @param actionId - The action ID
 * @returns Complete formatted knowledge with API guidance
 */
export function buildActionKnowledgeWithGuidance(
  knowledge: string,
  method: string,
  baseUrl: string,
  platform: string,
  actionId: string
): string {
  const cleanBaseUrl = baseUrl.replace(/\/$/, '');

  return `${knowledge}

API REQUEST STRUCTURE
======================
URL: ${cleanBaseUrl}/v1/passthrough/{{PATH}}

IMPORTANT: When constructing the URL, only include the API endpoint path after the base URL.
Do NOT include the full third-party API URL.

Examples:
✅ Correct: ${cleanBaseUrl}/v1/passthrough/crm/v3/objects/contacts/search
❌ Incorrect: ${cleanBaseUrl}/v1/passthrough/https://api.hubapi.com/crm/v3/objects/contacts/search

METHOD: ${method}

HEADERS:
- x-one-secret: {{process.env.ONE_SECRET}}
- x-one-connection-key: {{process.env.ONE_${platform.toUpperCase()}_CONNECTION_KEY}}
- x-one-action-id: ${actionId}
- ... (other headers)

BODY: {{BODY}}

QUERY PARAMS: {{QUERY_PARAMS}}`;
}

/**
 * Uppercases a platform id into an env-var segment, collapsing every
 * non-alphanumeric run to a single underscore ("ship-station" -> "SHIP_STATION").
 * @param platform - The kebab-case platform identifier
 * @returns The env-var-safe uppercase segment
 */
export function platformEnvSegment(platform: string): string {
  return platform
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .join("_");
}

const CUSTOM_ACTION_NOTE = `
- This is a custom action: ALSO include "connectionKey" (the same value as the
  x-one-connection-key header) as a field in the JSON body for non-GET requests.`;

/**
 * Builds the knowledge-mode response: the action's knowledge document followed
 * by the Integration Code Guide for writing application code against the One
 * Passthrough API (env vars, backend-only placement, headers, deployment).
 * Used only when ONE_KNOWLEDGE_AGENT is enabled; normal mode keeps
 * buildActionKnowledgeWithGuidance.
 * @param details - Full action details from the knowledge endpoint
 * @param platform - The kebab-case platform identifier from the tool args
 * @param baseUrl - The One API base URL (e.g. https://api.withone.ai)
 * @returns The knowledge text with the appended Integration Code Guide
 */
export function buildKnowledgeModeGuidance(
  details: ActionDetails,
  platform: string,
  baseUrl: string
): string {
  const apiBase = baseUrl.replace(/\/$/, "");
  const knowledge = details.knowledge || "No knowledge was found";
  const method = (details.method || "").toUpperCase();
  const path = details.path.startsWith("/") ? details.path : `/${details.path}`;
  const connEnv = `ONE_${platformEnvSegment(platform)}_CONNECTION_KEY`;
  const customNote = details.tags?.includes("custom") ? CUSTOM_ACTION_NOTE : "";

  return `${knowledge}

================================================================
INTEGRATION CODE GUIDE — using this action in an application
================================================================
You are in knowledge mode: this action cannot be executed here. Use this
guide to write integration code in the user's project.

## 1. Where this code must live
Server-side only — an API route, edge function, or backend handler
(e.g. Supabase Edge Function, Next.js route handler, Express route).
NEVER call this API from browser/client code and NEVER hardcode secret
values in source — read them from environment variables.

## 2. The request
All calls go through the One Passthrough API. Do NOT call the third-party
API URL from the documentation above directly.

URL:    ${apiBase}/v1/passthrough${path}
Method: ${method}
Headers:
- x-one-secret: the value of the ONE_SECRET env var
- x-one-connection-key: the value of the ${connEnv} env var
- x-one-action-id: ${details._id}
- Content-Type: application/json

The URL is the One base plus the action path ONLY:
✅ ${apiBase}/v1/passthrough${path}
❌ ${apiBase}/v1/passthrough/https://some-vendor-api.com${path}

## 3. Parameter placement
Per the documentation above:
- Path variables (placeholders like {{userId}} in the path) → substitute
  real values into the URL path; never send them in the body.
- Query parameters → the URL query string, not the body.
- Body fields → the JSON request body (POST/PUT/PATCH only).${customNote}

## 4. Environment variables & deployment
The code will not work until the user sets these in their hosting
platform's secrets manager (Supabase secrets, Vercel/Netlify environment
settings, or the project's env settings — never committed to code):
- ONE_SECRET → their One API key (from the One dashboard)
- ${connEnv} → the connection key for ${platform} (from list_one_integrations)
When you deliver the code, explicitly tell the user to set both.

## 5. Code generation rules
- Use TypeScript unless the user asked for another language.
- Include the complete input/output structure from the documentation
  above (required/optional fields, types) in the implementation.
- Handle errors: on a non-2xx response, read the response body and
  surface a useful message.
- Minimal example:

\`\`\`typescript
const response = await fetch("${apiBase}/v1/passthrough${path}", {
  method: "${method}",
  headers: {
    "x-one-secret": process.env.ONE_SECRET,
    "x-one-connection-key": process.env.${connEnv},
    "x-one-action-id": "${details._id}",
    "Content-Type": "application/json",
  },
  // body: JSON.stringify(...) — only for non-GET requests
});
\`\`\``;
}

/**
 * Replaces path variables in a template string with actual values.
 * Path variables can be in either format: {variableName} or {{variableName}} and will be replaced with corresponding values.
 * @param path - The template string containing path variables in {variableName} or {{variableName}} format
 * @param variables - Object containing variable names as keys and their replacement values
 * @returns The path string with all variables replaced by their encoded values
 * @throws Error if any required variable is missing, null, undefined, or empty string
 */
export function replacePathVariables(path: string, variables: Record<string, string | number | boolean>): string {
  if (!path) return path;

  let result = path;

  // First, replace double bracket variables {{variableName}}
  result = result.replace(/\{\{([^}]+)\}\}/g, (match, variable) => {
    const trimmedVariable = variable.trim();
    const value = variables[trimmedVariable];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing value for path variable: ${trimmedVariable}`);
    }
    return encodeURIComponent(value.toString());
  });

  // Then, replace single bracket variables {variableName}
  result = result.replace(/\{([^}]+)\}/g, (match, variable) => {
    const trimmedVariable = variable.trim();
    const value = variables[trimmedVariable];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing value for path variable: ${trimmedVariable}`);
    }
    return encodeURIComponent(value.toString());
  });

  return result;
}

const PERMISSION_METHODS: Record<PermissionLevel, string[] | null> = {
  read: ["GET"],
  write: ["GET", "POST", "PUT", "PATCH"],
  admin: null,
};

export function filterByPermissions<T extends { method: string }>(
  actions: T[],
  permissions: PermissionLevel
): T[] {
  const allowed = PERMISSION_METHODS[permissions];
  if (allowed === null) return actions;
  return actions.filter((a) => allowed.includes(a.method.toUpperCase()));
}

export function isMethodAllowed(
  method: string,
  permissions: PermissionLevel
): boolean {
  const allowed = PERMISSION_METHODS[permissions];
  if (allowed === null) return true;
  return allowed.includes(method.toUpperCase());
}

export function isActionAllowed(
  actionId: string,
  allowedActionIds: string[]
): boolean {
  return allowedActionIds.includes("*") || allowedActionIds.includes(actionId);
}

/**
 * What the current access config lets the agent run on a connection of
 * `platform`, so `list_one_integrations` can surface it without a search.
 * Mirrors the One core `resolve_connection_access` precedence:
 * an action allowlist wins (report the enumerated actions on this platform),
 * else a non-`admin` permission level reports its method set, else full.
 * `resolvedAllowed` is the allowlisted actions already resolved to their
 * metadata and method-filtered by the permission level.
 */
export function computeConnectionAccess(
  platform: string,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  resolvedAllowed: ResolvedAllowedAction[]
): ConnectionAccess {
  if (!allowedActionIds.includes("*")) {
    const actions = resolvedAllowed
      .filter(a => a.platform === platform)
      .map(({ actionId, title, method }) => ({ actionId, title, method }));
    return { policy: "actions", actions };
  }

  const methods = PERMISSION_METHODS[permissions];
  if (methods !== null) {
    return { policy: "methods", methods };
  }

  return { policy: "full" };
}
