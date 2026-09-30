/**
 * The `find_one_actions` tool: find the action for every operation a task
 * needs, across platforms, with its documentation, in one call.
 *
 * Core picks the actions (`POST /v1/available-actions/find`, search plus One's
 * decision model). This module applies what only this server knows - its
 * action allowlist, permission level and connection scope - and renders the
 * answer in the same layout as the remote MCP's tool, documenting each action
 * from its raw knowledge with this package's own digest engine, so a digest's
 * notes name `find_one_actions` rather than a route the agent cannot call.
 *
 * @fileoverview find_one_actions logic, free of HTTP so it can be tested
 * @author One
 */

import { buildKnowledgeResponse, isActionAllowed, isMethodAllowed, platformEnvSegment } from './helpers.js';
import {
  ActionDetails,
  FindIntent,
  FindLoadArgs,
  FindOneActionsArgs,
  FoundAction,
  FoundActions,
  PermissionLevel,
} from './types.js';

/** How many intents one find answers. Core enforces the same cap. */
export const FIND_MAX_INTENTS = 10;

/** How many documents one load returns. */
export const FIND_MAX_LOADS = 10;

/** Characters of documentation one answer carries in all, as core bounds its own (about 100k tokens). */
export const FIND_DOCUMENTS_BUDGET = 400_000;

/** What stands in for an action's documentation when it has none. */
export const NO_KNOWLEDGE = '(No additional knowledge available for this action.)';

/** How an agent that can execute runs what the documentation describes, with this server's real argument names. */
export const FIND_EXECUTE_HINT =
  'Run it with `execute_one_action`: `platform`, `actionId`, `connectionKey` (from `list_one_integrations`), and the `data`, `pathVariables` and `queryParams` this document calls for.';

/** One wording for an action that does not exist and one this server may not use, so neither can be told apart. */
export const REFUSED_LOAD = 'no such action, or this server may not use it';

/** What a call that is neither a find nor a load is told. */
export const FIND_ARGS_ERROR =
  'Send either `requests` (to find actions, with an optional `task`) or `load` (for more documentation, without `task`), not both and not neither.';

/** What the tool needs from the One API. */
export interface FindDeps {
  findActions(requests: FindIntent[], task: string | undefined, knowledgeAgent: boolean): Promise<FoundActions[]>;
  getActionDetails(actionId: string): Promise<ActionDetails>;
}

/** This server's settings that shape an answer. */
export interface FindSettings {
  /** Knowledge mode: documents whole, with how to call each from code, and nothing to execute. */
  knowledgeAgent: boolean;
  permissions: PermissionLevel;
  /** `ONE_ACTION_IDS`; `["*"]` allows every action. */
  actionIds: string[];
  /** The platforms `ONE_CONNECTION_KEYS` reaches, or `null` when every platform is allowed. */
  platforms: string[] | null;
  /** The One API base URL, for the passthrough URL in knowledge mode. */
  baseUrl: string;
}

/** A call the agent has to fix, reported to it rather than failing the server. */
export class FindArgsError extends Error {}

/**
 * Answers a `find_one_actions` call: finds actions for `requests`, or serves
 * more documentation for `load`.
 * @throws {FindArgsError} When the call is neither, both, or `task` comes with `load`
 */
export async function findOneActions(args: FindOneActionsArgs, deps: FindDeps, settings: FindSettings): Promise<string> {
  if (args.requests && !args.load) {
    return find(args.requests, args.task, deps, settings);
  }
  if (args.load && !args.requests && args.task === undefined) {
    return load(args.load, deps, settings);
  }
  throw new FindArgsError(FIND_ARGS_ERROR);
}

/** An action as the agent refers to it: title, method, path and `actionId`. */
export function actionHeading(title: string, method: string, path: string, actionId: string): string {
  return `${title} · \`${method.toUpperCase()} ${path}\` · actionId: \`${actionId}\``;
}

function allows(settings: FindSettings, action: { systemId: string; method: string }): boolean {
  return isActionAllowed(action.systemId, settings.actionIds) && isMethodAllowed(action.method, settings.permissions);
}

