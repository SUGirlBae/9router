/**
 * Create a real provider connection by importing a logged-in browser profile via
 * POST /api/providers/web-login {provider, profile}. Then poll router-level completion.
 * Usage: node connect-weblogin.cjs qwen-web qwen
 */
"use strict";
const fs = require("fs");
const S = process.env.STATE_DIR || "D:/9router/data";
const PORT = process.env.PORT || "20130";
const provider = process.argv[2] || "qwen-web";
const profile = process.argv[3] || "qwen";
let key = "";
try {
  key = fs.readFileSync(S + "/auth/cli-secret", "utf8").trim();
} catch {
  try {
    key = fs.readFileSync("C:/Users/Administrator/AppData/Roaming/9router/auth/cli-secret", "utf8").trim();
  } catch {}
}
const H = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const r = await fetch(`http://localhost:${PORT}/api/providers/web-login`, { method: "POST", headers: H, body: JSON.stringify({ provider, profile }) });
  console.log("WEBLOGIN HTTP", r.status, (await r.text()).slice(0, 200));
  // poll router-level completion until connection is active (404 -> other)
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const c = await fetch(`http://localhost:${PORT}/v1/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model: `${provider}/qwen3.7-plus`, messages: [{ role: "user", content: "Reply with exactly: ROUTER_OK" }], stream: false }) });
    const t = await c.text();
    console.log(`poll ${i}: HTTP ${c.status} ${t.slice(0, 160)}`);
    if (c.status !== 404) { console.log("RESULT_BODY:", t.slice(0, 400)); break; }
  }
})().catch(e => { console.log("ERR", e.message); process.exit(1); });