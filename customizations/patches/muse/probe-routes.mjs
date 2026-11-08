// Read-only structure probe over the live tunnel: what the model list, the
// session list and one page of chat history actually look like. Prints the
// SHAPE (keys, event names, lengths, ids truncated) and never a message body,
// so nothing the account owner wrote ends up in a log.
//
//   MUSE_LIVE=1 node muse/probe-routes.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

if (process.env.MUSE_LIVE !== "1") {
  console.log("refusing to touch the live account: run with MUSE_LIVE=1");
  process.exit(2);
}

const { MuseSession } = require("./lib/session.cjs");
const { HatchConnection } = require("./lib/gateway.cjs");
const { AccountPool } = require("./lib/pool.cjs");

const pool = new AccountPool({});
const account = pool.load()[0];
const session = new MuseSession({
  cookies: account.cookies,
  label: account.label,
  onRotate: (jar) => pool.save(account, jar),
});

const { session: vm } = await session.ensureRunning();
const tokens = await session.tokens(vm);
const conn = new HatchConnection({ url: session.wsUrl(vm, tokens.authToken, { notaryToken: tokens.notaryToken }), profile: "muse" });
await conn.connect();

const shape = (value, depth = 0) => {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return value.length ? `array(${value.length})<${shape(value[0], depth + 1)}>` : "array(0)";
  if (typeof value === "object") {
    if (depth > 3) return "object{…}";
    return `object{${Object.entries(value).map(([k, v]) => `${k}:${shape(v, depth + 1)}`).join(", ")}}`;
  }
  if (typeof value === "string") return `str(${value.length})`;
  return typeof value;
};

const ids = (value, keys) => {
  const out = {};
  for (const key of keys) if (value && value[key] !== undefined) out[key] = String(value[key]).slice(0, 12) + "…";
  return out;
};

for (const [label, call] of [
  ["GET /model", () => conn.request({ method: "GET", path: "/model", timeoutMs: 15000 })],
  ["GET /api/session/list", () => conn.request({ method: "GET", path: "/api/session/list", timeoutMs: 15000 })],
  ["GET /api/limits", () => conn.request({ method: "GET", path: "/api/limits", timeoutMs: 15000 })],
  ["GET /capabilities", () => conn.request({ method: "GET", path: "/capabilities", timeoutMs: 15000 })],
]) {
  try {
    const res = await call();
    const json = (() => { try { return res.json(); } catch { return null; } })();
    console.log(`\n${label} -> ${res.status} (${res.body.length} bytes)`);
    if (json) console.log("  shape:", shape(json));
    else console.log("  body:", res.text().slice(0, 120).replace(/[A-Za-z0-9_\-+/=]{18,}/g, "<redacted>"));
    if (label === "GET /model" && json && json.result) {
      const models = json.result.available_models || [];
      console.log("  selected:", JSON.stringify(json.result.selected_model), "default:", JSON.stringify(json.result.default_model));
      console.log("  model ids:", models.map((m) => `${m.provider}/${m.id ?? m.model}`).slice(0, 40).join(", "));
      console.log("  first model object:", JSON.stringify(models[0]).slice(0, 400));
    }
    if (label === "GET /api/session/list" && json && json.result && json.result.sessions && json.result.sessions[0]) {
      const first = json.result.sessions[0];
      console.log("  session[0]:", JSON.stringify(ids(first, ["session_id", "id", "title", "created_at_ms", "is_primary"])), "keys:", Object.keys(first).join(","));
      const history = await conn.request({
        method: "GET",
        path: `/chat/history?session_id=${encodeURIComponent(first.session_id || first.id)}&limit=8`,
        timeoutMs: 20000,
      }).catch((err) => ({ status: 0, note: err.kind + " " + err.message.slice(0, 80) }));
      if (history.status === 200) {
        const events = history.text().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        console.log(`  /chat/history -> ${events.length} records, event names:`, [...new Set(events.map((e) => e.event || e.event_name || "?"))].join(", "));
        console.log("  record shape:", shape(events[0]));
        const withText = events.filter((e) => e.payload && (e.payload.text || e.payload.display_text));
        console.log("  text lengths:", withText.map((e) => `${e.event}:${(e.payload.text || e.payload.display_text).length}`).slice(0, 6).join(", "));
      } else {
        console.log("  /chat/history:", history.note || history.status);
      }
    }
  } catch (err) {
    console.log(`\n${label} -> ERROR ${err.kind || "?"} ${String(err.message).replace(/[A-Za-z0-9_\-+/=]{18,}/g, "<redacted>").slice(0, 140)}`);
  }
}

conn.close();
console.log("\ndone");
