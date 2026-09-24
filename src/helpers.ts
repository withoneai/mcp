/**
 * Utility Helper Functions
 * 
 * This module contains reusable utility functions used throughout the One MCP server.
 * 
 * @fileoverview Utility functions for data processing and API interactions
 * @author One
 */

import { PaginatedResponse, PermissionLevel, ConnectionAccess, ResolvedAllowedAction, ActionDetails, Connection, ConnectionDefinition, ListIntegrationsResponse } from './types.js';
import axios, { AxiosResponse } from 'axios';
import {
  parseSections,
  buildDigest,
  renderDigestBanner,
  renderDigestNotice,
  selectSections,
  flattenSections,
  parseSectionFlag,
  collapseSections,
  omittedSections,
} from './knowledge-sections.js';

/** A knowledge tool response: the text an agent reads plus a machine-readable
 * envelope. */
export interface KnowledgeResponse {
  text: string;
  structured: Record<string, unknown>;
}

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
 * Reduce an action's knowledge document to what the agent asked for, returning
 * both the text to read and a machine-readable envelope.
 *
 * By default a large doc is handed back as a digest (request-building sections
 * in full, plus a trailer and a `sections` list naming what was omitted); a
 * small doc is returned whole. `section` selects named section(s), `toc`
 * returns the full table of contents, and `full` (or `section: "all"`) returns
 * the document verbatim.
 *
 * @param knowledge - The raw knowledge markdown for the action
 * @param method - The action's HTTP method (echoed into the envelope)
 * @param platform - The kebab-case platform identifier (for the load-more hint)
 * @param actionId - The action ID (for the load-more hint)
 * @param options - `section`/`toc`/`full` select what to return
 */
export function buildKnowledgeResponse(
  knowledge: string,
  method: string,
  platform: string,
  actionId: string,
  options: { section?: string; full?: boolean; toc?: boolean } = {}
): KnowledgeResponse {
  const doc = parseSections(knowledge);
  const fullToc = flattenSections(doc.sections).map((s) => ({
    id: s.id,
    heading: s.heading,
    level: s.level,
    chars: s.chars,
  }));

  const sectionNames = parseSectionFlag(options.section);
  const specificSections = sectionNames.filter((n) => n.toLowerCase() !== 'all');
  // `full: true`, or a `section` value that is only "all", asks for the whole doc.
  const wantFull = options.full === true || (sectionNames.length > 0 && specificSections.length === 0);

  // A specific named section takes precedence over `toc` and `full`.
  if (specificSections.length > 0) {
    const picked = selectSections(doc, specificSections);
    if (!picked.ok) {
      // Collapse candidates the same way the digest does: a not-found on a
      // 400-heading doc must not answer with tens of KB of names.
      const toc = collapseSections(picked.candidates);
      const listing = toc.sections
        .map((c) => `${c.heading} [${c.id}] (${c.chars} chars${c.children ? `, +${c.children} nested` : ''})`)
        .join('\n');
      const lead =
        picked.reason === 'ambiguous'
          ? `Section "${picked.query}" matches several sections; pick one by id or full heading.`
          : `No section named "${picked.query}". Use one of the names below, or full: true.`;
      return {
        text: `${lead}\n\n${listing}`,
        structured: {
          error: lead,
          query: picked.query,
          reason: picked.reason,
          sections: toc.sections,
          ...(toc.collapsed ? { sectionsCollapsed: true, sectionCount: picked.candidates.length } : {}),
        },
      };
    }
    return {
      text: picked.markdown,
      structured: {
        title: doc.title,
        method,
        truncated: false,
        requested: specificSections,
        resolved: picked.sections.map((s) => ({ id: s.id, heading: s.heading, chars: s.chars })),
        sectionCount: fullToc.length,
      },
    };
  }

  if (options.toc) {
    const listing = fullToc.length
      ? fullToc.map((t) => `${'  '.repeat(Math.max(0, t.level - 1))}${t.heading} [${t.id}] (${t.chars} chars)`).join('\n')
      : '(this document has no sections)';
    return {
      text: `Table of contents. Load any by name with section: "<id or heading>", or the whole document with full: true.\n\n${listing}`,
      structured: { title: doc.title, method, chars: doc.chars, sections: fullToc },
    };
  }

  // `full`, and any document small enough to keep whole, are returned verbatim
  // rather than reconstructed from the parsed tree, so nothing is reformatted.
  if (wantFull) {
    return { text: knowledge, structured: { title: doc.title, method, truncated: false } };
  }

  const digest = buildDigest(doc);
  if (!digest.truncated) {
    return { text: knowledge, structured: { title: doc.title, method, truncated: false } };
  }

  const toc = omittedSections(digest);
  const text = [renderDigestBanner(digest), digest.markdown, renderDigestNotice(digest, platform, actionId)]
    .filter(Boolean)
    .join('\n\n');
  return {
    text,
    structured: {
      title: doc.title,
      method,
      truncated: true,
      omitted: digest.omitted,
      omittedChars: digest.omittedChars,
      sections: toc.sections,
      ...(toc.collapsed ? { sectionsCollapsed: true, sectionCount: digest.sections.length } : {}),
    },
  };
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

/** Folds a path variable name for loose matching: `ticket_id`, `ticketId`, `TICKET-ID` all fold to `ticketid`. */
const foldVariableName = (name: string) => name.toLowerCase().replace(/[\s_-]/g, '');

/**
 * Replaces path variables in a template string with actual values.
 * Path variables can be in either format: {variableName} or {{variableName}}.
 * A variable is looked up by its exact name first, then by name ignoring case,
 * underscores, hyphens and spaces, because knowledge docs and path templates
 * do not always spell a variable the same way (`ticket_id` vs `{{ticketId}}`).
 * @param path - The template string containing path variables in {variableName} or {{variableName}} format
 * @param variables - Object containing variable names as keys and their replacement values
 * @returns The path string with all variables replaced by their encoded values
 * @throws Error if any required variable is missing, null, undefined, or empty string, naming every variable the path expects
 */
export function replacePathVariables(path: string, variables: Record<string, string | number | boolean>): string {
  if (!path) return path;

  const expected = [...path.matchAll(/\{\{([^}]+)\}\}|\{([^{}]+)\}/g)].map((m) => (m[1] ?? m[2]).trim());
  const folded = new Map<string, string | number | boolean>();
  for (const [key, value] of Object.entries(variables ?? {})) {
    if (!folded.has(foldVariableName(key))) folded.set(foldVariableName(key), value);
  }

  const lookup = (variable: string) => {
    const name = variable.trim();
    const value = name in (variables ?? {}) ? variables[name] : folded.get(foldVariableName(name));
    if (value === undefined || value === null || value === '') {
      throw new Error(
        `Missing value for path variable: ${name}. This action's path is ${path}; pass pathVariables with: ${[...new Set(expected)].join(', ')}.`
      );
    }
    return encodeURIComponent(value.toString());
  };

  // Double brackets first, so {{name}} is not read as {name} wrapped in braces.
  return path.replace(/\{\{([^}]+)\}\}/g, (_match, variable) => lookup(variable)).replace(/\{([^}]+)\}/g, (_match, variable) => lookup(variable));
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

/**
 * Builds the `list_one_integrations` response: the user's active connections,
 * each with the access the current config confers. Access is only defined per
 * connection, so unconnected platforms are left out unless `available` is
 * passed (knowledge/code-gen mode, where an agent may write code against a
 * platform the user has not connected yet and needs its kebab-case name).
 * @param connections - The user's connections
 * @param access - The access config: permission level, action allowlist, and
 *   the allowlist already resolved to action metadata
 * @param available - Connection definitions to list as available platforms
 */
export function buildIntegrationsResponse(
  connections: Connection[],
  access: { permissions: PermissionLevel; actionIds: string[]; resolvedAllowed: ResolvedAllowedAction[] },
  available?: ConnectionDefinition[]
): ListIntegrationsResponse {
  const active = connections.filter((conn) => conn.active);
  const response: ListIntegrationsResponse = {
    connections: active.map((conn) => ({
      platform: conn.platform,
      key: conn.key,
      tags: conn.tags ?? [],
      access: computeConnectionAccess(conn.platform, access.permissions, access.actionIds, access.resolvedAllowed),
    })),
    summary: { connectedCount: active.length },
  };

  if (available) {
    const platforms = available.filter((def) => def.active && !def.deprecated);
    response.availablePlatforms = platforms.map((def) => ({
      platform: def.platform,
      name: def.name,
      category: def.category,
    }));
    response.summary.availableCount = platforms.length;
  }

  return response;
}