function reaches(settings: FindSettings, platform: string | undefined): boolean {
  return settings.platforms === null || (platform !== undefined && settings.platforms.includes(platform));
}

/** An answer narrowed to what this server allows, and what that narrowing did. */
interface Narrowed {
  answer: FoundActions;
  /** The pick was refused and another allowed candidate took its place. */
  replaced: boolean;
  /** Core found actions, but this server's settings refuse every one of them. */
  refusedAll: boolean;
}

/**
 * Drops every action this server's settings refuse. When that removes the
 * pick itself, the runner-up, else the first allowed alternative, takes its
 * place, so the intent still has something to use.
 */
function narrow(answer: FoundActions, settings: FindSettings): Narrowed {
  const allowed = (action: FoundAction) => allows(settings, action);
  const selected = answer.selected.filter(allowed);
  const alternatives = answer.alternatives.filter(allowed);
  let runnerUp = answer.runnerUp && allowed(answer.runnerUp) ? answer.runnerUp : undefined;
  let replaced = false;

  // The model's pick is the first selected action; any after it are needed
  // beside it. A refused pick is replaced even when a companion survives, so a
  // companion is never presented as the confident pick.
  if (answer.selected.length > 0 && !allowed(answer.selected[0])) {
    const next = runnerUp ?? alternatives.shift();
    if (next) {
      selected.unshift(next);
      runnerUp = next === runnerUp ? undefined : runnerUp;
    }
    replaced = selected.length > 0;
  }

  const alsoSelected = (answer.alsoSelected ?? []).filter(allowed);
  const found = answer.selected.length + answer.alternatives.length + (answer.alsoSelected?.length ?? 0) + (answer.runnerUp ? 1 : 0);
  const kept = selected.length + alternatives.length + alsoSelected.length + (runnerUp ? 1 : 0);

  return {
    answer: { ...answer, selected, alsoSelected, runnerUp, alternatives },
    replaced,
    refusedAll: found > 0 && kept === 0,
  };
}

/** Why the answer is what it is, as its opening line. */
function status(answer: FoundActions, narrowed: Pick<Narrowed, 'replaced' | 'refusedAll'>): string {
  if (narrowed.refusedAll) {
    return "Actions were found for this intent, but this server's settings (ONE_ACTION_IDS, ONE_PERMISSIONS) allow none of them, so rephrasing will not help. Tell the user which operation is blocked.";
  }
  if (narrowed.replaced) {
    return 'The chosen action is not allowed on this server, so this is the next allowed candidate: check it fits before using it.';
  }
  if (answer.selector === 'none_fit' || answer.selected.length === 0) {
    return answer.alternatives.length === 0
      ? 'No action fits this intent, and nothing close was found. Rephrase it, or check the platform name.'
      : 'No action fits this intent. Rephrase it more specifically, or load one of the alternatives.';
  }
  if (answer.selector === 'search_order') {
    return 'The decision model was unavailable, so this is the top search result: check it fits before using it.';
  }
  return answer.confidence === undefined
    ? 'Chosen by the decision model.'
    : `Chosen with confidence ${answer.confidence.toFixed(2)}.`;
}

/** Actions listed one per line under `lead`, with how to load any of them, or nothing when there are none. */
function listing(lead: string, actions: FoundAction[]): string[] {
  if (actions.length === 0) return [];
  const listed = actions.map((a) => `- ${actionHeading(a.title, a.method, a.path, a.systemId)}`).join('\n');
  return [`${lead} (load with \`find_one_actions\` and \`load: [{ action_id }]\`):\n${listed}`];
}

/** An action and its raw documentation, to be rendered for the agent. */
interface Documented {
  title: string;
  method: string;
  path: string;
  actionId: string;
  platform: string;
  tags: string[];
  knowledge: string | undefined;
}

/**
 * One action with its documentation: a digest whose notes name
 * `find_one_actions` for an agent that executes, or the whole document with
 * how to call it from code in knowledge mode, whose shared rules the answer
 * adds once.
 */
