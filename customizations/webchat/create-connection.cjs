/**
 * Create provider connection via 9router dashboard API (browser transport).
 * Usage: node create-connection.cjs qwen-web [authType]
 */
"use strict";
const fs = require("fs");
const S = process.env.STATE_DIR || "C:/Users/Administrator/AppData/Roaming/9router";
const provider = process.argv[2]; // e.g., qwen-web, kimi-web
const authType = process.argv[3] || "oauth";
if (!provider) { console.log("Usage: node create-connection.cjs <provider> [auth-type]"); process.exit(1); }
let key; try { key = fs.readFileSync(S + "/auth/cli-secret", "utf8").trim(); } catch { key = ""; }
const body = { accounts: [{ provider, authType, accessToken: `${provider.toUpperCase()}_BROWSER_PROFILE_PLACEHOLDER`, email: `${provider}@user.local`, isActive: true, testStatus: "active" }] };
(async () => {
  const r = await fetch("http://localhost:20128/api/oauth/codex/bulk-import", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const t = await r.text();
  console.log(`HTTP ${r.status} for ${provider}:`, t.slice(0, 600));
})().catch(e => { console.log("ERR", e.message); process.exit(1); });