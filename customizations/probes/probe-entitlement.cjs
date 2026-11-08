const D = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");
const db = new D("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
const key = db.prepare("select key from apiKeys where isActive=1 limit 1").get().key;
const idOf = (e) => db.prepare("select id from providerConnections where provider='qoder' and email=?").get(e).id;

async function call(model, pin, label, waitMs) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), waitMs);
  let status = "ABORT", txt = "";
  try {
    const r = await fetch("http://127.0.0.1:20128/v1/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "x-connection-id": pin },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: ENT" }] }),
    });
    status = r.status;
    for await (const c of r.body) txt += Buffer.from(c).toString();
    clearTimeout(timer);
  } catch { clearTimeout(timer); }
  const content = (txt.match(/"content"\s*:\s*"([^"]*)"/g) || []).map((s) => s.replace(/^.*"content"\s*:\s*"/, "").replace(/"$/, "")).join("");
  const msg = (/"message"\s*:\s*"([^"]{0,80})/.exec(txt) || [])[1] || "";
  console.log(`${label.padEnd(34)} http=${String(status).padEnd(6)} ${((Date.now() - t0) / 1000).toFixed(1)}s content="${content.slice(0, 10)}" ${msg}`);
}

(async () => {
  const ent = idOf("iamnonexist@gmail.com");
  const poor = idOf("hungpnm.bl@gmail.com");
  console.log("direct to :20128 with explicit pins (sticky patch active)\n");
  await call("qd/qfmodel", ent, "iamnonexist  x qfmodel", 30000);
  await call("qd/gfmodel", ent, "iamnonexist  x gfmodel", 45000);
  await call("qd/cmodel", ent, "iamnonexist  x cmodel", 45000);
  await call("qd/gfmodel", poor, "hungpnm.bl   x gfmodel (no plan)", 20000);
})();