function renderAction(doc: Documented, settings: FindSettings, request: Omit<FindLoadArgs, 'action_id'> = {}): string {
  if (settings.knowledgeAgent) {
    return codeGuideAction(doc, settings.baseUrl);
  }
  const heading = actionHeading(doc.title, doc.method, doc.path, doc.actionId);
  if (doc.knowledge === undefined) {
    return `### ${heading}\n\n${NO_KNOWLEDGE}`;
  }
  const body = buildKnowledgeResponse(doc.knowledge, doc.method, doc.platform, doc.actionId, {
    section: request.section,
    full: request.full,
    toc: request.toc,
    followUp: 'findTool',
  }).text;
  return `### ${heading}\n\n${body}`;
}

/** The sections joined, ending on what applies to every documented action - once, however many - or on nothing when nothing was documented. */
function finish(sections: string[], documented: boolean, settings: FindSettings): string {
  const body = sections.join('\n\n---\n\n');
  if (!documented) return body;
  return `${body}\n\n---\n\n${settings.knowledgeAgent ? codeGuideRules() : FIND_EXECUTE_HINT}`;
}

/** An intent's answer once this server has narrowed it, with what it documents. */
interface Planned {
  intent: FindIntent;
  unreachable: boolean;
  answer?: FoundActions;
  replaced: boolean;
  refusedAll: boolean;
  /** Picks to document, in order; whole documents are large, so knowledge mode documents the pick alone. */
  picks: FoundAction[];
  /** Picks listed rather than documented. */
  deferred: FoundAction[];
  /** The runner-up, documented unless this server reads documents whole. */
  runnerUp?: FoundAction;
  runnerUpDocumented: boolean;
}

async function find(requests: FindIntent[], task: string | undefined, deps: FindDeps, settings: FindSettings): Promise<string> {
  if (requests.length === 0 || requests.length > FIND_MAX_INTENTS) {
    throw new FindArgsError(`Send between 1 and ${FIND_MAX_INTENTS} requests.`);
  }

  const reachable = requests.filter((r) => reaches(settings, r.platform));
  const answers = reachable.length > 0 ? await deps.findActions(reachable, task, settings.knowledgeAgent) : [];
  let next = 0;

  const plans: Planned[] = requests.map((intent) => {
    if (!reaches(settings, intent.platform)) {
      return { intent, unreachable: true, replaced: false, refusedAll: false, picks: [], deferred: [], runnerUpDocumented: false };
    }
    const { answer, replaced, refusedAll } = narrow(answers[next++], settings);
    const companions = settings.knowledgeAgent ? answer.selected.slice(0, 1) : answer.selected;
    return {
      intent,
      unreachable: false,
      answer,
      replaced,
      refusedAll,
      picks: companions,
      deferred: [...answer.selected.slice(companions.length), ...(answer.alsoSelected ?? [])],
      runnerUp: answer.runnerUp,
      runnerUpDocumented: !settings.knowledgeAgent && answer.runnerUp !== undefined,
    };
  });

  const documents = await fetchDocuments(plans, deps);
  const rendered = boundDocuments(plans, documents, settings);

  const sections = plans.map((plan, index) => {
    if (plan.unreachable || !plan.answer) {
      return `## ${plan.intent.platform}: ${plan.intent.intent}\n\nPlatform "${plan.intent.platform}" has no allowed connections on this server.`;
    }
    const { answer } = plan;
    const parts = [`## ${plan.intent.platform}: ${plan.intent.intent}\n\n${status(answer, plan)}`];
    const shown = rendered[index];
    parts.push(...shown.picks);
    const chosen = shown.picks.length === 0
      ? 'Chosen for this intent, documentation left out to keep the answer small'
      : 'Also chosen for this intent, documentation left out to keep the answer small';
    parts.push(...listing(chosen, shown.deferred));
    if (plan.runnerUp) {
      const lead = 'If the chosen action does not fit, use this one instead: one or the other, never both';
      parts.push(...(shown.runnerUp ? [`${lead}.\n\n${shown.runnerUp}`] : listing(lead, [plan.runnerUp])));
    }
    parts.push(...listing('Alternatives, not documented', answer.alternatives));
    return parts.join('\n\n');
  });

  return finish(sections, rendered.some((r) => r.picks.length > 0 || r.runnerUp !== undefined), settings);
}

