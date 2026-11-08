/**
 * Fake Qwen Server - offline SSE + error path simulator for driver tests
 * Usage: node fake-qwen-server.cjs [port]
 * Endpoints: POST /api/v2/chat/completions (stream/non-stream), error scenarios via header x-fake-scenario
 */
"use strict";
const http = require("http");

const PORT = parseInt(process.argv[2] || "8899", 10);

function sseStream(res, chunks, delayMs = 50) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let i = 0;
  const timer = setInterval(() => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify(chunks[i])}\n\n`);
      i++;
    } else {
      res.write("data: [DONE]\n\n");
      clearInterval(timer);
      res.end();
    }
  }, delayMs);
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !/\/api\/v2\/chat\/completions/.test(req.url)) {
    res.writeHead(404);
    return res.end("not found");
  }
  const scenario = req.headers["x-fake-scenario"] || "success";
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = {}; }
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

    // success path
    const deltas = [
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " from" } }] },
      { choices: [{ delta: { content: " Qwen" } }] },
    ];
    if (stream) {
      sseStream(res, deltas);
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hello from Qwen" } }] }));
    }
  });
});

server.listen(PORT, () => console.log(`fake-qwen-server listening on ${PORT}`));
module.exports = server;