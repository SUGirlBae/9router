/**
 * Executor factory offline test - execute() must return {response, url, headers, transformedBody}
 * against a fake upstream. No quota. Usage: node test-executor.cjs ; exit 0 = green.
 */
"use strict";
const assert = require("assert");
const http = require("http");
const { createWebchatExecutor } = require("./executor.cjs");

const PORT = 8903;
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", c => body += c);
  req.on("end", () => {
    if (/health/.test(req.url)) { res.writeHead(200); return res.end("ok"); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
});

server.listen(PORT, async () => {
  let passed = 0, failed = 0;
  const t = (name, fn) => { try { fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + ": " + e.message); } };
  const base = `http://localhost:${PORT}`;
  const Exec = createWebchatExecutor(undefined, { id: "qwen-web", baseUrl: base });
  const ex = new Exec();

  t("constructor sets provider", () => assert.strictEqual(ex.provider, "qwen-web"));
  const tc = await ex.testConnection("valid-token-1234567890");
  t("testConnection true on 200", () => assert.strictEqual(tc, true));
  const tcBad = await ex.testConnection("x");
  t("testConnection false on short token", () => assert.strictEqual(tcBad, false));

  const out = await ex.execute({ model: "qwen3.7-plus", body: { messages: [{ role: "user", content: "hi" }] }, stream: true, credentials: { accessToken: "tok" }, signal: undefined, log: undefined });
  t("execute returns response object", () => assert(out && out.response instanceof Response));
  t("execute returns url+headers", () => assert(out.url && out.headers));
  const text = await out.response.text();
  t("normalized SSE contains delta", () => assert(text.includes('"content":"Hi"') || text.includes("Hi")));
  t("normalized SSE ends DONE", () => assert(text.includes("[DONE]")));

  let threw = false;
  try { await ex.execute({ model: "m", body: { messages: [] }, stream: true, credentials: {}, signal: undefined, log: undefined }); } catch { threw = true; }
  t("execute throws on missing token", () => assert(threw));

  console.log(`\n${passed} passed, ${failed} failed`);
  server.closeAllConnections(); server.close(() => { process.exitCode = failed ? 1 : 0; }); server.unref();
});