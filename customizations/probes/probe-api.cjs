const D = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");
const db = new D("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
const key = db.prepare("select key from apiKeys where isActive=1 limit 1").get().key;
const idOf = (email) => db.prepare("select id from providerConnections where email=?").get(email).id;

async function hit(method, path, body) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch("http://127.0.0.1:20128" + path, {
      method, signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: method === "POST" ? (body || "{}") : undefined,
    });
    let t = ""; for await (const c of r.body) t += Buffer.from(c).toString();
    clearTimeout(timer);
    return { status: r.status, ms: Date.now() - t0, body: t };
  } catch (e) { clearTimeout(timer); return { status: "ERR", ms: Date.now() - t0, body: (e.cause?.message || e.message || "").slice(0, 80) }; }
}

(async () => {
  for (const email of ["iamnonexist@gmail.com", "hungpnm.bl@gmail.com"]) {
    const id = idOf(email);
    console.log(`\n### ${email}`);
    const g = await hit("GET", `/api/providers/${id}/models`);
    console.log(`  GET  models        ${g.status} ${(g.ms / 1000).toFixed(1)}s ${g.body.replace(/\s+/g, " ").slice(0, 260)}`);
    const t = await hit("POST", `/api/providers/${id}/test-models`, JSON.stringify({ models: ["gfmodel", "qfmodel", "cmodel"] }));
    console.log(`  POST test-models   ${t.status} ${(t.ms / 1000).toFixed(1)}s ${t.body.replace(/\s+/g, " ").slice(0, 260)}`);
  }
  const inv = await hit("GET", "/api/providers");
  console.log(`\nGET /api/providers -> ${inv.status} ${inv.body.slice(0, 160)}`);
})();
