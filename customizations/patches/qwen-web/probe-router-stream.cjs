// Router-level streaming probe for qwen-web, dumps raw SSE into a file to inspect format.
"use strict";
const fs = require("fs");
const LOG = process.env.PROBE_LOG || "C:/Users/Administrator/my-9router-fork/customizations/webchat/qwen-web/probe-router-sse.log";
const k = fs.readFileSync("C:/Users/Administrator/AppData/Roaming/9router/auth/cli-secret", "utf8").trim();
(async () => {
  const r = await fetch("http://localhost:20128/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` }, body: JSON.stringify({ model: "qwen-web/qwen3.7-plus", messages: [{ role: "user", content: "Reply with exactly: QWEN_OK_DONE" }], stream: true }) });
  console.log("HTTP", r.status);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (true) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
  fs.writeFileSync(LOG, out);
  console.log("RAW_LEN", out.length);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });