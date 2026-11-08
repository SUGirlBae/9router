const D = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");
const db = new D("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
const key = db.prepare("select key from apiKeys where isActive=1 limit 1").get().key;
const M = process.argv[2], WAIT = Number(process.argv[3] || 130000);
(async () => {
  const t0 = Date.now(); const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), WAIT);
  try {
    const r = await fetch("http://127.0.0.1:20128/v1/chat/completions", { method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: M, messages: [{ role: "user", content: "Reply with exactly: OK" }] }) });
    console.log(`headers after ${((Date.now()-t0)/1000).toFixed(1)}s -> ${r.status}`);
    let t = ""; for await (const c of r.body) { t += Buffer.from(c).toString(); if (Date.now()-t0 > WAIT) break; }
    console.log(`  done ${((Date.now()-t0)/1000).toFixed(1)}s len=${t.length}\n  ${t.replace(/\s+/g," ").slice(0, 400)}`);
  } catch (e) { console.log(`  aborted after ${((Date.now()-t0)/1000).toFixed(1)}s: ${e.message}`); }
  console.log("\nrouter-side rows for this model:");
  for (const row of db.prepare("select timestamp,status,data from requestDetails where provider='qoder' and model=? order by id desc limit 4").all(M.replace(/^qd[\/|]*/, ""))) {
    const d = JSON.parse(row.data);
    console.log(`  ${row.timestamp.slice(11)} ${row.status} total=${(d.latency?.total/1000).toFixed(1)}s err=${String(d.response?.error||"").slice(0,150)}`);
  }
})();
