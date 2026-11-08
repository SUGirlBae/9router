// Read-only audit: which stored credential references a trycloudflare host?
// Never prints credential material — only host substrings, lengths and key names.
const Database = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");
const db = new Database("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });

const TABLES = db.prepare("select name from sqlite_master where type='table'").all().map(r => r.name);
console.log("tables:", TABLES.join(","));

function cols(t) {
  try { return db.prepare(`pragma table_info(${t})`).all().map(c => c.name); } catch { return []; }
}

const HOSTS = /https?:\/\/[A-Za-z0-9._-]+/g;
function hostsIn(s) {
  if (typeof s !== "string") return [];
  const out = new Set();
  for (const m of s.match(HOSTS) || []) out.add(m);
  return [...out];
}

console.log("\n--- providerConnections (qoder) ---");
const pcCols = cols("providerConnections");
console.log("cols:", pcCols.join(","));
const conns = db.prepare("select * from providerConnections where provider like '%qod%' or provider='qd'").all();
console.log("rows:", conns.length);
for (const c of conns) {
  const blob = JSON.stringify(c);
  const psd = c.providerSpecificData ? JSON.parse(c.providerSpecificData) : null;
  console.log(
    `${c.id.slice(0, 8)} ${String(c.name).padEnd(22)} prov=${c.provider} test=${c.testStatus} active=${c.isActive}` +
    ` keyLen=${(c.apiKey || "").length} psdKeys=${psd ? Object.keys(psd).join("|") : "-"} hosts=${JSON.stringify(hostsIn(blob))}` +
    ` hasTC=${/trycloudflare/.test(blob)}`
  );
}

console.log("\n--- providerNodes (all) ---");
const nodes = db.prepare("select * from providerNodes").all();
for (const n of nodes) {
  const blob = JSON.stringify(n);
  const data = n.data ? JSON.parse(n.data) : null;
  console.log(
    `${String(n.id).padEnd(46)} type=${n.type} name=${n.name} prefix=${data?.prefix} baseUrl=${data?.baseUrl} apiType=${data?.apiType} hasTC=${/trycloudflare/.test(blob)}`
  );
}

console.log("\n--- settings / apiKeys / any table holding the tunnel host ---");
const needle = process.argv[2] || "pst-storm-floating-friendly";
for (const t of TABLES) {
  const cs = cols(t);
  if (!cs.length) continue;
  const textCols = cs.filter((c) => /text|data|key|value|url|json|config|payload|blob/i.test(c));
  if (!textCols.length) continue;
  let n = 0;
  try { n = db.prepare(`select count(*) c from ${t}`).get().c; } catch { continue; }
  if (n > 200000) { console.log(`  (skip ${t}: ${n} rows)`); continue; }
  const where = textCols.map((c) => `cast(${c} as text) like ?`).join(" or ");
  const like = `%${needle}%`;
  try {
    const hits = db.prepare(`select count(*) c from ${t} where ${where}`).get(...textCols.map(() => like)).c;
    if (hits) console.log(`  ${t}: ${hits} rows mention "${needle}" in [${textCols.join(",")}] of ${n}`);
  } catch (e) { /* non-text col */ }
}
