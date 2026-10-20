/**
 * Tool errors the agent reads and acts on
 *
 * A refusal, a missing argument, or One being unreachable is reported to the
 * agent as an `isError` tool result, which every MCP client shows the model.
 * A protocol error is reserved for a fault in this server itself.
 *
 * @fileoverview The tool-error type and how One API failures become one
 * @author One
 */

import axios from 'axios';

/** A failure the agent can read and correct, returned as an `isError` result rather than a protocol error. */
export class ToolError extends Error {}

/** The `isError` result a ToolError is reported as. */
export function toolErrorResult(error: ToolError) {
  return {
    content: [{ type: "text" as const, text: error.message }],
    isError: true,
  };
}

/** The error body One answers its own refusals with. */
interface OneErrorBody {
  message?: string;
  correlation_id?: string;
}

/**
 * Reports a response One itself refused, with its reason and the reference
 * support can trace it by.
 * @param what - What was being done, e.g. "Failed to execute One action"
 */
export function oneRefusal(what: string, status: number, body: unknown): ToolError {
  const { message, correlation_id } = (body && typeof body === 'object' ? body : {}) as OneErrorBody;
  const reason = message ?? `status ${status}`;
  const reference = correlation_id ? `, reference: ${correlation_id}` : '';
  return new ToolError(`${what}: ${reason} (One answered ${status}${reference}).`);
}

/**
 * Reports a failed call to the One API: One's reason when it answered, or that
 * it did not answer.
 * @param what - What was being done, e.g. "Failed to find actions"
 * @param mayHaveRun - The call could have reached the platform, so a write must be checked before it is tried again
 */
export function oneApiError(what: string, error: unknown, mayHaveRun = false): ToolError {
  if (axios.isAxiosError(error) && error.response) {
    return oneRefusal(what, error.response.status, error.response.data);
  }
  const retry = mayHaveRun
    ? 'If this call changes data, check whether it took effect before trying again; otherwise try again.'
    : 'Try again.';
  return new ToolError(`${what}: One could not be reached. ${retry}`);
}
