/**
 * One API Client
 * 
 * This module provides a TypeScript client for interacting with the One API.
 * 
 * @fileoverview One API client with authentication and data management
 * @author One
 */

import axios, { AxiosResponse } from 'axios';
import FormData from 'form-data';
import {
  Connection,
  ConnectionDefinition,
  AvailableAction,
  ActionDetails,
  GetOneActionKnowledgeResponse,
  ExecuteOneActionArgs,
  RequestConfig,
  ExecutePassthroughResponse,
  ResolvedAllowedAction
} from './types.js';
import { fetchPaginatedData, replacePathVariables } from './helpers.js';

/** Header names that only the server may set on an outgoing request. */
const RESERVED_HEADER_PREFIX = 'x-one-';

/**
 * Drops any caller-supplied header that One itself controls (`x-one-secret`,
 * `x-one-connection-key`, `x-one-action-id`, ...). Comparison is
 * case-insensitive because HTTP header names are.
 */
export function stripReservedHeaders(headers?: Record<string, any>): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !name.toLowerCase().startsWith(RESERVED_HEADER_PREFIX))
      .map(([name, value]) => [name, String(value)])
  );
}

/**
 * Bounds an upstream error body before it is logged: small payloads pass
 * through, larger ones are truncated to a string, and an unserializable value
 * is replaced with a placeholder. Keeps a huge or odd error response from
 * bloating a single log line.
 */
function summarizeErrorData(data: unknown): unknown {
  if (data === undefined || data === null) return undefined;
  let serialized: string;
  try {
    serialized = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    return '[unserializable response body]';
  }
  const MAX = 1000;
  return serialized.length <= MAX ? data : `${serialized.slice(0, MAX)}… (${serialized.length} chars, truncated)`;
}

/**
 * A log-safe summary of a failed request. Axios errors carry the full request
 * config, including the `x-one-secret` header, so they must never be logged
 * whole. Only the status, the upstream message, the route (query stripped), and
 * a bounded copy of the response body are kept.
 */
