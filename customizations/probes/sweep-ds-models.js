const Database = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");

const db = new Database("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
const key = db.prepare("select key from apiKeys where isActive=1 limit 1").get().key;

const DECLARED = [
  "deepseek-v4-pro", "deepseek-v4-pro-think", "deepseek-v4-pro-search", "deepseek-v4-pro-think-search",
  "deepseek-v4-flash", "deepseek-v4-flash-think", "deepseek-v4-flash-search", "deepseek-v4-flash-think-search",
  "deepseek-chat", "deepseek-reasoner", "DeepSeek-R1", "DeepSeek-R1-Search", "DeepSeek-V3.2", "DeepSeek-Search",
];
const EXTRA = ["DeepSeek-V4.1-Flash-1017", "DeepSeek-V4-Pro", "deepseek-flash", "deepseek-v4-expert", "deepseek-web-default"];

// 9router's own normalization rule, read out of chunks/5330.js
function mapModel(name) {
  const k = (name || "").toLowerCase();
  return {
    model_type: k.includes("pro") || k.includes("expert") ? "expert" : "default",
    thinking: k.includes("r1") || k.includes("think") || k.includes("reason"),
    search: k.includes("search"),
  };
}

async function call(model) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch("http://127.0.0.1:20128/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
      body: JSON.stringify({ model: "deepseek-web/" + model, messages: [{ role: "user", content: "Reply with exactly: OK-" + model }] }),
    });
    const text = await r.text();
    let out = "";
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
      try { const j = JSON.parse(line.slice(6)); out += j.choices?.[0]?.delta?.content || ""; } catch {}
    }
    const err = /"error"/.test(text) ? text.slice(text.indexOf('"error"'), text.indexOf('"error"') + 160) : "";
    return { http: r.status, ms: Date.now() - t0, content: out.trim(), err };
  } catch (e) {
    return { http: 0, ms: Date.now() - t0, content: "", err: e.name + ": " + e.message };
  } finally { clearTimeout(timer); }
}

(async () => {
  const rows = [];
  for (const [group, list] of [["declared", DECLARED], ["extra", EXTRA]]) {
    for (const m of list) {
      const res = await call(m);
      const ok = res.http === 200 && res.content.length > 0;
      const mp = mapModel(m);
      rows.push({ group, model: m, ...mp, ok, http: res.http, ms: res.ms, content: res.content.slice(0, 40), err: res.err.slice(0, 120) });
      console.log(`${ok ? "PASS" : "FAIL"} ${m.padEnd(28)} ${String(mp.model_type).padEnd(8)} think=${mp.thinking ? 1 : 0} search=${mp.search ? 1 : 0} ${res.ms}ms ${JSON.stringify(res.content.slice(0, 30))} ${res.err ? "| " + res.err.slice(0, 90) : ""}`);
    }
  }
  require("fs").writeFileSync("C:/Users/Administrator/Documents/Qoder/2026-11-03/10707d32/ds-model-sweep.json", JSON.stringify(rows, null, 1));
  console.log(`\nPASS ${rows.filter((r) => r.ok).length}/${rows.length}`);
})();
