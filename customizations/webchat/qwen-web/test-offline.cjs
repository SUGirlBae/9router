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
test("includes chat_id + incremental when provided", () => {
  const b = buildRequestBody({ model: "qwen3.7-plus", messages: [], chatId: "abc" });
  assert.strictEqual(b.chat_id, "abc");
  assert.strictEqual(b.incremental_output, true);
});
test("anti-bot headers present", () => {
  const h = generateAntiBotHeaders();
  assert(h["x-request-id"]);
  assert(h["bx-v"]);
  assert(h["user-agent"]);
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