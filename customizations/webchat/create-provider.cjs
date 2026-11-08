/**
 * Create generic provider connection via /api/models/custom POST.
 * Usage: node create-provider.cjs qwen-web [authType]
 */
"use strict";
const fs = require("fs");
const S = process.env.STATE_DIR || "C:/Users/Administrator/AppData/Roaming/9router";
const provider = process.argv[2]; // qwen-web, kimi-web
if (!provider) { console.log("Usage: node create-provider.cjs <provider> [auth-type]"); process.exit(1); }
let key; try { key = fs.readFileSync(S + "/auth/cli-secret", "utf8").trim(); } catch { key = ""; }
const body = { id: provider, alias: provider, email: `${provider}@user.local`, password: "", token: "", type: "oauth", providerSpecificData: {}, isActive: true, testStatus: "active" };
(async () => {
  const r = await fetch("http://localhost:20128/api/models/custom", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const t = await r.text();
  console.log(`HTTP ${r.status} for ${provider}:`, t.slice(0, 600));
})().catch(e => { console.log("ERR", e.message); process.exit(1); });