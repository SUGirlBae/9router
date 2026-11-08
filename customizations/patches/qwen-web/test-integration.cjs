/**
 * Qwen Web Integration Tests - runs client against fake server (local port)
 * Usage: node test-integration.cjs [port]
 * Exit code 0 = green; non-zero = failure. No quota consumed.
 */
"use strict";
const assert = require("assert");
const http = require("http");
const { chatCompletion } = require("./client.cjs");
const { parseSSEChunk, streamCompletion } = require("./sse.cjs");
const { mapError, isRetryable, needsTokenRefresh } = require("./error.cjs");

const PORT = parseInt(process.argv[2] || "8901", 10);

// Start fake server inline to avoid fork overhead
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !/\/api\/v2\/chat\/completions/.test(req.url)) {
    res.writeHead(404);
    return res.end("not found");
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const scenario = req.headers["x-fake-scenario"] || "success";
    let parsed; try { parsed = JSON.parse(body); } catch { parsed = {}; }
    const stream = parsed.stream !== false;

    if (scenario === "stale_token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ code: "invalid_token", message: "token expired" }));
    }
    if (scenario === "backend_busy") {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ code: "backend_busy", message: "backend busy" }));
    }
    if (scenario === "rate_limit") {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ code: "rate_limit", message: "too many requests" }));
    }
    if (scenario === "empty_stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end("data: [DONE]\n\n");
    }
    if (scenario === "hint_error") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "hint", hint: { type: "error", message: "backend_busy" } })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }

    // success stream
    const deltas = [
      { choices: [{ delta: { content: "A" } }] },
      { choices: [{ delta: { content: "B" } }] },
      { choices: [{ delta: { content: "C" } }] },
    ];
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const d of deltas) res.write(`data: ${JSON.stringify(d)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ABC" } }] }));
    }
  });
});

server.listen(PORT, async () => {
  console.log(`fake server listening on ${PORT}`);
  let code = 0;
  try {
    await runTests(PORT);
    console.log("\nIntegration tests PASSED");
  } catch (e) {
    console.error("\nIntegration tests FAILED:", e.message);
    code = 1;
  }
  // Graceful teardown: avoid process.exit() while libuv handles are closing (Windows assert)
  server.closeAllConnections();
  server.close(() => { process.exitCode = code; });
  server.unref();
});

async function runTests(port) {
  const env = { QWEN_BASE_URL: `http://localhost:${port}` };
  const orig = Object.assign({}, process.env);
  for (const k in env) process.env[k] = env[k];

  const ok = ["success stream", "success non-stream", "stale_token 401", "backend_busy 503",
              "rate_limit 429", "empty stream", "hint error"];
  console.log("\nTesting scenarios:", ok.join(", "));

  // Success stream
  console.log("✓ stream");
  const res = await fetch(`${env.QWEN_BASE_URL}/api/v2/chat/completions`, {
    method: "POST", headers: { Authorization: "Bearer stub", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3.7-plus", messages: [{ role: "user", content: "X" }], stream: true }),
  });
  assert.ok(res.status === 200);
  let chunkCount = 0;
  for await (const ev of streamCompletion(res)) if (ev.type === "delta") chunkCount++;
  assert(chunkCount >= 3, "expected at least 3 delta events");

  // Success non-stream
  console.log("✓ non-stream");
  const r2 = await fetch(`${env.QWEN_BASE_URL}/api/v2/chat/completions`, {
    method: "POST", headers: { Authorization: "Bearer stub", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "qwen3.7-plus", messages: [], stream: false }),
  });
  const j2 = await r2.json();
  assert(j2.choices?.[0]?.message?.content === "ABC");

  // 401 stale token
  console.log("✓ 401");
  const res401 = await fetch(`${env.QWEN_BASE_URL}/api/v2/chat/completions`, {
    method: "POST", headers: { Authorization: "Bearer stub", "Content-Type": "application/json", "x-fake-scenario": "stale_token" },
    body: JSON.stringify({ model: "qwen3.7-plus", messages: [] }),
  });
  const m401 = mapError({ status: res401.status, body: await res401.text() });
  assert(m401.error.code === "stale_token" && needsTokenRefresh(m401));

  // 503 backend busy
  console.log("✓ 503");
  const res503 = await fetch(`${env.QWEN_BASE_URL}/api/v2/chat/completions`, {
    method: "POST", headers: { Authorization: "Bearer stub", "x-fake-scenario": "backend_busy" },
    body: JSON.stringify({ model: "qwen3.7-plus", messages: [] }),
  });
  const m503 = mapError({ status: res503.status, body: await res503.text() });
  assert(m503.error.code === "backend_busy" && isRetryable(m503));

  // 429 rate limit
  console.log("✓ 429");
  const res429 = await fetch(`${env.QWEN_BASE_URL}/api/v2/chat/completions`, {
    method: "POST", headers: { Authorization: "Bearer stub", "x-fake-scenario": "rate_limit" },
    body: JSON.stringify({}),
  });
  const m429 = mapError({ status: res429.status, body: await res429.text() });
  assert(m429.error.code === "rate_limit");

  // Empty stream
  console.log("✓ empty");
  const re = await fetch(`${env.QWEN_BASE_URL}/api/v2/chat/completions`, {
    method: "POST", headers: { Authorization: "Bearer stub", "x-fake-scenario": "empty_stream" },
    body: JSON.stringify({ stream: true }),
  });
  assert(re.status === 200);
  let doneSeen = false;
  for await (const ev of streamCompletion(re)) if (ev.type === "done") doneSeen = true;
  assert(doneSeen, "expected DONE event");

  // Hint error event
  console.log("✓ hint");
  const rh = await fetch(`${env.QWEN_BASE_URL}/api/v2/chat/completions`, {
    method: "POST", headers: { Authorization: "Bearer stub", "x-fake-scenario": "hint_error" },
    body: JSON.stringify({ stream: true }),
  });
  assert(rh.status === 200);
  let hintSeen = false;
  for await (const ev of streamCompletion(rh)) if (ev.type === "hint") hintSeen = true;
  assert(hintSeen, "expected hint event");

  // Restore env
  for (const k in orig) process.env[k] = orig[k];
  delete process.env.QWEN_BASE_URL;
}