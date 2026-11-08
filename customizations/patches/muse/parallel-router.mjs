// Six real turns through 9router at once, on the account's single agent VM.
//   MUSE_LIVE=1 node muse/parallel-router.mjs 6
// This SPENDS messages: each turn is a real Muse reply. It answers the question
// the browser path could not: what does one Muse account actually do under
// concurrent sub-agent load.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

if (process.env.MUSE_LIVE !== "1") {
  console.log("run with MUSE_LIVE=1 (it spends real messages)");
  process.exit(2);
}

const N = Number(process.argv[2] || 6);
const PORT = process.env.MUSE_ROUTER_PORT || "20128";
const MODEL = process.env.MUSE_ROUTER_MODEL || "muse-web/muse-chat";
const BASE = `http://127.0.0.1:${PORT}`;

const Database = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");
const db = new Database("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
const key = db.prepare("select key from apiKeys where isActive=1 limit 1").get().key;
const before = db.prepare("select count(*) c from requestDetails").get().c;
db.close();

const turn = async (index) => {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: `Say exactly one short sentence about number ${index}.` }],
      }),
      signal: AbortSignal.timeout(420000),
    });
    const text = await res.text();
    let content = "";
    // The web executor answers with SSE even when stream was not asked for, so
    // both shapes have to be read here or the run looks like a failure.
    if (text.startsWith("data:")) {
      for (const frame of text.split("\n\n")) {
        if (!frame.startsWith("data: ") || frame === "data: [DONE]") continue;
        try {
          const obj = JSON.parse(frame.slice(6));
          content += obj.choices?.[0]?.delta?.content || obj.choices?.[0]?.message?.content || "";
        } catch {
          /* heartbeat or partial frame */
        }
      }
    } else {
      try {
        content = JSON.parse(text).choices?.[0]?.message?.content || "";
      } catch {
        /* non-JSON error page */
      }
    }
    return { index, status: res.status, ms: Date.now() - started, chars: content.length, error: content ? null : text.slice(0, 120) };
  } catch (err) {
    return { index, status: 0, ms: Date.now() - started, chars: 0, error: String(err.message).slice(0, 120) };
  }
};

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => turn(i + 1)));
const wall = Date.now() - t0;

console.log(`${N} concurrent turns through :${PORT} (${MODEL}) — wall ${(wall / 1000).toFixed(1)} s`);
for (const r of results) {
  console.log(`  turn ${String(r.index).padStart(2)}  http=${r.status}  ${(r.ms / 1000).toFixed(1)}s  ${r.chars} chars${r.error ? "  ERR " + r.error.replace(/\s+/g, " ").slice(0, 90) : ""}`);
}
const ok = results.filter((r) => r.status === 200 && r.chars > 0);
const times = ok.map((r) => r.ms / 1000).sort((a, b) => a - b);
console.log(`  ok ${ok.length}/${N}; median ${(times[Math.floor(times.length / 2)] || 0).toFixed(1)}s; slowest ${(times[times.length - 1] || 0).toFixed(1)}s`);

const db2 = new Database("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
const rows = db2.prepare("select provider, model, status, timestamp from requestDetails order by rowid desc limit 12").all();
db2.close();
console.log(`  requestDetails grew ${rows.length ? "" : ""}`);
for (const row of rows.slice(0, N + 2)) console.log(`   ${row.timestamp} ${row.provider} ${row.model} ${row.status}`);