export function describeError(error: unknown): Record<string, unknown> {
  if (axios.isAxiosError(error)) {
    const url = error.config?.url;
    return {
      status: error.response?.status,
      statusText: error.response?.statusText,
      method: error.config?.method?.toUpperCase(),
      url: typeof url === 'string' ? url.split('?')[0] : undefined,
      message: error.message,
      data: summarizeErrorData(error.response?.data),
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { error: String(error) };
}

export type IdentityType = 'user' | 'team' | 'organization' | 'project';

export interface OneClientOptions {
  secret: string;
  baseUrl?: string;
  identity?: string;
  identityType?: IdentityType;
  connectionKeys?: string[];
}

/**
 * Client for interacting with the One API
 */
export class OneClient {
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly identity?: string;
  private readonly identityType?: IdentityType;
  private readonly connectionKeys?: string[];
  private connections: Connection[] = [];
  private connectors: ConnectionDefinition[] = [];
  private isInitialized = false;
  private allowedActionsCache: ResolvedAllowedAction[] | null = null;
  // Short-lived cache of fetched action details, keyed by action ID. The
  // knowledge digest and a follow-up section/toc/full call both need the same
  // document, so this lets the follow-up reuse it instead of re-fetching.
  private static readonly ACTION_DETAILS_TTL_MS = 5 * 60_000;
  private readonly actionDetailsCache = new Map<string, { details: ActionDetails; expiresAt: number }>();

  constructor(options: OneClientOptions);
  constructor(secret: string, baseUrl?: string);
  constructor(optionsOrSecret: OneClientOptions | string, baseUrl = "https://api.withone.ai") {
    if (typeof optionsOrSecret === 'string') {
      // Legacy constructor: (secret, baseUrl)
      if (!optionsOrSecret?.trim()) {
        throw new Error("One secret is required and cannot be empty");
      }
      this.secret = optionsOrSecret;
      this.baseUrl = baseUrl.replace(/\/$/, '');
    } else {
      // New constructor: (options)
      if (!optionsOrSecret.secret?.trim()) {
        throw new Error("One secret is required and cannot be empty");
      }
      this.secret = optionsOrSecret.secret;
      this.baseUrl = (optionsOrSecret.baseUrl || "https://api.withone.ai").replace(/\/$/, '');
      this.identity = optionsOrSecret.identity;
      this.identityType = optionsOrSecret.identityType;
      this.connectionKeys = optionsOrSecret.connectionKeys;
    }
  }

  /**
   * Initializes the client by fetching connections and available connectors
   * @throws {Error} If initialization fails completely
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const results = await Promise.allSettled([
      this.fetchConnections(),
      this.fetchConnectionDefinitions(),
    ]);

    const [connectionsResult, connectorsResult] = results;

    if (connectionsResult.status === 'rejected') {
      console.error("Failed to fetch connections:", describeError(connectionsResult.reason));
      this.connections = [];
    }

    if (connectorsResult.status === 'rejected') {
      console.error("Failed to fetch connectors:", describeError(connectorsResult.reason));
      this.connectors = [];
    }

    this.isInitialized = true;
  }

  /**
   * Generates standard headers for API requests
   */
  public generateHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-one-secret": this.secret,
    };
  }

  /**
   * Fetches user connections from the API
   */
  private async fetchConnections(): Promise<void> {
    try {
      // If connectionKeys is set, not ["*"], and empty → no connections
      if (this.connectionKeys && !this.connectionKeys.includes("*") && this.connectionKeys.length === 0) {
        this.connections = [];
        return;
      }

      const headers = this.generateHeaders();
      const url = `${this.baseUrl}/v1/vault/connections`;

      const additionalParams: Record<string, string> = {};
      if (this.identity) {
        additionalParams.identity = this.identity;
      }
      if (this.identityType) {
        additionalParams.identityType = this.identityType;
      }
      if (this.connectionKeys && !this.connectionKeys.includes("*")) {
        additionalParams.key = this.connectionKeys.join(",");
      }

      this.connections = await fetchPaginatedData<Connection>(
        url,
        headers,
        Object.keys(additionalParams).length > 0 ? additionalParams : undefined
      );
    } catch (error) {
      console.error("Failed to fetch connections:", describeError(error));
      this.connections = [];
      throw error;
    }
  }

  /**
   * Fetches available connection definitions from the API
   */
  private async fetchConnectionDefinitions(): Promise<void> {
    try {
      const headers = this.generateHeaders();
      const url = `${this.baseUrl}/v1/available-connectors`;
      this.connectors = await fetchPaginatedData<ConnectionDefinition>(url, headers);
    } catch (error) {
      console.error("Failed to fetch connection definitions:", describeError(error));
      this.connectors = [];
      throw error;
    }
  }

  /**
   * Searches for actions on a specific platform using a query
   * @param platform - The platform name to search actions for
   * @param query - The search query to find relevant actions
   * @param agentType - The type of agent context (execute or knowledge)
   * @returns Array of top 5 most relevant actions for the platform
   * @throws {Error} If platform or query is not provided or API request fails
   */
  async searchAvailableActions(platform: string, query: string, agentType?: "execute" | "knowledge"): Promise<AvailableAction[]> {
    if (!platform?.trim()) {
      throw new Error("Platform name is required");
    }
    if (!query?.trim()) {
      throw new Error("Search query is required");
    }

    try {
      const headers = this.generateHeaders();
      const url = `${this.baseUrl}/v1/available-actions/search/${platform}`;

      // Default to knowledgeAgent if not specified
      const isKnowledgeAgent = !agentType || agentType === "knowledge";

      const params: Record<string, string> = {
        query,
        limit: '5'
      };

      if (isKnowledgeAgent) {
        params.knowledgeAgent = 'true';
      } else {
        params.executeAgent = 'true';
      }

      const response: AxiosResponse<AvailableAction[]> = await axios.get(url, {
        headers,
        params
      });

      return response.data || [];
    } catch (error) {
      console.error("Error searching available actions:", describeError(error));
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to search available actions: ${error.response?.status} ${error.response?.statusText}`);
      }
      throw new Error("Failed to search available actions");
    }
  }

  /**
   * Gets full action details by ID
   * @param actionId - The action ID to get details for
   * @returns The full action object
   * @throws {Error} If action ID is not provided or API request fails
   */
  async getActionDetails(actionId: string): Promise<ActionDetails> {
    if (!actionId?.trim()) {
      throw new Error("Action ID is required");
    }

    const cached = this.actionDetailsCache.get(actionId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.details;
    }

    try {
      const headers = this.generateHeaders();
      const url = `${this.baseUrl}/v1/knowledge`;
      const params = {
        _id: actionId
      };

      const response: AxiosResponse<{ rows: ActionDetails[] }> = await axios.get(url, {
        headers,
        params
      });

      const actions = response.data?.rows || [];

      if (actions.length === 0) {
        throw new Error(`Action with ID ${actionId} not found`);
      }

      this.actionDetailsCache.set(actionId, {
        details: actions[0],
        expiresAt: Date.now() + OneClient.ACTION_DETAILS_TTL_MS
      });
      return actions[0];
    } catch (error) {
      console.error("Error fetching action details:", describeError(error));
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to fetch action details: ${error.response?.status} ${error.response?.statusText}`);
      }
      throw new Error("Failed to fetch action details");
    }
  }

  /**
   * Gets knowledge for a specific action by ID
   * @param actionId - The action ID to get knowledge for
   * @returns The knowledge string for the action
   * @throws {Error} If action ID is not provided or API request fails
   */
  async getActionKnowledge(actionId: string): Promise<GetOneActionKnowledgeResponse> {
    try {
      const action = await this.getActionDetails(actionId);

      if (!action.knowledge || !action.method) {
        return {
          knowledge: "No knowledge was found",
          method: "No method was found"
        };
      }

      return {
        knowledge: action.knowledge,
        method: action.method
      };
    } catch (error) {
      console.error("Error fetching action knowledge:", describeError(error));
      throw error;
    }
  }

  /**
   * Resolves an allowlist of action ids to their metadata (title, method, and
   * owning platform), so `list_one_integrations` can report each connection's
   * enumerated actions. `"*"` (unrestricted) resolves to an empty list — there
   * is no allowlist to enumerate. Ids that fail to resolve or carry no platform
   * are skipped rather than failing the whole call. The result is cached: the
   * allowlist is fixed for the process lifetime.
   * @param actionIds - The configured `ONE_ACTION_IDS` allowlist
   * @returns Resolved metadata for every enumerable allowed action
   */
  async resolveAllowedActions(actionIds: string[]): Promise<ResolvedAllowedAction[]> {
    if (actionIds.includes("*")) {
      return [];
    }
    if (this.allowedActionsCache) {
      return this.allowedActionsCache;
    }

    const resolved = await Promise.all(
      actionIds.map(async (actionId): Promise<ResolvedAllowedAction | null> => {
        try {
          const action = await this.getActionDetails(actionId);
          if (!action.connectionPlatform) {
            return null;
          }
          return {
            actionId,
            title: action.title,
            method: action.method,
            platform: action.connectionPlatform
          };
        } catch (error) {
          console.error(`Failed to resolve allowed action ${actionId}:`, describeError(error));
          return null;
        }
      })
    );

    this.allowedActionsCache = resolved.filter((a): a is ResolvedAllowedAction => a !== null);
    return this.allowedActionsCache;
  }

  /**
   * Executes a passthrough request to a third-party API through One
   * @param args - The execution arguments containing all request details
   * @returns Object containing sanitized request config and response data
   * @throws {Error} If the request fails
   */
  async executePassthroughRequest(args: ExecuteOneActionArgs, preloadedAction?: ActionDetails): Promise<ExecutePassthroughResponse> {
    const {
      actionId,
      connectionKey,
      data,
      pathVariables,
      queryParams,
      headers,
      isFormData,
      isFormUrlEncoded,
    } = args;

    // Use preloaded action or fetch action details
    const action = preloadedAction ?? await this.getActionDetails(actionId);

    const method = action.method;
    const contentType = isFormData ? 'multipart/form-data' : isFormUrlEncoded ? 'application/x-www-form-urlencoded' : 'application/json';

    // Caller-supplied headers are merged first and may adjust things like
    // Content-Type, but they can never override One's own routing and auth
    // headers. Those are applied last, after the connection and action
    // allowlist checks in index.ts have already passed, so an `x-one-*`
    // header in `headers` cannot redirect the call to another connection,
    // action, or secret.
    // Drop One's default Content-Type (any casing) so the caller's choice,
    // merged in below, is not clobbered when the auth headers are applied last.
    const authHeaders = Object.fromEntries(
      Object.entries(this.generateHeaders()).filter(([name]) => name.toLowerCase() !== 'content-type')
    );
    const requestHeaders: Record<string, string> = {
      'Content-Type': contentType,
      ...stripReservedHeaders(headers),
      ...authHeaders,
      'x-one-connection-key': connectionKey,
      'x-one-action-id': action._id,
    };

    const finalActionPath = pathVariables
      ? replacePathVariables(action.path, pathVariables)
      : action.path;

    const normalizedPath = finalActionPath.startsWith('/') ? finalActionPath : `/${finalActionPath}`;
    const url = `${this.baseUrl}/v1/passthrough${normalizedPath}`;

    let requestData = data;
    if (typeof requestData === 'string') {
      try { requestData = JSON.parse(requestData); } catch {}
    }

    // Check if action has "custom" tag and add connectionKey to body if needed
    const isCustomAction = action.tags?.includes('custom');
    if (isCustomAction && method?.toLowerCase() !== 'get') {
      requestData = {
        ...requestData,
        connectionKey
      };
    }

    const requestConfig: RequestConfig = {
      url,
      method,
      headers: requestHeaders,
      params: queryParams
    };

    if (method?.toLowerCase() !== 'get') {
      if (isFormData) {
        const formData = new FormData();

        if (requestData && typeof requestData === 'object' && !Array.isArray(requestData)) {
          Object.entries(requestData).forEach(([key, value]) => {
            if (typeof value === 'object') {
              formData.append(key, JSON.stringify(value));
            } else {
              formData.append(key, String(value));
            }
          });
        }

        requestConfig.data = formData;
        Object.assign(requestConfig.headers, formData.getHeaders());
      } else if (isFormUrlEncoded) {
        const params = new URLSearchParams();

        if (requestData && typeof requestData === 'object' && !Array.isArray(requestData)) {
          Object.entries(requestData).forEach(([key, value]) => {
            if (typeof value === 'object') {
              params.append(key, JSON.stringify(value));
            } else {
              params.append(key, String(value));
            }
          });
        }

        requestConfig.data = params;
      } else {
        requestConfig.data = requestData;
      }
    }

    const sanitizedConfig = {
      ...requestConfig,
      headers: {
        ...requestConfig.headers,
        'x-one-secret': '***REDACTED***'
      }
    };

    try {
      const response: AxiosResponse = await axios(requestConfig);

      return {
        requestConfig: sanitizedConfig,
        responseData: response.data
      };
    } catch (error) {
      console.error("Error executing passthrough request:", describeError(error));
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to execute passthrough request: ${error.response?.status} ${error.response?.statusText}`);
      }
      throw new Error("Failed to execute passthrough request");
    }
  }

  /**
   * Gets the base URL for the One API
   * @returns The base URL for the One API
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Gets the current user's connections
   * @returns Array of user connections
   */
  getUserConnections(): Connection[] {
    return [...this.connections];
  }

  /**
   * Gets available connectors/platforms
   * @returns Array of available connection definitions
   */
  getAvailableConnectors(): ConnectionDefinition[] {
    return [...this.connectors];
  }

  /**
   * Checks if the client has been initialized
   */
  isClientInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Refreshes connections and connectors data
   */
  async refresh(): Promise<void> {
    await Promise.allSettled([
      this.fetchConnections(),
      this.fetchConnectionDefinitions(),
    ]);
  }
}