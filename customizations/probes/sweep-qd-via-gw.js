const D = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");
const db = new D("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
const key = db.prepare("select key from apiKeys where isActive=1 limit 1").get().key;
const PORT = Number(process.env.GW || 20138);
const MODELS = ["qfmodel", "auto", "ultimate", "efficient", "performance", "lite", "qmodel", "qmodel_latest", "qmodel_38max",
  "kmodel", "kmodel_latest", "gmodel", "gfmodel", "dmodel", "dfmodel", "mmodel", "smodel", "cmodel"];
const MSG_RE = /"message"\s*:\s*"([^"]{0,120})/;

async function one(m) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "qd/" + m, messages: [{ role: "user", content: "Reply with exactly: OK" }] }),
    });
    let t = ""; for await (const c of r.body) t += Buffer.from(c).toString();
    clearTimeout(timer);
    const content = (t.match(/"content"\s*:\s*"([^"]*)"/g) || []).map((s) => s.replace(/^.*"content"\s*:\s*"/, "").replace(/"$/, "")).join("");
    const why = (MSG_RE.exec(t) || [])[1] || "";
    return { m, ok: !!content.trim(), status: r.status, ms: Date.now() - t0, why };
  } catch (e) {
    clearTimeout(timer);
    return { m, ok: false, status: "TIMEOUT", ms: Date.now() - t0, why: "aborted" };
  }
}

(async () => {
  console.log(`sweep ${MODELS.length} qd models via gateway :${PORT} (fail-fast)\n`);
  const usable = [];
  for (const m of MODELS) {
    const r = await one(m);
    if (r.ok) usable.push(m);
    console.log(`${r.ok ? "USABLE" : "  dead"}  qd/${m.padEnd(15)} ${(r.ms / 1000).toFixed(1)}s http=${r.status} ${r.why.slice(0, 96)}`);
    await new Promise((a) => setTimeout(a, 600));
  }
  console.log(`\nUSABLE (${usable.length}): ${usable.map((x) => "qd/" + x).join(", ") || "none"}`);
})();
