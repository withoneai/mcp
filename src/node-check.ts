/**
 * Node.js TLS guard
 *
 * Eight eMudhra/emSign intermediate CAs were created with 8-bit private keys
 * (October 2026, RUSTSEC-2026-0381), so anyone can compute them and sign a
 * certificate for any domain, including api.withone.ai. Node.js blocks them
 * inside the TLS handshake from 22.23.4, 24.22.1 and 26.12.1
 * (nodejs/node#66871). On any older Node, a network attacker can intercept
 * this server's traffic and the ONE_SECRET it sends.
 *
 * An MCP server that exits at startup only shows up as "failed to start" in
 * the client, so on an unpatched Node the server still starts but every tool
 * returns this refusal, before any request, for the agent to pass on.
 *
 * @fileoverview Refuses to call One from a Node without the eMudhra fix
 * @author One
 */

/** The first patch of each Node line that ships the blocklist. Odd lines (23, 25) are end-of-life and never got it. */
const FIXED_IN: Readonly<Record<number, readonly [number, number]>> = {
  22: [23, 4],
  24: [22, 1],
  26: [12, 1],
};

/** The first Node line released after the fix, so it has it from .0. */
const FIRST_LINE_WITH_FIX = 27;

/** The line to move to from a Node line that never got the fix. */
const RECOMMENDED_LINE = 24;

export const REQUIRED_NODE = '22.23.4+, 24.22.1+ or 26.12.1+';

/** Set to 1 to call One from an unpatched Node anyway. */
export const ALLOW_UNPATCHED_ENV = 'ONE_ALLOW_UNPATCHED_NODE';

function parseVersion(version: string): [number, number, number] {
  const [major, minor, patch] = version.split('.').map((part) => Number.parseInt(part, 10));
  return [major, minor, patch ?? 0];
}

/** True when this Node version rejects chains through the compromised eMudhra intermediates. */
export function nodeHasTlsFix(version: string = process.versions.node): boolean {
  const [major, minor, patch] = parseVersion(version);
  if (!Number.isFinite(major)) return false;
  if (major >= FIRST_LINE_WITH_FIX) return true;
  const fixed = FIXED_IN[major];
  if (!fixed) return false;
  const [fixedMinor, fixedPatch] = fixed;
  return minor > fixedMinor || (minor === fixedMinor && patch >= fixedPatch);
}

/**
 * The command that updates Node for however it was installed, judged from the
 * path of the running binary. A line that got the fix stays on its line; any
 * other moves to the recommended one.
 */
export function upgradeCommand(
  version: string = process.versions.node,
  execPath: string = process.execPath,
): string {
  const [major] = parseVersion(version);
  const line = FIXED_IN[major] ? major : RECOMMENDED_LINE;
  const path = execPath.replace(/\\/g, '/');

  if (/\/\.nvm\/versions\/node\//.test(path)) return `nvm install ${line} && nvm alias default ${line}`;
  if (/\/AppData\/(Roaming|Local)\/nvm\//i.test(path)) return `nvm install ${line} && nvm use ${line}`;
  if (/\/\.?volta\//i.test(path)) return `volta install node@${line}`;
  if (/fnm/i.test(path)) return `fnm install ${line} && fnm default ${line}`;
  const brew = path.match(/\/Cellar\/(node(?:@\d+)?)\//);
  if (brew) {
    const formula = brew[1] === 'node' || FIXED_IN[major] ? brew[1] : `node@${line}`;
    return formula === brew[1] ? `brew upgrade ${formula}` : `brew install ${formula}`;
  }
  return `download Node.js ${line} from https://nodejs.org`;
}

/**
 * What every tool answers on an unpatched Node, or null when it may call One:
 * the Node has the fix, or ONE_ALLOW_UNPATCHED_NODE=1.
 */
export function unpatchedNodeRefusal(
  version: string = process.versions.node,
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (nodeHasTlsFix(version) || env[ALLOW_UNPATCHED_ENV] === '1') return null;
  return (
    `The One MCP server is running on Node.js v${version}, which trusts the compromised eMudhra ` +
    `certificates, so a network attacker could intercept its traffic and the user's One API key. ` +
    `It will not call One until Node.js is updated to ${REQUIRED_NODE} (Node 18, 20, 23 and 25 never got the fix). ` +
    `Don't retry: ask the user to run \`${upgradeCommand(version, execPath)}\`, then restart their MCP client.`
  );
}
