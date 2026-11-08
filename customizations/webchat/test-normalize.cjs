/**
 * Offline test: normalizeSSE against the REAL captured Qwen SSE (fixtures/qwen-real.sse).
 * Asserts visible text extracted (phase=answer), thinking_summary excluded, [DONE] emitted.
 * Usage: node test-normalize.cjs ; exit 0 = green. No quota.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
// normalizeSSE is not exported; re-import executor and reach it via a browser-transport execute?
// Instead export it for testing: require executor and use createWebchatExecutor with a stub that calls normalize indirectly.
// Simpler: read executor source and eval normalizeSSE in a sandbox is fragile; export it properly.
const { normalizeSSE } = require("./executor.cjs");

const raw = fs.readFileSync(path.join(__dirname, "fixtures", "qwen-real.sse"), "utf8");
let passed = 0, failed = 0;
const t = (n, fn) => { try { fn(); passed++; console.log("  ✓ " + n); } catch (e) { failed++; console.log("  ✗ " + n + ": " + e.message); } };

const res = normalizeSSE(raw, "qwen-web");

(async () => {
  const out = await res.text();
  t("emits OpenAI chunk", () => assert(out.includes('"object":"chat.completion.chunk"')));
  t("extracts visible answer text", () => assert(out.includes("Hello! How can") && out.includes("I help you today")));
  t("excludes thinking_summary leakage", () => assert(!out.includes("I am analyzing your input")));
  t("ends with DONE", () => assert(out.includes("data: [DONE]")));
  t("no raw response.created metadata", () => assert(!out.includes("response.created")));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();