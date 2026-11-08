const Database = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");
const db = new Database("C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
const key = db.prepare("select key from apiKeys where isActive=1 limit 1").get().key;

const MODEL = process.argv[2] || "qd/qfmodel";
const N = Number(process.argv[3] || 4);
const STALL = Number(process.argv[4] || 60000);   // abort if no chunk for this long
const T0 = Date.now();

function parseSSE(txt) {
  let content = "", reasoning = "", first = 0, last = 0, n = 0, i = 0;
  for (const line of txt.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const p = s.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    try {
      const j = JSON.parse(p);
      const d = j.choices?.[0]?.delta ?? {};
      const frag = (d.content || "") + (d.reasoning_content || "");
      if (frag && n === 0) first = i;
      if (frag) last = i;
      content += d.content || ""; reasoning += d.reasoning_content || ""; n += frag.length;
    } catch {}
    i++;
  }
  return { content, reasoning, chars: n, firstTok: first, lastTok: last, frames: i };
}

async function one(idx) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  let stallTimer;
  const armStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => ctrl.abort(), STALL); };
  armStall();
  let status = "HANG", raw = "", err = "";
  const p = { idx, start: t0 - T0 };
  try {
    const r = await fetch("http://127.0.0.1:20128/v1/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: `Reply with exactly: P${idx}` }] }),
    });
    status = r.status;
    p.ttfb = Date.now() - t0;                       // headers received
    const chunks = [];
    for await (const c of r.body) { armStall(); chunks.push(Buffer.from(c)); }
    clearTimeout(stallTimer);
    raw = Buffer.concat(chunks).toString("utf8");
    p.frames = (raw.match(/^data:/gm) || []).length;
  } catch (e) { clearTimeout(stallTimer); err = "STALL/" + (e.cause?.message || e.message).slice(0, 40); }
  p.dur = Date.now() - t0; p.status = status; p.raw = raw; p.err = err;
  return p;
}

(async () => {
  console.log(`=== ${MODEL}  N=${N} concurrent  (stall abort ${STALL/1000}s) ===`);
  const all = await Promise.all(Array.from({ length: N }, (_, i) => one(i)));
  all.sort((a, b) => a.start - b.start);
  for (const r of all) {
    const s = parseSSE(r.raw || "");
    const tag = s.content.trim() ? "OK" : (s.reasoning.trim() ? "REASON-ONLY" : "EMPTY");
    console.log(`#${r.idx} start=${(r.start/1000).toFixed(2)}s ttfb=${((r.ttfb||0)/1000).toFixed(2)}s dur=${(r.dur/1000).toFixed(2)}s http=${r.status} frames=${r.frames||0} ${tag} ` +
      `content="${(s.content||"").replace(/\s+/g," ").slice(0,22)}" rsn=${s.reasoning.length}c ${r.err}`);
  }
  const good = all.filter(r => parseSSE(r.raw || "").content.trim());
  const starts = all.map(r => r.start), ends = all.map(r => r.start + r.dur);
  const wall = Math.max(...ends), sum = all.reduce((a, r) => a + r.dur, 0);
  const maxd = Math.max(...all.map(r => r.dur));
  let ov = 0;
  for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++)
    if (ends[a] > starts[b] + 100 && ends[b] > starts[a] + 100) ov++;
  console.log(`\nOK=${good.length}/${N}  wall=${(wall/1000).toFixed(1)}s  serial-equivalent=${(sum/1000).toFixed(1)}s  slowest=${(maxd/1000).toFixed(1)}s  overlapping-pairs=${ov}/${N*(N-1)/2}`);
  console.log(`throughput ratio = ${(sum / wall).toFixed(2)}x   (~1.0 => serialized, ~${N} => fully parallel)`);
})();
