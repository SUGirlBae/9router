const fs = require("fs");
const path = require("path");

const rootIdx = process.argv.indexOf("--root");
const ROOT = process.env.NINEROUTER_ROOT || (rootIdx !== -1 && process.argv[rootIdx + 1]) || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router";
const CHUNK = path.join(ROOT, "app/.next-cli-build/server/chunks/5330.js");

// qoder resolves models by exact catalog key; a trailing effort tag like "qfmodel(high)"
// or "qfmodel[1m]" never matches, so strip every trailing tag before lookup. One combined
// pattern handles both forms and repeats, e.g. "dmodel(low)[1m]".
const OLD = 'let q=String(a||"").replace(/^qoder\\//,"")';
const NEW = 'let q=String(a||"").replace(/^qoder\\//,"").replace(/(?:\\([^)]*\\)|\\[[^\\]]*\\])+$/,"")';

let s = fs.readFileSync(CHUNK, "utf8");
if (s.includes(NEW)) { console.log("SKIP: already patched"); process.exit(0); }
if ((s.match(OLD) || []).length > 1) { console.error(`ABORT: the suffix strip is applied ${s.split(OLD).length - 1} times, fix by hand`); process.exit(1); }
const n = s.split(OLD).length - 1;
if (n !== 1) { console.error(`ABORT: expected 1 occurrence, found ${n}`); process.exit(1); }
const bak = CHUNK + ".pre-suffix.bak";
if (!fs.existsSync(bak)) fs.writeFileSync(bak, s);
fs.writeFileSync(CHUNK, s.replace(OLD, NEW));
console.log("PATCHED qoder model-suffix normalisation (backup:", bak + ")");

// unit check of the resulting rule
const rule = (a) => String(a || "").replace(/^qoder\//, "").replace(/\([^)]*\)$/, "").replace(/\[[^\]]*\]$/, "");
for (const m of ["qfmodel", "qfmodel(high)", "qoder/qfmodel(max)", "qfmodel[1m]", "ultimate(xhigh)", "dmodel(low)[1m]"]) {
  console.log(`  ${m.padEnd(24)} -> ${rule(m)}`);
}
