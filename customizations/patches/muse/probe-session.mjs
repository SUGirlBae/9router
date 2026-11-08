// Does muse.ai's authenticated bootstrap accept a Node client, or only a browser fingerprint?
// The reference bridges claim Meta's edge proxies reject stock TLS/HTTP fingerprints on
// authenticated routes, which decides whether 9router can talk to muse.ai directly.
//
// Reads the already-stored muse-web credential, sends ONE GET /api/session per transport,
// and prints only non-secret fields (never the cookie, never vm_id / endpoint_url).
//
//   node muse/probe-session.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");

const DB = process.env.NINE_R_DB || "C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite";
const SITE = "https://muse.ai";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function credential() {
  const db = new Database(DB, { readonly: true });
  const row = db.prepare("select data from providerConnections where provider='muse-web' limit 1").get();
  db.close();
  if (!row) throw new Error("no muse-web connection in the 9router DB");
  const raw = JSON.parse(row.data).apiKey;
  if (typeof raw !== "string" || !raw.includes("hatch_sess=")) throw new Error("stored credential has no hatch_sess");
  return raw;
}

// The application headers the web client actually sends (mirrored from the bridges'
// captured XHRs). Host / Connection / Accept-Encoding are left to the transport.
function headers(cookie) {
  return {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9,en-GB;q=0.8",
    Origin: SITE,
    Referer: SITE + "/",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Priority: "u=4",
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    "User-Agent": UA,
    Cookie: cookie,
  };
}

const cookieNames = (list) => (list || []).map((c) => String(c).split(";")[0].split("=")[0]).sort().join(",") || "-";

async function viaFetch(cookie) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${SITE}/api/session?vm_state=live`, { headers: headers(cookie) });
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { /* not json */ }
    return {
      transport: "undici fetch (h1)",
      ms: Date.now() - t0,
      status: res.status,
      session_status: body?.status ?? null,
      vm_state: body?.vm_state ?? null,
      fields: body ? Object.keys(body).join(",") : "-",
      rotated: cookieNames(setCookies),
      bodyIfBad: res.ok ? undefined : text.slice(0, 160),
    };
  } catch (e) {
    return { transport: "undici fetch (h1)", ms: Date.now() - t0, status: 0, error: String(e.message || e).slice(0, 200) };
  }
}

async function viaHttp2(cookie) {
  const http2 = await import("node:http2");
  const tls = await import("node:tls");
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (o) => { if (!settled) { settled = true; resolve(o); } };
    // Node's default cipher suite, deliberately untouched: this probe measures what a
    // non-browser client looks like to Muse's edge proxy, it does not disguise one.
    const session = http2.connect(SITE, {
      createConnection: () => tls.connect({ host: "muse.ai", port: 443, servername: "muse.ai", ALPNProtocols: ["h2"] }),
    });
    session.on("error", (e) => done({ transport: "node:http2 (h1 TLS profile)", ms: Date.now() - t0, status: 0, error: String(e.message).slice(0, 200) }));
    const req = session.request({
      ":method": "GET",
      ":path": "/api/session?vm_state=live",
      ":authority": "muse.ai",
      ...headers(cookie),
    });
    let raw = "";
    let h = null;
    req.on("response", (resp) => { h = resp; });
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* not json */ }
      done({
        transport: "node:http2 (h1 TLS profile)",
        ms: Date.now() - t0,
        status: h?.[":status"] ?? 0,
        session_status: body?.status ?? null,
        vm_state: body?.vm_state ?? null,
        fields: body ? Object.keys(body).join(",") : "-",
        rotated: cookieNames(h?.["set-cookie"] ? [].concat(h["set-cookie"]) : []),
        bodyIfBad: h?.[":status"] === 200 ? undefined : raw.slice(0, 160),
      });
      session.close();
    });
    req.on("error", (e) => { done({ transport: "node:http2", ms: Date.now() - t0, status: 0, error: String(e.message).slice(0, 200) }); session.close(); });
    setTimeout(() => { done({ transport: "node:http2", ms: Date.now() - t0, status: 0, error: "timeout 15s" }); session.close(); }, 15000);
  });
}

const cookie = credential();
const results = [await viaFetch(cookie)];
results.push(await viaHttp2(cookie).catch((e) => ({ transport: "node:http2", status: 0, error: "threw " + String(e.message).slice(0, 160) })));

for (const r of results) console.log(JSON.stringify(r));

console.log("\nverdict (200 + status=assigned means Muse accepts this client):");
for (const r of results) {
  const ok = r.status === 200 && r.session_status === "assigned";
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${String(r.transport).padEnd(26)} http=${r.status} session=${r.session_status} vm=${r.vm_state} ${r.ms}ms${r.error ? " err=" + r.error : ""}${r.bodyIfBad ? " body=" + r.bodyIfBad : ""}`);
}
