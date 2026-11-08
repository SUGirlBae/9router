/**
 * Kimi Web Offline Tests - unit + integration against inline fake server (kimi event format).
 * Usage: node test-offline.cjs ; exit 0 = green. No quota consumed.
 */
"use strict";
const assert = require("assert");
const http = require("http");
const { parseSSEChunk, streamCompletion } = require("./sse.cjs");
const { mapError, isRetryable, needsTokenRefresh } = require("./error.cjs");
const { buildRequestBody, generateHeaders } = require("./client.cjs");
const { validateToken } = require("./auth.js");

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); } }

console.log("== Kimi SSE parser ==");
test("cmpl event -> delta", () => { const e = parseSSEChunk('data: {"event":"cmpl","text":"Hi"}'); assert.strictEqual(e[0].type, "delta"); assert.strictEqual(e[0].content, "Hi"); });
test("all_done -> done", () => { const e = parseSSEChunk('data: {"event":"all_done"}'); assert.strictEqual(e[0].type, "done"); });
test("error event -> hint", () => { const e = parseSSEChunk('data: {"event":"error","message":"busy"}'); assert.strictEqual(e[0].type, "hint"); });
test("openai-style delta tolerated", () => { const e = parseSSEChunk('data: {"choices":[{"delta":{"content":"X"}}]}'); assert.strictEqual(e[0].content, "X"); });
test("[DONE] tolerated", () => { assert.strictEqual(parseSSEChunk("data: [DONE]")[0].type, "done"); });

console.log("== Error mapper ==");
test("401 stale_token + refresh", () => { const m = mapError({ status: 401, body: "" }); assert.strictEqual(m.error.code, "stale_token"); assert(needsTokenRefresh(m)); });
test("403 permission_denied not retryable", () => { const m = mapError({ status: 403, body: '{"message":"paid tier"}' }); assert.strictEqual(m.error.code, "permission_denied"); assert(!isRetryable(m)); });
test("429 retryable", () => { assert(isRetryable(mapError({ status: 429, body: "" }))); });
test("503 backend_busy retryable", () => { assert(isRetryable(mapError({ status: 503, body: "" }))); });

console.log("== Request builder ==");
test("endpoint body has refs+history+prompt", () => { const b = buildRequestBody({ messages: [{ role: "user", content: "hi" }], chatId: "new" }); assert(b.refs && b.history && b.prompt === "hi"); });
test("headers carry bearer + request id", () => { const h = generateHeaders("tok"); assert.strictEqual(h.authorization, "Bearer tok"); assert(h["x-request-id"]); });
test("token validation rejects short", () => { assert.strictEqual(validateToken("short"), false); });
test("token validation accepts long", () => { assert.strictEqual(validateToken("a".repeat(40)), true); });

// Integration: fake kimi server
const PORT = 8902;
const server = http.createServer((req, res) => {
  if (!/\/api\/chat\/.+\/completion\/stream/.test(req.url)) { res.writeHead(404); return res.end(); }
  const sc = req.headers["x-fake-scenario"] || "success";
  let body = ""; req.on("data", c => body += c);
  req.on("end", () => {
    if (sc === "stale") { res.writeHead(401, { "Content-Type": "application/json" }); return res.end('{"message":"expired"}'); }
    if (sc === "busy") { res.writeHead(503, { "Content-Type": "application/json" }); return res.end('{"message":"busy"}'); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (sc === "empty") return res.end('data: {"event":"all_done"}\n\n');
    res.write('data: {"event":"cmpl","text":"A"}\n\n');
    res.write('data: {"event":"cmpl","text":"B"}\n\n');
    res.end('data: {"event":"all_done"}\n\n');
  });
});

server.listen(PORT, async () => {
  console.log("== Integration (fake kimi server) ==");
  const base = `http://localhost:${PORT}`;
  async function probe(scenario) {
    const r = await fetch(`${base}/api/chat/new/completion/stream`, { method: "POST", headers: { "x-fake-scenario": scenario, "content-type": "application/json" }, body: "{}" });
    return r;
  }
  try {
    const r = await probe("success");
    let deltas = 0, done = false;
    for await (const ev of streamCompletion(r)) { if (ev.type === "delta") deltas++; if (ev.type === "done") done = true; }
    assert(deltas === 2 && done); passed++; console.log("  ✓ stream success 2 deltas + done");
    const r401 = await probe("stale");
    const m = mapError({ status: r401.status, body: await r401.text() });
    assert(needsTokenRefresh(m)); passed++; console.log("  ✓ 401 refresh path");
    const r503 = await probe("busy");
    assert(isRetryable(mapError({ status: r503.status, body: await r503.text() }))); passed++; console.log("  ✓ 503 retry path");
    const re = await probe("empty");
    let d2 = false; for await (const ev of streamCompletion(re)) if (ev.type === "done") d2 = true;
    assert(d2); passed++; console.log("  ✓ empty stream done");
  } catch (e) { failed++; console.log("  ✗ integration: " + e.message); }
  console.log(`\n${passed} passed, ${failed} failed`);
  server.closeAllConnections(); server.close(() => { process.exitCode = failed > 0 ? 1 : 0; }); server.unref();
});