/** Each documented action's raw knowledge, fetched once per action. */
async function fetchDocuments(plans: Planned[], deps: FindDeps): Promise<Map<string, string | undefined>> {
  const ids = new Set<string>();
  for (const plan of plans) {
    plan.picks.forEach((a) => ids.add(a.systemId));
    if (plan.runnerUp && plan.runnerUpDocumented) ids.add(plan.runnerUp.systemId);
  }
  const entries = await Promise.all(
    [...ids].map(async (id) => {
      try {
        return [id, (await deps.getActionDetails(id)).knowledge] as const;
      } catch {
        return [id, undefined] as const;
      }
    })
  );
  return new Map(entries);
}

/** What one intent shows once the answer's size is bounded. */
interface Rendered {
  picks: string[];
  deferred: FoundAction[];
  runnerUp?: string;
}

/**
 * Renders the documented actions within {@link FIND_DOCUMENTS_BUDGET}, picks
 * before any runner-up. The first document is always served. Past the budget,
 * an intent stops at its first pick that does not fit, listing it and the rest
 * as chosen to load, rather than documenting a smaller one in its place; a
 * runner-up that does not fit is listed.
 */
function boundDocuments(plans: Planned[], documents: Map<string, string | undefined>, settings: FindSettings): Rendered[] {
  let used = 0;
  let first = true;
  const admit = (text: string) => {
    if (first || used + text.length <= FIND_DOCUMENTS_BUDGET) {
      used += text.length;
      first = false;
      return true;
    }
    return false;
  };
  const toDocumented = (action: FoundAction, platform: string): Documented => ({
    title: action.title,
    method: action.method,
    path: action.path,
    actionId: action.systemId,
    platform,
    tags: action.tags ?? [],
    knowledge: documents.get(action.systemId),
  });

  const rendered: Rendered[] = plans.map((plan) => {
    const picks: string[] = [];
    const deferred: FoundAction[] = [];
    for (const [index, pick] of plan.picks.entries()) {
      const text = renderAction(toDocumented(pick, plan.intent.platform), settings);
      if (!admit(text)) {
        deferred.push(...plan.picks.slice(index));
        break;
      }
      picks.push(text);
    }
    return { picks, deferred: [...deferred, ...plan.deferred] };
  });

  plans.forEach((plan, index) => {
    if (plan.runnerUp && plan.runnerUpDocumented) {
      const text = renderAction(toDocumented(plan.runnerUp, plan.intent.platform), settings);
      if (used + text.length <= FIND_DOCUMENTS_BUDGET) {
        used += text.length;
        rendered[index].runnerUp = text;
      }
    }
  });

  return rendered;
}

async function load(loads: FindLoadArgs[], deps: FindDeps, settings: FindSettings): Promise<string> {
  if (loads.length === 0 || loads.length > FIND_MAX_LOADS) {
    throw new FindArgsError(`Send between 1 and ${FIND_MAX_LOADS} loads.`);
  }

  const entries = await Promise.all(
    loads.map(async (entry): Promise<{ text: string; documented: boolean }> => {
      const refused = { text: `\`${entry.action_id}\`: ${REFUSED_LOAD}`, documented: false };
      if (!isActionAllowed(entry.action_id, settings.actionIds)) return refused;
      let details: ActionDetails;
      try {
        details = await deps.getActionDetails(entry.action_id);
      } catch {
        return refused;
      }
      if (!isMethodAllowed(details.method, settings.permissions) || !reaches(settings, details.connectionPlatform)) {
        return refused;
      }
      const text = renderAction(
        {
          title: details.title,
          method: details.method,
          path: details.path,
          actionId: entry.action_id,
          platform: details.connectionPlatform ?? '',
          tags: details.tags ?? [],
          knowledge: details.knowledge,
        },
        settings,
        entry
      );
      return { text, documented: true };
    })
  );

  let used = 0;
  let served = false;
  const bounded = entries.map((entry, index) => {
    if (!entry.documented) return entry;
    if (served && used + entry.text.length > FIND_DOCUMENTS_BUDGET) {
      return { text: `\`${loads[index].action_id}\`: too large to serve beside the others; load it on its own.`, documented: false };
    }
    used += entry.text.length;
    served = true;
    return entry;
  });

  return finish(bounded.map((e) => e.text), bounded.some((e) => e.documented), settings);
}

