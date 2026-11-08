// Read back one already-generated turn to learn the real artifact shape,
// without spending another generation.
//   MUSE_LIVE=1 node muse/probe-media.mjs "<prompt used before>"
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

if (process.env.MUSE_LIVE !== "1") {
  console.log("run with MUSE_LIVE=1");
  process.exit(2);
}

const { MuseSession } = require("./lib/session.cjs");
const { HatchConnection } = require("./lib/gateway.cjs");
const { AccountPool } = require("./lib/pool.cjs");
const { MuseBridge, deterministicSessionId } = require("./muse-bridge.cjs");
const media = require("./lib/media.cjs");

const prompt = process.argv[2] || "A tiny red circle on a white background, flat vector";
const pool = new AccountPool({});
const account = pool.load()[0];
const session = new MuseSession({ cookies: account.cookies, label: account.label, onRotate: (jar) => pool.save(account, jar) });
const { session: vm } = await session.ensureRunning();
const tokens = await session.tokens(vm);
const conn = new HatchConnection({ url: session.wsUrl(vm, tokens.authToken, { notaryToken: tokens.notaryToken }), profile: "muse" });
await conn.connect();

const sessionId = deterministicSessionId(`image:${prompt}`);
const res = await conn.request({ method: "GET", path: `/chat/history?session_id=${encodeURIComponent(sessionId)}&limit=60`, timeoutMs: 25000 });
const json = res.json();
const events = (json.result && json.result.chat_events) || json.chat_events || [];
console.log("session", sessionId, "events", events.length);

const scrub = (value) =>
  typeof value === "string"
    ? value.replace(/([?&](?:sig|token|key|expires|Signature|Expires|Kms|Token)=)[^&\s]+/gi, "$1<redacted>")
    : value;

for (const event of events) {
  const refs = media.extractRefs(event);
  if (!refs.length && !/presentation/.test(String(event.event_name))) continue;
  console.log(`\n== ${event.event_name} role=${event.role} refs=${refs.length}`);
  console.log("   payload keys:", Object.keys(event.payload || {}).join(","), "kind=", event.payload && event.payload.kind);
  const data = (event.payload && event.payload.data) || {};
  for (const list of ["images", "videos"]) {
    for (const node of data[list] || []) {
      console.log(`   ${list} node keys:`, Object.keys(node).join(","));
      console.log("   node:", JSON.stringify(node, (k, v) => scrub(v)).slice(0, 420));
    }
  }
  for (const ref of refs) {
    console.log("   -> ref:", JSON.stringify({ path: ref.path, url: ref.url && String(ref.url).slice(0, 60), kind: ref.kind, identity: ref.identity.slice(0, 70) }));
    if (ref.path) {
      for (const route of [`/media/raw/${media.encodePath(ref.path)}`, `/fs/raw/${media.encodePath(ref.path)}`]) {
        try {
          const probe = await conn.request({ method: "GET", path: route, timeoutMs: 30000 });
          console.log(`      ${route.slice(0, 46)} -> ${probe.status} bytes=${probe.body.length} ct=${(probe.headers.find((h) => /content-type/i.test(h.key)) || {}).value}`);
        } catch (err) {
          console.log(`      ${route.slice(0, 46)} -> ${err.kind || "?"} ${String(err.message).slice(0, 90)}`);
        }
      }
    }
  }
}
conn.close();
