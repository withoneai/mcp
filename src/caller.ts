/**
 * How a find names who asked, for One's record of what agents ask
 * `find_one_actions` (pica-v2 #993).
 *
 * `x-one-source: cli` says the call came through One's own local tooling
 * rather than a script holding the same key; this server reaches One through
 * the same door as the CLI, and `cli` is the only surface core lets a client
 * claim. `x-one-agent` names the MCP client that connected, as its
 * `clientInfo` gave it (`claude-code/2.4.1`), and `x-one-agent-model` the model
 * the agent says it is running as, which only the agent knows. All three are
 * declared, never authenticated, and core drops a value it cannot read rather
 * than refusing the find, so a wrong one can never break it.
 */
export const CALLER_SOURCE_HEADER = 'x-one-source';
export const CALLER_AGENT_HEADER = 'x-one-agent';
export const CALLER_MODEL_HEADER = 'x-one-agent-model';

/** Who asked for a find: the MCP client that connected and the model it named. */
export interface FindCaller {
  client?: { name: string; version?: string };
  model?: string;
}

export function callerHeaders(caller: FindCaller = {}): Record<string, string> {
  const headers: Record<string, string> = { [CALLER_SOURCE_HEADER]: 'cli' };
  const name = caller.client?.name?.trim();
  if (name) {
    const version = caller.client?.version?.trim();
    headers[CALLER_AGENT_HEADER] = version ? `${name}/${version}` : name;
  }
  const model = caller.model?.trim();
  if (model) headers[CALLER_MODEL_HEADER] = model;
  return headers;
}
