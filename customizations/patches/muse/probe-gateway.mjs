// Does the Hatch gateway accept a Node WebSocket upgrade, and does it expose any plain-HTTP RPC
// surface that would let us skip the Noise layer entirely?
//
//   node muse/probe-gateway.mjs
//
// No quota spent: no chat turn is sent. Prints no credential, no token, no vm_id, no full host.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");

const DB = process.env.NINE_R_DB || "C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite";
const SITE = "https://muse.ai";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const APP_ID = "hatch-web";

const jar = new Map();
{
  const db = new Database(DB, { readonly: true });
  const raw = JSON.parse(db.prepare("select data from providerConnections where provider='muse-web' limit 1").get().data).apiKey;
  db.close();
  for (const part of String(raw).split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(i + 1).trim()) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const harvest = (res) => {
  for (const c of (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [])) {
    const [pair] = String(c).split(";");
    const i = pair.indexOf("=");
    if (i > 0 && pair.slice(i + 1).trim()) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
};
const baseHeaders = (extra = {}) => ({
  Accept: "*/*", "Accept-Language": "en-US,en;q=0.9", Origin: SITE, Referer: `${SITE}/thread/new`,
  "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
  "User-Agent": UA, Cookie: cookieHeader(), ...extra,
});

const siteCall = async (method, path, body) => {
  const res = await fetch(SITE + path, { method, headers: baseHeaders(body ? { "Content-Type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
  harvest(res);
  let j = null; try { j = await res.json(); } catch { /* not json */ }
  return { status: res.status, json: j };
};

const hostOf = (u) => { try { const h = new URL(u).hostname; return h.split(".").slice(-2).join("."); } catch { return "(bad url)"; } };
const log = console.log;

// ---- bootstrap (same sequence 9router's dashboard test already performs) ----
let s = await siteCall("GET", "/api/session?vm_state=live");
if (s.json?.vm_state !== "RUNNING") {
  await siteCall("POST", "/api/hatch/vm/wake", { vm_id: s.json.vm_id, retry_count: 0, connect_attempt_id: crypto.randomUUID() });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    s = await siteCall("GET", "/api/session?vm_state=live");
    if (s.json?.vm_state === "RUNNING") break;
  }
}
const vmId = s.json?.vm_id, endpoint = s.json?.endpoint_url, vmType = s.json?.vm_type;
log(`bootstrap: session=${s.json?.status} vm_state=${s.json?.vm_state} vm_type=${vmType} gateway=${hostOf(endpoint)}`);

const tk = await siteCall("POST", "/api/hatch/token", { vmAddress: endpoint, vmName: vmId });
const token = tk.json?.token, notaryFromToken = tk.json?.notary_token;
log(`token: http=${tk.status} has_token=${Boolean(token)} has_notary_in_same_response=${Boolean(notaryFromToken)}`);
if (!token) { log("ABORT: no admission token, nothing downstream is testable"); process.exit(1); }

const wsUrl = (host) => {
  const p = new URLSearchParams({ vm_id: vmId, auth_token: token, app_id: APP_ID, request_id: crypto.randomUUID() });
  if (notaryFromToken) p.set("notary_token", notaryFromToken);
  return `wss://${host}/v1/noise?${p}`;
};

// ---- A. is there a plain-HTTP RPC surface on the gateway? (if yes, no Noise needed) ----
// Liveness paths only. /chat/stream is deliberately NOT tried here over HTTP: if the gateway
// did accept it, that would enqueue a real agent turn and spend message quota.
const origin = String(endpoint).replace(/\/+$/, "");
for (const [method, path, body] of [["GET", "/health", null], ["POST", "/api/ping", {}]]) {
  for (const auth of [false, true]) {
    try {
      const res = await fetch(origin + path, { method, headers: baseHeaders({ ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
      harvest(res);
      const text = (await res.text()).slice(0, 90).replace(/\s+/g, " ");
      log(`A. http ${method} ${path} auth=${auth ? "bearer" : "none"} -> ${res.status} ${text}`);
    } catch (e) {
      log(`A. http ${method} ${path} auth=${auth ? "bearer" : "none"} -> ERR ${String(e.message || e).slice(0, 80)}`);
    }
  }
}

// ---- B. does the WS upgrade itself succeed from Node's built-in client? ----
const hosts = [...new Set([new URL(endpoint).hostname, "hatch.metaaivm.com"])];
for (const host of hosts) {
  const url = wsUrl(host);
  await new Promise((resolve) => {
    const t0 = Date.now();
    let ws;
    try { ws = new WebSocket(url); } catch (e) { log(`B. wss ${host} -> constructor threw ${e.message}`); return resolve(); }
    let first = null;
    const timer = setTimeout(() => { log(`B. wss ${host} -> no response in 12s (upgrade never completed or silent)`); try { ws.close(); } catch { } resolve(); }, 12000);
    ws.onopen = () => {
      log(`B. wss ${host} -> OPEN (101) in ${Date.now() - t0}ms  protocol="${ws.protocol || "-"}"`);
      // Noise XX is initiator-first: the server sends nothing until msg1. So the only safe
      // observation is whether the tunnel stays open. No bytes are sent by this probe.
      setTimeout(() => { clearTimeout(timer); log(`   stayed open 3s, first frame: ${first ? first + " bytes" : "(none, as expected for initiator-first XX)"}`); try { ws.close(); } catch { } resolve(); }, 3000);
    };
    ws.onmessage = (ev) => { first = typeof ev.data === "string" ? ev.data.length : (ev.data?.byteLength ?? 0); };
    ws.onerror = (e) => { clearTimeout(timer); log(`B. wss ${host} -> ERROR ${e?.message || e?.error?.message || "ws error"} (http layer never gave us a status)`); resolve(); };
    ws.onclose = (ev) => { clearTimeout(timer); log(`B. wss ${host} -> CLOSED code=${ev.code} reason="${String(ev.reason).slice(0, 40)}" after ${Date.now() - t0}ms`); resolve(); };
  });
}

log("\nverdict hints:");
log("  A. 404/405 on every path  -> the gateway has no HTTP RPC surface; the Noise WS is the only transport");
log("  A. 200 with JSON          -> skip Noise entirely, use plain HTTP (much simpler driver)");
log("  B. OPEN (101)             -> Node's WebSocket can reach the tunnel; next step is implementing Noise XX msg1/2/3");
log("  B. CLOSED 1006/401        -> upgrade rejected (params, token shape, or the LB host differs for this account)");
