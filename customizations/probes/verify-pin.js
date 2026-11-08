const D = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");
const db = new D("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
const key = db.prepare("select key from apiKeys where isActive=1 limit 1").get().key;
const conns = db.prepare("select id,email from providerConnections where provider='qoder' and isActive=1 order by priority").all();

async function call(model, pinId) {
  const t0 = Date.now(); const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  if (pinId) headers["x-connection-id"] = pinId;
  try {
    const r = await fetch("http://127.0.0.1:20128/v1/chat/completions", { method: "POST", signal: ctrl.signal, headers,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: PIN" }] }) });
    let t = ""; for await (const c of r.body) t += Buffer.from(c).toString();
    clearTimeout(timer);
    const content = (t.match(/"content"\s*:\s*"([^"]*)"/g) || []).map((s) => s.replace(/^.*"content"\s*:\s*"/, "").replace(/"$/, "")).join("");
    const err = (/"message"\s*:\s*"([^"]{0,90})/.exec(t) || [])[1] || "";
    const row = db.prepare("select connectionId from requestDetails where provider='qoder' order by id desc limit 1").get();
    return { status: r.status, ms: Date.now() - t0, ok: !!content.trim(), content: content.slice(0, 12), err };
  } catch (e) { clearTimeout(timer); return { status: "ABORT", ms: Date.now() - t0, ok: false, err: "stalled/aborted" }; }
}

(async () => {
  for (const c of conns) {
    const r = await call("qd/gfmodel", c.id);
    console.log(`pin=${c.email.padEnd(30)} ${r.ok ? "SERVES " : "rejects"} http=${r.status} ${(r.ms / 1000).toFixed(1)}s ${r.content || r.err}`);
  }
  const none = await call("qd/gfmodel", null);
  console.log(`no pin (router rotates)              ${none.ok ? "SERVES " : "rejects"} http=${none.status} ${(none.ms / 1000).toFixed(1)}s ${none.content || none.err}`);
})();
