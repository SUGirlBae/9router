// Re-applies every local fix 9router 0.5.112 needs. Run after any `npm i -g 9router`.
// Usage: node reinstall-9router-fixes.js [installDir]
const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2] || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router";
const BUILD = path.join(ROOT, "app/.next-cli-build/server");
const LIB = path.join(ROOT, "app/open-sse/lib");
const HERE = __dirname;

const results = [];
function step(name, fn) { try { results.push([name, fn()]); } catch (e) { results.push([name, "ERROR: " + e.message]); } }

function patchFile(file, marker, needle, replacement) {
  let s = fs.readFileSync(file, "utf8");
  if (s.includes(marker)) return "already applied";
  const n = s.split(needle).length - 1;
  if (n !== 1) throw Error(`expected 1 occurrence, found ${n}`);
  const bak = file + ".pristine.bak";
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, s);
  fs.writeFileSync(file, s.replace(needle, replacement));
  return "patched";
}

// 1. Playwright loader: return a namespace that exposes CJS named exports
const HELPER = 'function __9rEsmNs(a){try{let b=a&&a.default;if(b&&"object"==typeof b){let c=Object.assign({},b);for(let d of Object.keys(a))if(void 0===c[d])try{c[d]=a[d]}catch{};c.default=b;return c}}catch{}return a}';
const ESM_OLD = "function r(a){return p.has(a)||p.set(a,q(a).finally(()=>p.delete(a))),p.get(a)}";
const ESM_NEW = HELPER + "function r(a){return p.has(a)||p.set(a,q(a).then(__9rEsmNs).finally(()=>p.delete(a))),p.get(a)}";
for (const f of ["6690.js", "8128.js"]) {
  const target = path.join(BUILD, "chunks", f);
  if (!fs.existsSync(target)) {
    step(`esmfix ${f}`, () => "skipped (not in bundle)");
    continue;
  }
  const text = fs.readFileSync(target, "utf8");
  if (!text.includes(ESM_OLD) && text.includes("r(await import(")) {
    step(`esmfix ${f}`, () => "native in upstream");
    continue;
  }
  step(`esmfix ${f}`, () => patchFile(target, "__9rEsmNs", ESM_OLD, ESM_NEW));
}

// 2. deepseek-web login: reject the logged-out localStorage placeholder
const TOK_OLD = 'validateToken:a=>{if("string"!=typeof a||!a.trim())return!1;try{let b=JSON.parse(a),c="string"==typeof b?.value?b.value:a;return"string"==typeof c&&c.length>=20}catch{return a.length>=20}}';
const TOK_NEW = 'validateToken:a=>{if("string"!=typeof a||!a.trim())return!1;let b;try{b=JSON.parse(a)}catch{return a.length>=20}if(b&&"object"==typeof b)return"string"==typeof b.value&&b.value.trim().length>=20;return a.length>=20}';
step("deepseek placeholder filter", () => patchFile(path.join(BUILD, "app/api/providers/web-login/route.js"), 'if(b&&"object"==typeof b)return"string"==typeof b.value', TOK_OLD, TOK_NEW));

// 3. deepseek-web models: allow model_type=vision
const VIS_OLD = '(k=(a||"").toLowerCase()).includes("pro")||k.includes("expert")?"expert":"default"';
const VIS_NEW = '(k=(a||"").toLowerCase()).includes("vision")?"vision":k.includes("pro")||k.includes("expert")?"expert":"default"';
step("vision model_type", () => patchFile(path.join(BUILD, "chunks/5330.js"), 'includes("vision")?"vision"', VIS_OLD, VIS_NEW));

// 4. the PoW solver module that was never published
step("deepseek-pow-hash.js", () => {
  const dest = path.join(LIB, "deepseek-pow-hash.js");
  if (fs.existsSync(dest)) return "already present";
  const src = path.join(HERE, "deepseek-pow-hash.js");
  if (!fs.existsSync(src)) throw Error("source module missing next to this script");
  fs.copyFileSync(src, dest);
  return "installed";
});
step("sha3_wasm_bg.wasm", () => {
  const dest = path.join(LIB, "sha3_wasm_bg.wasm");
  const src = path.join(HERE, "sha3_wasm_bg.wasm");
  if (!fs.existsSync(src)) throw Error("wasm missing next to this script");
  fs.copyFileSync(src, dest);
  return "installed (" + fs.statSync(dest).size + " bytes)";
});

for (const [name, r] of results) console.log(`${String(r).padEnd(18)} ${name}`);

// syntax gate
const { execFileSync } = require("child_process");
for (const f of ["chunks/6690.js", "chunks/8128.js", "chunks/5330.js", "app/api/providers/web-login/route.js"]) {
  const full = path.join(BUILD, f);
  if (fs.existsSync(full)) {
    execFileSync(process.execPath, ["--check", full], { stdio: "pipe" });
  }
}
console.log("\nall patched files parse OK");

// Patches kept in their own idempotent installers (each has --dry-run and writes a .bak).
// They are run here so one command restores everything after an npm update.
const extra = [
  ["qd model suffix strip", "patch-9r-qd-suffix.js"],
  ["deepseek hint surfacing", "patch-9r-ds-hint.js"],
  ["chat honours x-connection-id", "patch-9r-chat-pin.js"],
  ["pinned connection stays sticky", "patch-9r-pin-sticky.js"],
  ["DNS keeper injected into cli.js", "patch-9r-net-keeper.js"],
  ["muse-web direct executor (P5)", "reinstall-muse-executor.js"],
  ["qoduck 1M context + effort", "patch-9r-qoduck.js"],
  ["qwen-web provider", "patch-9r-qwen-web.js", ["--apply"]],
  ["kimi-web provider", "patch-9r-kimi-web.js", ["--apply"]],
  ["web-login map qwen/kimi", "patch-9r-weblogin-map.js", ["--apply"]],
  ["universal fetch models", "patch-9r-fetch-models.js", ["--apply"]],
  ["antigravity & codex model power", "patch-9r-model-power.js", ["--apply"]],
  ["antigravity dynamic anti-abuse & safe mitm shield", "patch-9r-antigravity-shield.js", ["--apply"]],
  ["dynamic latency-aware orchestrator & circuit breaker", "patch-9r-orchestrator.js", ["--apply"]],
];
console.log("");
for (const [label, script, args] of extra) {
  if (!fs.existsSync(path.join(HERE, script))) { console.log(`${"skipped".padEnd(18)} ${label} (${script} not found)`); continue; }
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, script), ...(args || [])], { encoding: "utf8" });
    const verdict = /PATCH/.test(out) ? "patched" : /NO MATCH|not found|ERROR/.test(out) ? "CHECK" : "ok";
    console.log(`${verdict.padEnd(18)} ${label}`);
    if (verdict === "CHECK") console.log(out.trim().split("\n").map((l) => "    " + l).join("\n"));
  } catch (e) { console.log(`${"ERROR".padEnd(18)} ${label}: ${(e.stderr || e.message || "").toString().split("\n")[0].slice(0, 140)}`); }
}
console.log("\n9router must be restarted for the chunk and cli.js patches to load");
