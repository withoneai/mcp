import assert from "node:assert/strict";
import { buildKnowledgeModeGuidance, platformEnvSegment } from "../build/helpers.js";

const details = {
  _id: "conn_mod_def::TEST::abc",
  title: "Send a User's Draft Email",
  tags: [],
  knowledge: "# Send a User's Draft Email\n\nDocs body here.",
  path: "gmail/v1/users/{{userId}}/drafts/send",
  method: "POST",
  connectionPlatform: "gmail",
};

const text = buildKnowledgeModeGuidance(details, "gmail", "https://api.withone.ai/");

assert.ok(text.startsWith("# Send a User's Draft Email"), "knowledge document comes first");
assert.ok(text.includes("INTEGRATION CODE GUIDE"), "guide section present");
assert.ok(
  text.includes("https://api.withone.ai/v1/passthrough/gmail/v1/users/{{userId}}/drafts/send"),
  "passthrough URL uses trimmed base + leading-slash path"
);
assert.ok(text.includes("Method: POST"), "method rendered");
assert.ok(text.includes("ONE_SECRET"), "secret env var referenced");
assert.ok(text.includes("ONE_GMAIL_CONNECTION_KEY"), "connection env var referenced");
assert.ok(text.includes("conn_mod_def::TEST::abc"), "action id rendered");
assert.ok(!text.includes('"connectionKey"'), "no custom note for non-custom actions");

const custom = buildKnowledgeModeGuidance(
  { ...details, tags: ["custom"] },
  "gmail",
  "https://api.withone.ai"
);
assert.ok(custom.includes('"connectionKey"'), "custom actions get the connectionKey-in-body note");

const bare = buildKnowledgeModeGuidance(
  { ...details, knowledge: undefined },
  "gmail",
  "https://api.withone.ai"
);
assert.ok(bare.startsWith("No knowledge was found"), "missing knowledge keeps the existing fallback text");

assert.equal(platformEnvSegment("ship-station"), "SHIP_STATION");
assert.equal(platformEnvSegment("gmail"), "GMAIL");

console.log("smoke-knowledge-guidance: PASS");
