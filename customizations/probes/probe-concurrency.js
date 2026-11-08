const Database = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");
const db = new Database("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
const key = db.prepare("select key from apiKeys where isActive=1 limit 1").get().key;

const MODEL = process.argv[2] || "qd/qfmodel";
const N = Number(process.argv[3] || 6);
const T0 = Date.now();

function stamp() { return ((Date.now() - T0) / 1000).toFixed(2).padStart(7); }

async function one(i) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let status = "?", text = "", err = "";
  try {
    const r = await fetch("http://127.0.0.1:20128/v1/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: `Reply with exactly: P${i}` }],
      }),
    });
    status = r.status;
    const body = await r.text();
    if (status === 200) {
      const m = /"content"\s*:\s*"([^"]*)/.exec(body);
      text = m ? m[1].slice(0, 24) : "";
      if (!text) err = "EMPTY";
    } else {
      err = body.slice(0, 90).replace(/\s+/g, " ");
    }
  } catch (e) { err = (e.cause?.message || e.message).slice(0, 90); }
  finally { clearTimeout(timer); }
  return { i, start: t0 - T0, dur: Date.now() - t0, status, text, err };
}

(async () => {
  console.log(`model=${MODEL} N=${N} — firing all simultaneously\n`);
  const all = await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
  all.sort((a, b) => a.start - b.start);
  for (const r of all)
    console.log(`#${r.i} start=${(r.start/1000).toFixed(2)}s dur=${(r.dur/1000).toFixed(2)}s http=${r.status} content="${r.text}" ${r.err}`);

  const starts = all.map(r => r.start), ends = all.map(r => r.start + r.dur);
  const wall = Math.max(...ends) - Math.min(...starts);
  const sum = all.reduce((a, r) => a + r.dur, 0);
  const maxdur = Math.max(...all.map(r => r.dur));
  const ok = all.filter(r => r.status === 200 && r.text).length;
  // does any request finish AFTER a later one starts? => true overlap
  let overlaps = 0;
  for (let a = 0; a < all.length; a++)
    for (let b = a + 1; b < all.length; b++)
      if (ends[a] > starts[b] + 50 && ends[b] > starts[a] + 50) overlaps++;
  console.log(`\nOK=${ok}/${N}  wall=${(wall/1000).toFixed(1)}s  sum(serial-equivalent)=${(sum/1000).toFixed(1)}s  slowest=${(maxdur/1000).toFixed(1)}s  overlapping-pairs=${overlaps}`);
  console.log(`speedup vs serial = ${(sum / wall).toFixed(2)}x   (1.0x => fully serialized, ${N}.0x => fully parallel)`);
})();