const CUSTOM_ACTION_NOTE =
  '\n\nThis is a custom action: ALSO include "connectionKey" (the same value as the x-one-connection-key header) as a field in the JSON body for non-GET requests.';

/**
 * One action for knowledge mode: its whole document under its heading, then
 * how to call it through the One Passthrough API. {@link codeGuideRules}
 * holds what every action shares, so an answer about several states it once.
 * Worded as the remote MCP's `code_guide_action`.
 */
export function codeGuideAction(doc: Documented, baseUrl: string): string {
  const apiBase = baseUrl.replace(/\/$/, '');
  const method = doc.method.toUpperCase();
  const path = doc.path.startsWith('/') ? doc.path : `/${doc.path}`;
  const connEnv = `ONE_${platformEnvSegment(doc.platform)}_CONNECTION_KEY`;
  const customNote = doc.tags.includes('custom') ? CUSTOM_ACTION_NOTE : '';

  return `### ${actionHeading(doc.title, doc.method, doc.path, doc.actionId)}
**Platform:** ${doc.platform}

${doc.knowledge ?? NO_KNOWLEDGE}

## Calling this action from code
URL:    ${apiBase}/v1/passthrough${path}
Method: ${method}
Headers:
- x-one-secret: the value of the ONE_SECRET env var
- x-one-connection-key: the value of the ${connEnv} env var
- x-one-action-id: ${doc.actionId}
- Content-Type: application/json${customNote}

Environment variables: ONE_SECRET (their One API key) and ${connEnv} (the key of their ${doc.platform} connection), both from the One dashboard.

\`\`\`typescript
const response = await fetch("${apiBase}/v1/passthrough${path}", {
method: "${method}",
headers: {
"x-one-secret": process.env.ONE_SECRET,
"x-one-connection-key": process.env.${connEnv},
"x-one-action-id": "${doc.actionId}",
"Content-Type": "application/json",
},
// body: JSON.stringify(...) - only for non-GET requests
});
\`\`\``;
}

/**
 * The Integration Code Guide's rules, which hold for every action: where the
 * code lives, that it goes through the One Passthrough API, where each
 * parameter goes, the deployment the user must do, and how to write it.
 * Worded as the remote MCP's `code_guide_rules`.
 */
export function codeGuideRules(): string {
  return `================================================================
INTEGRATION CODE GUIDE - using these actions in an application
================================================================
You are in knowledge mode: actions cannot be executed here. Use this
guide, with each action's "Calling this action from code", to write
integration code in the user's project.

## 1. Where this code must live
Server-side only - an API route, edge function, or backend handler
(e.g. Supabase Edge Function, Next.js route handler, Express route).
NEVER call this API from browser/client code and NEVER hardcode secret
values in source - read them from environment variables.

## 2. The request
All calls go through the One Passthrough API. Do NOT call the third-party
API URL from the documentation directly. The URL is the One base plus the
action path ONLY:
✅ {One base}/v1/passthrough{action path}   (the path starts with /)
❌ {One base}/v1/passthrough/https://some-vendor-api.com{action path}

## 3. Parameter placement
Per each action's documentation:
- Path variables (placeholders like {{userId}} in the path) → substitute
  real values into the URL path; never send them in the body.
- Query parameters → the URL query string, not the body.
- Body fields → the JSON request body (POST/PUT/PATCH only).

## 4. Environment variables & deployment
The code will not work until the user sets each action's environment
variables in their hosting platform's secrets manager (Supabase secrets,
Vercel/Netlify environment settings, or the project's env settings -
never committed to code). When you deliver the code, explicitly tell the
user to set them.

## 5. Code generation rules
- Use TypeScript unless the user asked for another language.
- Include the complete input/output structure from the documentation
  (required/optional fields, types) in the implementation.
- Handle errors: on a non-2xx response, read the response body and
  surface a useful message.`;
}
