// One-command health read for the 9router web providers.
//   node 9r-status.js            # concise report
//   node 9r-status.js --probe    # also fire one live request per qoder model
const D = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DB = "C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite";
const GW_HEALTH = "http://127.0.0.1:20129/healthz";
const db = new D(DB, { readonly: true });
const probe = process.argv.includes("--probe");
const key = db.prepare("select key from apiKeys where isActive=1 limit 1").get().key;

const get = (url) => new Promise((res) => {
  http.get(url, (r) => { let t = ""; r.on("data", (d) => (t += d)); r.on("end", () => res(t)); }).on("error", (e) => res(JSON.stringify({ down: e.code })));
});

(async () => {
  const settings = JSON.parse(db.prepare("select data from settings limit 1").get().data);
  console.log(`9router port ${process.env.PORT || 20128} | strategy per provider: ${JSON.stringify(Object.fromEntries(Object.entries(settings.providerStrategies || {}).map(([k, v]) => [k, v.fallbackStrategy])))}`);

  console.log("\nconnections (provider / active / last error):");
  for (const r of db.prepare("select provider,id,name,email,isActive,data from providerConnections where isActive=1 order by provider,priority").all()) {
    const d = JSON.parse(r.data);
    const err = String(d.lastError || "").replace(/\s+/g, " ").slice(0, 78);
    if (err || ["qoder", "deepseek-web"].includes(r.provider))
      console.log(`  ${r.provider.padEnd(13)} ${(r.email || r.name || "").padEnd(28)} ${r.id.slice(0, 8)} ${err ? "lastErr=" + err : "clean"}${d.backoffLevel ? " backoff=" + d.backoffLevel : ""}`);
  }

  // rows are inserted when a request starts and updated in place when it finishes, so newest
  // by id would over-sample in-flight/failed turns; order by the recorded start timestamp
  const rows = db.prepare("select timestamp,provider,model,status,data from requestDetails where timestamp > datetime('now','-45 minutes') order by timestamp desc limit 300").all();
  const byProv = {};
  for (const r of rows) {
    let d = {}; try { d = JSON.parse(r.data); } catch {}
    const e = byProv[r.provider] = byProv[r.provider] || { n: 0, ok: 0, slow: 0, kinds: {} };
    e.n++; if (r.status === "success") e.ok++;
    if ((d.latency?.total || 0) > 30000) e.slow++;
    const err = String(d.response?.error || "");
    const kind = /ENOTFOUND|fetch failed/.test(err) ? "transport/DNS"
      : /pricingUrl|"code":"?112/.test(err) ? "plan-gated(403)"
      : /not yet known/.test(err) ? "model-not-provisioned"
      : /still queued/.test(err) ? "upstream-queue(p3)"
      : /backend_busy|no FINISHED/.test(err) ? "upstream-busy"
      : err ? "other" : null;
    if (kind) e.kinds[kind] = (e.kinds[kind] || 0) + 1;
  }
  // NOTE this counts router *attempt rows*, not client turns: one client request can write
  // several rows as 9router retries across connections, so the ratio reads far worse than the
  // user-visible success rate. The hedge gateway's /healthz numbers are the client-facing ones.
  console.log(`\nlast ${rows.length} attempt rows (includes 9router internal retries — not client turns):`);
  for (const [p, e] of Object.entries(byProv))
    console.log(`  ${p.padEnd(14)} ok=${String(e.ok).padStart(3)}/${e.n}  >30s=${String(e.slow).padStart(3)}  ${Object.entries(e.kinds).map(([k, v]) => `${k}:${v}`).join(" ")}`);

  const perModel = {};
  for (const r of rows.filter((x) => x.provider === "qoder")) {
    let d = {}; try { d = JSON.parse(r.data); } catch {}
    const m = perModel[r.model] = perModel[r.model] || { n: 0, ok: 0, gated: 0, queued: 0 };
    m.n++; if (r.status === "success") m.ok++;
    const err = String(d.response?.error || "");
    if (/pricingUrl|not yet known/.test(err)) m.gated++;
    if (/still queued/.test(err)) m.queued++;
  }
  console.log("\nqoder models:");
  for (const [m, v] of Object.entries(perModel).sort((a, b) => b[1].n - a[1].n))
    console.log(`  ${m.padEnd(18)} ok=${String(v.ok).padStart(3)}/${String(v.n).padStart(3)}  plan-gated=${v.gated} queued=${v.queued}`);

  const gw = JSON.parse(await get(GW_HEALTH));
  if (gw.ok) console.log(`\nhedge gateway: req=${gw.stats.req} ok=${gw.stats.ok} failed=${gw.stats.failed} hedged=${gw.stats.hedged} transient-swallowed=${gw.stats.transient} circuits=[${gw.stats.circuits.map((c) => `${c.model}:${Math.round(c.openForMs / 1000)}s`).join(" ")}]`);
  else console.log("\nhedge gateway: NOT RUNNING on 20129 — start with:  node --require ./9r-net-keeper.js 9r-hedge-gateway.js");

  const log = path.join(__dirname, "hedge-gateway.log");
  if (fs.existsSync(log)) {
    const tail = fs.readFileSync(log, "utf8").trim().split("\n").slice(-6);
    console.log("\nrecent gateway events:\n  " + tail.join("\n  "));
  }

  if (probe) {
    console.log("\nlive probe (qd models through the gateway, 90s cap each):");
    for (const m of ["qd/qfmodel", "qd/gfmodel", "qd/cmodel"]) {
      const t0 = Date.now();
      const body = JSON.stringify({ model: m, messages: [{ role: "user", content: "Reply with exactly: OK" }] });
      try {
        const r = await fetch("http://127.0.0.1:20129/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body });
        let t = ""; for await (const c of r.body) t += Buffer.from(c).toString();
        const content = (t.match(/"content"\s*:\s*"([^"]*)"/g) || []).map((s) => s.replace(/^.*"content"\s*:\s*"/, "").replace(/"$/, "")).join("");
        console.log(`  ${m.padEnd(14)} ${content.trim() ? "USABLE" : "dead"} ${((Date.now() - t0) / 1000).toFixed(1)}s http=${r.status} ${content.trim() ? "" : t.slice(0, 90)}`);
      } catch (e) { console.log(`  ${m.padEnd(14)} error ${e.message}`); }
    }
  }
})();
