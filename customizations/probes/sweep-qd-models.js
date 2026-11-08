const Database = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");
const fs = require("fs");

const db = new Database("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
const key = db.prepare("select key from apiKeys where isActive=1 limit 1").get().key;

const STATIC = ["ultimate", "auto", "performance", "efficient", "lite", "qmodel_38max", "qmodel_latest", "qmodel",
  "qfmodel", "kmodel_latest", "kmodel", "gmodel", "gfmodel", "dmodel", "dfmodel", "mmodel", "smodel", "cmodel"];
const EXTRA = ["qoder/qfmodel", "glm-5.3", "deepseek-v4-flash", "kimi-k3", "minimax-m3", "qwen3.8-flash"];

async function call(model) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150000);
  try {
    const r = await fetch("http://127.0.0.1:20128/v1/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: OK" }] }),
    });
    const text = await r.text();
    let out = "";
    for (const l of text.split("\n")) {
      if (!l.startsWith("data: ") || l.slice(6) === "[DONE]") continue;
      try { out += JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || ""; } catch {}
    }
    let err = "";
    try { err = JSON.parse(text).error?.message || ""; } catch { const m = /"message":"([^"]{0,160})/.exec(text); if (m) err = m[1]; }
    return { http: r.status, ms: Date.now() - t0, content: out.trim(), err };
  } catch (e) {
    return { http: 0, ms: Date.now() - t0, content: "", err: e.name + ": " + e.message };
  } finally { clearTimeout(timer); }
}

(async () => {
  const rows = [];
  for (const id of STATIC) {
    const model = `qd/${id}`;
    const res = await call(model);
    const ok = res.http === 200 && res.content.length > 0;
    rows.push({ id, model, ok, ...res });
    console.log(`${ok ? "PASS" : "FAIL"} ${model.padEnd(24)} HTTP ${res.http} ${res.ms}ms content=${JSON.stringify(res.content.slice(0, 20))}${res.err ? " err=" + res.err.slice(0, 110) : ""}`);
  }
  console.log("\n--- extra names ---");
  for (const id of EXTRA) {
    const model = id.startsWith("qoder/") ? id : `qd/${id}`;
    const res = await call(model);
    const ok = res.http === 200 && res.content.length > 0;
    rows.push({ id, model, ok, ...res });
    console.log(`${ok ? "PASS" : "FAIL"} ${model.padEnd(28)} HTTP ${res.http} ${res.ms}ms content=${JSON.stringify(res.content.slice(0, 20))}${res.err ? " err=" + res.err.slice(0, 110) : ""}`);
  }
  fs.writeFileSync("C:/Users/Administrator/Documents/Qoder/2026-11-03/10707d32/qd-model-sweep.json", JSON.stringify(rows, null, 1));
  console.log(`\nPASS ${rows.filter((r) => r.ok).length}/${rows.length}`);
})();
