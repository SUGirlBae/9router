/**
 * Qwen Web Offline Test Suite - runs against fake server, no quota consumed
 * Usage: node test-offline.cjs
 * Exit code 0 = all green; non-zero = failure (do NOT push until green)
 */
"use strict";
const assert = require("assert");
const { parseSSEChunk } = require("./sse.cjs");
const { mapError, isRetryable, needsTokenRefresh } = require("./error.cjs");
const { buildRequestBody, generateAntiBotHeaders } = require("./client.cjs");
const { validateToken } = require("./auth.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log("== SSE parser tests ==");
test("parses delta content", () => {
  const ev = parseSSEChunk('data: {"choices":[{"delta":{"content":"Hi"}}]}');
  assert.strictEqual(ev[0].type, "delta");
  assert.strictEqual(ev[0].content, "Hi");
});
test("parses DONE", () => {
  const ev = parseSSEChunk("data: [DONE]");
  assert.strictEqual(ev[0].type, "done");
});
test("parses hint error", () => {
  const ev = parseSSEChunk('data: {"type":"hint","hint":{"type":"error","message":"backend_busy"}}');
  assert.strictEqual(ev[0].type, "hint");
});
test("handles empty chunk", () => {
  const ev = parseSSEChunk("");
  assert.strictEqual(ev.length, 0);
});

console.log("== Error mapper tests ==");
test("maps 401 to stale_token", () => {
  const m = mapError({ status: 401, body: '{"message":"expired"}' });
  assert.strictEqual(m.error.code, "stale_token");
  assert(needsTokenRefresh(m));
});
test("maps 503 to backend_busy + retryable", () => {
  const m = mapError({ status: 503, body: "backend_busy" });
  assert.strictEqual(m.error.code, "backend_busy");
  assert(isRetryable(m));
});
test("maps 429 to rate_limit + retryable", () => {
  const m = mapError({ status: 429, body: "" });
  assert.strictEqual(m.error.code, "rate_limit");
  assert(isRetryable(m));
});
test("maps AbortError to timeout", () => {
  const m = mapError({ name: "AbortError" });
  assert.strictEqual(m.error.code, "timeout");
});

console.log("== Request builder tests ==");
test("strips model suffixes", () => {
  const b = buildRequestBody({ model: "qwen3.7-plus(high)[1m]", messages: [{ role: "user", content: "hi" }] });
  assert.strictEqual(b.model, "qwen3.7-plus");
});
test("emits the captured 0.3.42 envelope (stream/version/incremental/chat_id/chat_mode)", () => {
  const b = buildRequestBody({ model: "qwen3.7-plus", messages: [{ role: "user", content: "hi" }], chatId: "abc", now: 1794683996 });
  assert.strictEqual(b.stream, true);
  assert.strictEqual(b.version, "2.1");
  assert.strictEqual(b.incremental_output, true);
  assert.strictEqual(b.chat_id, "abc");
  assert.strictEqual(b.chatId, "abc");
  assert.strictEqual(b.parentId, "");
  assert.strictEqual(b.chat_mode, "normal");
  assert.strictEqual(b.timestamp, 1794683996);
  const m = b.messages[0];
  assert.strictEqual(m.role, "user");
  assert.strictEqual(m.chat_type, "t2t");
  assert.strictEqual(m.sub_chat_type, "t2t");
  assert.strictEqual(m.user_action, "chat");
  assert.deepStrictEqual(m.models, ["qwen3.7-plus"]);
  assert.ok(Array.isArray(m.childrenIds) && m.childrenIds.length === 1);
  assert.strictEqual(m.feature_config.output_schema, "phase");
  assert.strictEqual(m.feature_config.thinking_format, "summary");
  assert.deepStrictEqual(m.extra, { meta: { subChatType: "t2t" } });
});
test("thinking/search flags land in feature_config", () => {
  const b = buildRequestBody({ model: "qwen3.7-plus", messages: [{ role: "user", content: "x" }], thinkingEnabled: true, searchEnabled: true });
  assert.strictEqual(b.messages[0].feature_config.thinking_enabled, true);
  assert.strictEqual(b.messages[0].feature_config.auto_search, true);
});
test("anti-bot headers match the captured desktop request set", () => {
  const h = generateAntiBotHeaders();
  assert.strictEqual(h["X-Request-Id"].length, 36);
  assert.strictEqual(h["bx-v"], "2.5.37");
  assert.strictEqual(h.Version, "0.3.42");
  assert.strictEqual(h.source, "desktop");
  assert.strictEqual(h.Accept, "application/json");
  assert.match(h["User-Agent"], /AliDesktop\(QWENCHAT\/1\.0\.3\)$/);
  assert.match(h["sec-ch-ua"], /"Chromium";v="134"/);
  assert.ok(h.Timezone);
});

console.log("== Token validation tests ==");
test("rejects logged-out placeholder", () => {
  assert.strictEqual(validateToken('{"value":null,"__version":"0"}'), false);
});
test("rejects short token", () => {
  assert.strictEqual(validateToken("short"), false);
});
test("accepts valid long token", () => {
  assert.strictEqual(validateToken("a".repeat(30)), true);
});
test("accepts object with valid value", () => {
  assert.strictEqual(validateToken('{"value":"' + "a".repeat(30) + '"}'), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);