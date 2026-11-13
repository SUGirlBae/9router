// Live qwen probe writing step logs + result to a file (bypasses pipe buffering).
"use strict";
const fs = require("fs");
const LOG = process.env.PROBE_LOG || "C:/Users/Administrator/my-9router-fork/customizations/webchat/qwen-web/probe-live.log";
const log = (m) => { fs.appendFileSync(LOG, m + "\n"); };
fs.writeFileSync(LOG, "");
const { chatViaBrowser } = require("./browser-client.cjs");
const { parseSSEChunk } = require("./sse.cjs");
(async () => {
  log("start");
  const r = await chatViaBrowser({ model: "qwen3.7-plus", messages: [{ role: "user", content: "Hi" }], stream: true }, 180000);
  log("HTTP " + r.status + " CT=" + r.contentType);
  fs.writeFileSync(__dirname + "/raw-sse.txt", r.text || "");
  if (r.contentType.includes("application/json")) { log("JSON " + r.text.slice(0, 300)); return; }
  const evs = parseSSEChunk(r.text);
  let out = ""; for (const e of evs) if (e.type === "delta") out += e.content;
  log("DELTAS=" + evs.filter(e => e.type === "delta").length + " OUT=" + JSON.stringify(out.slice(0, 100)));
  log("DONE");
})().catch(e => { log("ERR " + e.message); process.exit(1); });