/**
 * Type definitions for the One MCP Server
 * 
 * This file contains all TypeScript interfaces and types used throughout the application.
 * 
 * @fileoverview Core type definitions for One API integration
 * @author One
 */

/**
 * API response structure for paginated endpoints
 */
export interface PaginatedResponse<T> {
  rows: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Definition of an available platform/connector that users can connect to
 */
export interface ConnectionDefinition {
  name: string;
  key: string;
  platform: string;
  platformVersion: string;
  description: string;
  category: string;
  image: string;
  tags: string[];
  oauth: boolean;
  createdAt: number;
  updatedAt: number;
  version: string;
  active: boolean;
  deprecated: boolean;
}

/**
 * Represents an active user connection to a platform
 */
export interface Connection {
  key: string;
  platform: string;
  tags: string[];
  active: boolean;
}

/**
 * Action details from knowledge endpoint (uses _id)
 */
export interface ActionDetails {
  _id: string;
  title: string;
  tags?: string[];
  knowledge?: string;
  path: string;
  method: string;
  connectionPlatform?: string;
}

/**
 * A single action the current access config permits on a connection, resolved
 * from an allowed action id. Mirrors the One core `GrantedAction` shape.
 */
export interface GrantedAction {
  actionId: string;
  title: string;
  method: string;
}

/**
 * What the current access config lets the agent run on one connection, so
 * `list_one_integrations` can answer "what can I do here" without a search.
 * Mirrors the One core `ConnectionAccess` shape (`policy` discriminant):
 * - `full`: every action on the connection.
 * - `methods`: only actions whose HTTP method is in the set.
 * - `actions`: only these specific actions.
 */
export type ConnectionAccess =
  | { policy: "full" }
  | { policy: "methods"; methods: string[] }
  | { policy: "actions"; actions: GrantedAction[] };

/**
 * An allowed action id resolved to its metadata, including the platform it
 * belongs to so it can be bucketed onto the matching connection.
 */
export interface ResolvedAllowedAction extends GrantedAction {
  platform: string;
}

/**
 * Arguments for list_one_integrations tool
 */
export interface ListOneIntegrationsArgs { }

/**
 * Action object structure for create_one_request tool
 */
export interface ActionObject {
  _id: string;
  path: string;
  method: string;
  tags?: string[];
}

/**
 * Arguments for create_one_request tool
 */
export interface ExecuteOneActionArgs {
  platform: string;
  actionId: string;
  connectionKey: string;
  data?: any,
  pathVariables?: Record<string, string | number | boolean>,
  queryParams?: Record<string, any>,
  headers?: Record<string, any>,
  isFormData?: boolean;
  isFormUrlEncoded?: boolean;
}

/**
 * HTTP request configuration for axios
 */
export interface RequestConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  params?: Record<string, string>;
  data?: unknown;
}

/**
 * Sanitized version of request config with sensitive data redacted
 */
export interface SanitizedRequestConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  params?: Record<string, string>;
  data?: unknown;
}

/**
 * Response from executePassthroughRequest
 */
export interface ExecutePassthroughResponse {
  requestConfig: SanitizedRequestConfig;
  responseData: unknown;
}

/**
 * Structured response for list_one_integrations tool
 */
export interface ListIntegrationsResponse {
  [x: string]: unknown;
  connections: Array<{
    platform: string;
    key: string;
    tags: string[];
    access: ConnectionAccess;
  }>;
  /** Only in knowledge/code-gen mode (ONE_KNOWLEDGE_AGENT). */
  availablePlatforms?: Array<{
    platform: string;
    name: string;
    category: string;
  }>;
  summary: {
    connectedCount: number;
    /** Only in knowledge/code-gen mode (ONE_KNOWLEDGE_AGENT). */
    availableCount?: number;
  };
}

export type PermissionLevel = "read" | "write" | "admin";

/** One operation an agent wants done on one platform. */
export interface FindIntent {
  platform: string;
  intent: string;
}

/** An action in a find answer, as core returns it. */
export interface FoundAction {
  systemId: string;
  title: string;
  key: string;
  method: string;
  path: string;
  tags: string[];
  knowledge?: string;
}

/** How core reached an intent's answer. */
export type FindSelector = 'model' | 'search_order' | 'none_fit';

/** Core's answer for one intent of `POST /v1/available-actions/find`. */
export interface FoundActions extends FindIntent {
  /** The actions to use: the pick, and any needed beside it. */
  selected: FoundAction[];
  /** Needed beside the pick, but left undocumented. */
  alsoSelected?: FoundAction[];
  /** A substitute for the pick when the model was unsure: one or the other, never both. */
  runnerUp?: FoundAction;
  /** Other candidates, undocumented. */
  alternatives: FoundAction[];
  selector: FindSelector;
  confidence?: number;
}

/** One `load` entry of the find tool. */
export interface FindLoadArgs {
  action_id: string;
  section?: string;
  full?: boolean;
  toc?: boolean;
}

/** Arguments of the `find_one_actions` tool: `requests` or `load`, never both. */
export interface FindOneActionsArgs {
  requests?: FindIntent[];
  task?: string;
  load?: FindLoadArgs[];
  ai_model?: string;
}
