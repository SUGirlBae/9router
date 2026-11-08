// Can a Node client bootstrap the whole Muse chain, i.e. is a Chromium-free driver viable?
//   renew -> wake the VM -> poll until RUNNING -> mint the WS admission token -> mint notary token
//
// This is the same call sequence that 9router's own muse-web "test connection" already performs
// (chunks/5330.js module 20690 posts /api/hatch/vm/wake), so it spends no message quota; it does
// wake the account's cloud VM, which is why it is a separate, explicit script.
//
//   node muse/probe-wake.mjs
//
// Prints no credential, no token, no vm_id — only statuses, field names and host domains.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");

const DB = process.env.NINE_R_DB || "C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite";
const SITE = "https://muse.ai";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const POLL_MS = Number(process.env.MUSE_POLL_MS || 1500);
const BUDGET_MS = Number(process.env.MUSE_WAKE_BUDGET_MS || 60000);

// A jar we can mutate, because Muse rotates hatch_sess + hatch_vml on use.
const jar = new Map();
(function seed() {
  const db = new Database(DB, { readonly: true });
  const raw = JSON.parse(db.prepare("select data from providerConnections where provider='muse-web' limit 1").get().data).apiKey;
  db.close();
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && value) jar.set(name, value);
  }
  if (!jar.has("hatch_sess")) throw new Error("stored credential has no hatch_sess");
})();

const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const harvest = (res) => {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const names = [];
  for (const c of list) {
    const [pair] = String(c).split(";");
    const i = pair.indexOf("=");
    if (i > 0 && pair.slice(i + 1).trim()) {
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      names.push(pair.slice(0, i).trim());
    }
  }
  return [...new Set(names)];
};

async function call(method, path, { body, referer = `${SITE}/` } = {}) {
  const res = await fetch(SITE + path, {
    method,
    headers: {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: SITE,
      Referer: referer,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "User-Agent": UA,
      Cookie: cookieHeader(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const rotated = harvest(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, raw: json ? null : text.slice(0, 140), rotated };
}

// The registered domain only: enough to know which gateway Muse hands us, not enough to target.
const domainOf = (u) => { try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return null; } };

const log = (...a) => console.log(...a);
const redactFields = (o, hide) => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, hide.includes(k) ? `<${typeof v} len=${String(v).length}>` : (k === "vms" && Array.isArray(v) ? `array(${v.length})` : v)])) : o);

const HIDE = ["vm_id", "endpoint_url", "vm_name", "token", "notaryToken", "replaced_vm_id", "replace_attempt_id"];

// 1. renew
let s = await call("GET", "/api/session?vm_state=live");
log(`1. renew           http=${s.status} rotated=[${s.rotated.join(",")}]`, JSON.stringify(redactFields(s.json, HIDE)));
if (s.status !== 200 || s.json?.status !== "assigned") { log("ABORT: bootstrap not assigned — nothing downstream can work"); process.exit(1); }

// 2. wake, then judge by the session, never by the wake's own status
//    (muse.ai answers 403 to a wake for a VM that is already RUNNING)
if (s.json.vm_state !== "RUNNING") {
  const w = await call("POST", "/api/hatch/vm/wake", {
    body: { vm_id: s.json.vm_id, retry_count: 0, connect_attempt_id: crypto.randomUUID() },
    referer: `${SITE}/thread/new`,
  });
  log(`2. wake            http=${w.status} rotated=[${w.rotated.join(",")}] body=${JSON.stringify(redactFields(w.json, HIDE))}`);
} else {
  log("2. wake            skipped, vm_state already RUNNING");
}

// 3. poll for RUNNING
const t0 = Date.now();
let state = s.json.vm_state;
while (Date.now() - t0 < BUDGET_MS) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  s = await call("GET", "/api/session?vm_state=live");
  state = s.json?.vm_state;
  log(`   poll            +${((Date.now() - t0) / 1000).toFixed(1)}s http=${s.status} vm_state=${state} gateway=${domainOf(s.json?.endpoint_url)}`);
  if (state === "RUNNING") break;
}

// 4. the two admission tokens the WebSocket needs
const gw = s.json?.endpoint_url;
const tk = await call("POST", "/api/hatch/token", { body: { vmAddress: gw, vmName: s.json?.vm_id }, referer: `${SITE}/thread/new` });
log(`4. /api/hatch/token http=${tk.status} fields=${tk.json ? Object.keys(tk.json).join(",") : "-"} rotated=[${tk.rotated.join(",")}] ${tk.raw ? "raw=" + tk.raw : ""}`);
const nt = await call("POST", "/api/hatch/noise-notary-token", { body: { vmName: s.json?.vm_id }, referer: `${SITE}/thread/new` });
log(`5. notary token     http=${nt.status} fields=${nt.json ? Object.keys(nt.json).join(",") : "-"} ${nt.raw ? "raw=" + nt.raw : ""}`);

log("\nverdict:");
log(`  vm_state=${state} (RUNNING = the VM booted for a Node-driven client)`);
log(`  gateway domain=${domainOf(gw) || "(none)"}  has_endpoint_url=${Boolean(gw)}`);
log(`  token mint     http=${tk.status}${tk.json && tk.json.token ? " -> token issued, Node can attempt the Noise WS" : " -> no token"}`);
log(`  notary         http=${nt.status} (optional upstream)`);
