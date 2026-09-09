// Smoke test: caller headers can never override One's own x-one-* headers on a
// passthrough call, and a failed call never logs the secret. Run after `npm run build`:
//   node scripts/smoke-passthrough-headers.mjs

import http from "node:http";
import { OneClient } from "../build/client.js";
import { stripReservedHeaders, describeError } from "../build/client.js";

const received = [];
let mode = "ok";
const server = http.createServer((req, res) => {
  received.push({ url: req.url, method: req.method, headers: req.headers });
  if (mode === "fail") { res.writeHead(422, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "upstream said no" })); return; }
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const SECRET = "sk_test_REALSECRET_abc123";
const client = new OneClient(SECRET, base);
const action = { _id: "conn_mod_def::ALLOWED_ACTION", method: "GET", path: "/v1/things", tags: [] };

// 1) An agent tries to smuggle its own x-one-* headers past the allowlist.
await client.executePassthroughRequest({
  actionId: "conn_mod_def::ALLOWED_ACTION",
  connectionKey: "live::allowed::default::aaaa",
  headers: { "x-one-connection-key": "live::EXCLUDED::default::zzzz", "X-One-Secret": "sk_live_stolen", "X-ONE-ACTION-ID": "conn_mod_def::OTHER", "x-custom-trace": "t-1" },
}, action);
const h = received[0].headers;
const checks = [
  ["connection key not overridable", h["x-one-connection-key"] === "live::allowed::default::aaaa"],
  ["secret not overridable", h["x-one-secret"] === SECRET],
  ["action id not overridable", h["x-one-action-id"] === "conn_mod_def::ALLOWED_ACTION"],
  ["custom header still passes through", h["x-custom-trace"] === "t-1"],
  ["default content type kept", h["content-type"] === "application/json"],
];

// 2) Caller may still set Content-Type (existing behaviour).
await client.executePassthroughRequest({ actionId: "a", connectionKey: "live::allowed::default::aaaa", headers: { "Content-Type": "text/plain" } }, action);
checks.push(["caller can still set Content-Type", received[1].headers["content-type"] === "text/plain"]);

// 3) A failed call must not log the secret.
mode = "fail";
const logged = [];
const origErr = console.error; console.error = (...a) => logged.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
let thrown = "";
try { await client.executePassthroughRequest({ actionId: "a", connectionKey: "live::allowed::default::aaaa" }, action); } catch (e) { thrown = e.message; }
console.error = origErr;
const log = logged.join("\n");
checks.push(["stderr log has no secret", !log.includes(SECRET)]);
checks.push(["stderr log still says what failed", log.includes("422") && log.includes("upstream said no")]);
checks.push(["tool error still carries the status", thrown.includes("422")]);

// 4) Helper unit checks.
checks.push(["stripReservedHeaders drops x-one-* case-insensitively", JSON.stringify(stripReservedHeaders({ "X-One-Secret": "a", "x-one-action-id": "b", "Accept": "x" })) === JSON.stringify({ Accept: "x" })]);
checks.push(["describeError redacts non-axios errors safely", describeError(new Error("boom")).message === "boom"]);

server.close();
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? "PASS" : "FAIL") + "  " + name); if (!pass) ok = false; }
console.log("--- sample stderr line ---\n" + log.slice(0, 300));
process.exit(ok ? 0 : 1);
