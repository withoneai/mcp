/**
 * Approval for actions that change data (`ONE_APPROVAL`).
 *
 * With approval on, `execute_one_action` asks the user before it runs a write
 * or delete, through MCP elicitation: the protocol's way for a server to ask
 * the person at the client a question. An agent that has just read
 * third-party content (an email, a web page) can be steered by it, so the
 * person, not the agent, decides whether a change goes ahead. A client that
 * cannot ask is refused rather than run unapproved.
 *
 * @fileoverview When an action needs approval, and how it is asked for
 * @author One
 */

import { ToolError } from './tool-error.js';

/** What `ONE_APPROVAL` asks approval for: nothing, deletes, or writes and deletes. */
export type ApprovalLevel = 'off' | 'delete' | 'write';

export const APPROVAL_LEVELS: readonly ApprovalLevel[] = ['off', 'delete', 'write'];

/** How long the user has to answer before the action is refused. */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** How much of the request the prompt shows. */
export const APPROVAL_REQUEST_CHARS = 2_000;

/**
 * Whether an action at `access` needs approval at `level`. An action with no
 * level, or one this server does not know, is treated as a delete, since
 * nothing says it is safer.
 */
export function needsApproval(access: string | null | undefined, level: ApprovalLevel): boolean {
  if (level === 'off') return false;
  if (level === 'delete') return access !== 'read' && access !== 'write';
  return access !== 'read';
}

/**
 * Whether the client can show a form prompt. Per the spec, an `elicitation`
 * capability naming neither mode means form, as clients declared it before
 * modes existed.
 */
export function supportsFormElicitation(capabilities: { elicitation?: { form?: object; url?: object } } | undefined): boolean {
  const elicitation = capabilities?.elicitation;
  if (!elicitation) return false;
  return elicitation.form !== undefined || elicitation.url === undefined;
}

/** The action and request the user is asked to approve. */
export interface ApprovalRequest {
  actionId: string;
  title: string;
  method: string;
  path: string;
  platform: string;
  connectionKey: string;
  access: string | null | undefined;
  pathVariables?: unknown;
  queryParams?: unknown;
  data?: unknown;
}

/** The form the user answers: one box to tick. */
export const APPROVAL_SCHEMA = {
  type: 'object',
  properties: {
    approve: {
      type: 'boolean',
      title: 'Run this action',
      description: 'Tick to run it now. Leave it unticked, decline or dismiss to stop it.',
      default: false,
    },
  },
  required: ['approve'],
} as const;

/** What the user reads: what will run, where, and with what. */
export function approvalMessage(request: ApprovalRequest): string {
  const kind = request.access === 'read' || request.access === 'write' || request.access === 'delete' ? request.access : 'unclassified';
  const sent: Record<string, unknown> = {};
  if (request.pathVariables !== undefined) sent.pathVariables = request.pathVariables;
  if (request.queryParams !== undefined) sent.queryParams = request.queryParams;
  if (request.data !== undefined) sent.data = request.data;

  let body = Object.keys(sent).length > 0 ? JSON.stringify(sent, null, 2) : '(no parameters)';
  if (body.length > APPROVAL_REQUEST_CHARS) {
    body = `${body.slice(0, APPROVAL_REQUEST_CHARS)}\n… (${body.length - APPROVAL_REQUEST_CHARS} more characters not shown)`;
  }

  return [
    `Your AI agent wants to run ${kind === 'unclassified' ? 'an' : 'a'} ${kind} action on ${request.platform}.`,
    '',
    `${request.title}`,
    `${request.method.toUpperCase()} ${request.path}`,
    `Connection: ${request.connectionKey}`,
    '',
    'Request:',
    body,
  ].join('\n');
}

/** The client's answer, as MCP elicitation returns it. */
export interface ElicitAnswer {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

/** What approval needs from the MCP session. */
export interface ApprovalDeps {
  capabilities: { elicitation?: { form?: object; url?: object } } | undefined;
  elicit(params: { message: string; requestedSchema: typeof APPROVAL_SCHEMA }): Promise<ElicitAnswer>;
}

/**
 * Asks the user to approve `request` when `level` calls for it, and returns
 * only once they have. Anything short of an explicit approval refuses.
 * @throws {ToolError} When the user did not approve, or could not be asked
 */
export async function requireApproval(request: ApprovalRequest, level: ApprovalLevel, deps: ApprovalDeps): Promise<void> {
  if (!needsApproval(request.access, level)) return;

  if (!supportsFormElicitation(deps.capabilities)) {
    throw new ToolError(
      `Action "${request.actionId}" was not run: this server asks the user to approve actions like it, and this MCP client cannot show an approval prompt. Tell the user the action needs their approval and their client does not support approval prompts.`
    );
  }

  let answer: ElicitAnswer;
  try {
    answer = await deps.elicit({ message: approvalMessage(request), requestedSchema: APPROVAL_SCHEMA });
  } catch (error) {
    throw new ToolError(
      `Action "${request.actionId}" was not run: the approval prompt failed or was not answered in time (${error instanceof Error ? error.message : 'unknown error'}). Ask the user whether to try again.`
    );
  }

  if (answer.action === 'accept' && answer.content?.approve === true) return;

  if (answer.action === 'decline' || answer.action === 'accept') {
    throw new ToolError(
      `Action "${request.actionId}" was not run: the user did not approve it. Do not run it again unless the user asks you to.`
    );
  }
  throw new ToolError(
    `Action "${request.actionId}" was not run: the user dismissed the approval prompt. Do not run it again unless the user asks you to.`
  );
}
