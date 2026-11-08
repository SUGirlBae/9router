import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
//   prefixed        same, with 2-byte handshake length prefixes
//   splitcipher     same, with per-direction CipherStates
"use strict";

const noise = require("./lib/noise.cjs");
const { MuseSession } = require("./lib/session.cjs");
const { HatchConnection } = require("./lib/gateway.cjs");
const { AccountPool } = require("./lib/pool.cjs");

if (process.env.MUSE_LIVE !== "1") {
  console.log("refusing to touch the live account: run with MUSE_LIVE=1");
  process.exit(2);
}

const VARIANTS = {
  muse: "muse",
  prefixed: { ...noise.PROFILES.muse, handshakeLengthPrefix: true },
  splitcipher: { ...noise.PROFILES.muse, sharedHandshakeCipher: false },
};
const variantName = process.env.MUSE_NOISE_VARIANT || "muse";
const profile = VARIANTS[variantName] || "muse";

const SECRETISH = /[A-Za-z0-9_\-+/=]{18,}/g;
const scrub = (text) => String(text).replace(SECRETISH, (m) => `<len=${m.length}>`);

const t0 = Date.now();
const mark = (label) => console.log(`  +${((Date.now() - t0) / 1000).toFixed(2)}s ${label}`);

const pool = new AccountPool({ log: (m, d) => console.log("  pool:", m, d || "") });
const accounts = pool.load();
if (!accounts.length) {
  console.log("no muse account: neither the pool file nor 9router has one");
  process.exit(1);
}
const account = accounts[0];
console.log(`account=${account.label} cookies=${pool.describe()[0].cookieNames}`);

const session = new MuseSession({
  cookies: account.cookies,
  label: account.label,
  log: (m, d) => console.log("  session:", m, d || ""),
  onRotate: (jar) => pool.save(account, jar),
});

mark("bootstrap: renew + wake if needed");
const { session: vm, woke, waitedMs } = await session.ensureRunning();
mark(`vm ready state=${vm.vmState} type=${vm.vmType} woke=${woke} waitMs=${waitedMs} gateway=${vm.endpointUrl ? new URL(vm.endpointUrl).hostname.split(".").slice(-2).join(".") : "-"}`);

mark("mint admission token");
const tokens = await session.tokens(vm);
mark(`token issued auth=${Boolean(tokens.authToken)} notary=${Boolean(tokens.notaryToken)}`);

const url = session.wsUrl(vm, tokens.authToken, { notaryToken: tokens.notaryToken });
console.log(`  ws target = ${url.replace(/[-\w]{20,}/g, "<redacted>").slice(0, 90)}...`);

let conn = null;
let lastError = null;
for (let attempt = 1; attempt <= 4 && !conn; attempt += 1) {
  const candidate = new HatchConnection({ url, profile, log: (m, d) => console.log("  tunnel:", m, d || ""), connectTimeoutMs: 20000 });
  try {
    await candidate.connect();
    conn = candidate;
    mark(`noise handshake OK on attempt ${attempt} (variant=${variantName})`);
  } catch (err) {
    lastError = err;
    mark(`attempt ${attempt} failed: ${err.kind} ${scrub(err.message).slice(0, 140)}`);
    candidate.close();
    if (attempt < 4) await new Promise((r) => setTimeout(r, Math.min(3000, 1000 * Math.pow(1.5, attempt - 1))));
  }
}
if (!conn) {
  console.log(`\nGATE C2 FAILED (variant=${variantName}): ${lastError ? scrub(lastError.message).slice(0, 200) : "unknown"}`);
  console.log("verdict: the tunnel could not be opened from Node with this Noise convention");
  process.exit(1);
}
console.log(`  server static key fingerprint = ${Buffer.from(conn.cipher.remoteStatic).toString("hex").slice(0, 16)}...`);

const pingStart = Date.now();
const ping = await conn.request({ method: "POST", path: "/api/ping", body: {}, timeoutMs: 20000 });
console.log(`  +${((Date.now() - pingStart) / 1000).toFixed(2)}s POST /api/ping -> ${ping.status} bytes=${ping.body.length} body=${scrub(ping.text()).slice(0, 160)}`);

const modelStart = Date.now();
let model = null;
let modelError = null;
try {
  model = await conn.request({ method: "GET", path: "/model", timeoutMs: 20000 });
  console.log(`  +${((Date.now() - modelStart) / 1000).toFixed(2)}s GET  /model     -> ${model.status} bytes=${model.body.length} body=${scrub(model.text()).slice(0, 160)}`);
} catch (err) {
  modelError = err;
  console.log(`  GET /model -> ${err.kind} ${scrub(err.message).slice(0, 160)}`);
}

let sessions = null;
try {
  sessions = await conn.request({ method: "GET", path: "/api/session/list", timeoutMs: 20000 });
  console.log(`  GET /api/session/list -> ${sessions.status} bytes=${sessions.body.length} body=${scrub(sessions.text()).slice(0, 160)}`);
} catch (err) {
  console.log(`  GET /api/session/list -> ${err.kind} ${scrub(err.message).slice(0, 120)}`);
}

conn.close();
mark("connection closed");
console.log("\nverdict:");
console.log(`  handshake      = OK with variant=${variantName}`);
console.log(`  /api/ping      = ${ping.status}${ping.status < 400 ? " (the tunnel speaks our framing)" : ""}`);
console.log(`  /model         = ${model ? model.status : modelError ? modelError.kind : "-"}`);
console.log(`  total wall     = ${((Date.now() - t0) / 1000).toFixed(2)}s`);
