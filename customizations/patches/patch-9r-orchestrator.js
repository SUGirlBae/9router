// Idempotent patch installer for 9router Dynamic Latency-Aware Orchestrator & Circuit Breaker
//
// Features:
//  - Exponential Moving Average (EMA) TTFT latency tracking in memory (zero SQLite lock overhead)
//  - Smart Circuit Breaker (auto-cooldown after 3 consecutive failures, half-open recovery, fail-open)
//  - Supports "least-latency" / "fastest" routing strategy and latency-aware round-robin tie-breaking
//
// Usage: node patch-9r-orchestrator.js [--apply] [--dry-run] [--revert] [--root <dir>]

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DRY_RUN = process.argv.includes("--dry-run");
const REVERT = process.argv.includes("--revert");

function getArg(name, def) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : def;
}

const DEFAULT_ROOT = fs.existsSync("D:/9router/app/.next-cli-build")
  ? "D:/9router"
  : "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router";

const ROOT = getArg("--root", DEFAULT_ROOT);
const BUILD_SERVER = path.join(ROOT, "app/.next-cli-build/server");

console.log(`[patch-9r-orchestrator] Root: ${ROOT}`);
console.log(`[patch-9r-orchestrator] Mode: ${REVERT ? "REVERT" : DRY_RUN ? "DRY-RUN" : "APPLY"}`);

if (REVERT) {
  for (const dir of [BUILD_SERVER, path.join(BUILD_SERVER, "chunks")]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".pre-orch.bak")) {
        const orig = path.join(dir, f.slice(0, -".pre-orch.bak".length));
        fs.copyFileSync(path.join(dir, f), orig);
        console.log(`[RESTORED] ${orig}`);
      }
    }
  }
  process.exit(0);
}

let patchedCount = 0;
const patchedFiles = new Set();

function patchFile(filePath, marker, needle, replacement) {
  if (!fs.existsSync(filePath)) return;
  let s = fs.readFileSync(filePath, "utf8");
  if (s.includes(marker)) return;

  const matches = s.split(needle).length - 1;
  if (matches === 0) return;
  if (matches !== 1) throw new Error(`expected exactly one match for ${marker}, found ${matches} in ${filePath}`);
  const next = s.replace(needle, replacement);
  if (next === s) return;

  if (!DRY_RUN) {
    const bak = filePath + ".pre-orch.bak";
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, s);
    fs.writeFileSync(filePath, next);
  }
  console.log(`[PATCHED] ${path.relative(ROOT, filePath)} (${marker.slice(0, 36)})`);
  patchedCount++;
  patchedFiles.add(filePath);
}

// 1. Inject Orchestrator & Circuit Breaker into chunk 238.js (auth.js)
const ORCH_INIT_OLD = ',j=c(7803);let k=Promise.resolve();';
const ORCH_INIT_NEW = ',j=c(7803);let k=Promise.resolve();const _orch=new Map();function _recSucc(id,ms){if(!id||"noauth"===id)return;let e=_orch.get(id)||{emaMs:null,fails:0,openUntil:0};if("number"==typeof ms&&ms>=0)e.emaMs=null===e.emaMs?ms:Math.round(.7*e.emaMs+.3*ms);e.fails=0,e.openUntil=0,_orch.set(id,e)}function _recFail(id){if(!id||"noauth"===id)return;let e=_orch.get(id)||{emaMs:null,fails:0,openUntil:0};e.fails++,e.fails>=3&&(e.openUntil=Date.now()+Math.min(3e4*2**Math.min(e.fails-3,4),3e5)),_orch.set(id,e)}function _isOpen(id){let e=_orch.get(id);return!!e&&e.openUntil>Date.now()}function _score(c){let e=_orch.get(c?.id);return e?(e.emaMs??1e3)+2e3*e.fails:1e3}';

const STRAT_OLD = 'let s=await (0,d.mt)(),t=(s.providerStrategies||{})[g]||{},u=t.fallbackStrategy||s.fallbackStrategy||"fill-first";if(o&&(b=k.find(a=>a.id===o))&&j.info("AUTH",`${a} | pinned to ${b.id?.slice(0,8)} (${b.name||b.email||"unnamed"})`),b);else if("round-robin"===u){let a=t.stickyRoundRobinLimit||s.stickyRoundRobinLimit||3,c=[...r].sort((a,b)=>a.lastUsedAt||b.lastUsedAt?a.lastUsedAt?b.lastUsedAt?new Date(b.lastUsedAt)-new Date(a.lastUsedAt):-1:1:(a.priority||999)-(b.priority||999))[0],e=c?.consecutiveUseCount||0;c&&c.lastUsedAt&&e<a?(b=c,await (0,d.updateProviderConnection)(b.id,{lastUsedAt:new Date().toISOString(),consecutiveUseCount:(b.consecutiveUseCount||0)+1})):(b=[...r].sort((a,b)=>a.lastUsedAt||b.lastUsedAt?a.lastUsedAt?b.lastUsedAt?new Date(a.lastUsedAt)-new Date(b.lastUsedAt):1:-1:(a.priority||999)-(b.priority||999))[0],await (0,d.updateProviderConnection)(b.id,{lastUsedAt:new Date().toISOString(),consecutiveUseCount:1}))}else b=r[0];';
const STRAT_NEW = 'let s=await (0,d.mt)(),t=(s.providerStrategies||{})[g]||{},u=t.fallbackStrategy||s.fallbackStrategy||"fill-first",_hc=r.filter(a=>!_isOpen(a.id)),_pool=_hc.length>0?_hc:r;if(o&&(b=k.find(a=>a.id===o))&&j.info("AUTH",`${a} | pinned to ${b.id?.slice(0,8)} (${b.name||b.email||"unnamed"})`),b);else if("least-latency"===u||"fastest"===u){b=[..._pool].sort((a,b)=>_score(a)-_score(b)||(a.priority||999)-(b.priority||999))[0],await (0,d.updateProviderConnection)(b.id,{lastUsedAt:new Date().toISOString(),consecutiveUseCount:(b.consecutiveUseCount||0)+1})}else if("round-robin"===u){let a=t.stickyRoundRobinLimit||s.stickyRoundRobinLimit||3,c=[..._pool].sort((a,b)=>a.lastUsedAt||b.lastUsedAt?a.lastUsedAt?b.lastUsedAt?new Date(b.lastUsedAt)-new Date(a.lastUsedAt):-1:1:_score(a)-_score(b))[0],e=c?.consecutiveUseCount||0;c&&c.lastUsedAt&&e<a?(b=c,await (0,d.updateProviderConnection)(b.id,{lastUsedAt:new Date().toISOString(),consecutiveUseCount:(b.consecutiveUseCount||0)+1})):(b=[..._pool].sort((a,b)=>a.lastUsedAt||b.lastUsedAt?a.lastUsedAt?b.lastUsedAt?new Date(a.lastUsedAt)-new Date(b.lastUsedAt):1:-1:_score(a)-_score(b))[0],await (0,d.updateProviderConnection)(b.id,{lastUsedAt:new Date().toISOString(),consecutiveUseCount:1}))}else b=_pool[0];';

const FAIL_OLD = ',!l)return{shouldFallback:!1,cooldownMs:0};let s="string"==typeof c?c.slice(0,200):"Provider error"';
const FAIL_NEW = ',!l)return{shouldFallback:!1,cooldownMs:0};_recFail(a);let s="string"==typeof c?c.slice(0,200):"Provider error"';

const SUCC_OLD = 'async function n(a,b,c=null){if(!a||"noauth"===a)return;let e=b._connection||b';
const SUCC_NEW = 'async function n(a,b,c=null,l=null){if(!a||"noauth"===a)return;_recSucc(a,l);let e=b._connection||b';

for (const dir of [BUILD_SERVER, path.join(BUILD_SERVER, "chunks")]) {
  const f = path.join(dir, "238.js");
  patchFile(f, 'function _recSucc(', ORCH_INIT_OLD, ORCH_INIT_NEW);
  patchFile(f, '"least-latency"===u', STRAT_OLD, STRAT_NEW);
  patchFile(f, '_recFail(a);let s=', FAIL_OLD, FAIL_NEW);
  patchFile(f, '_recSucc(a,l);let e=', SUCC_OLD, SUCC_NEW);
}

// 2. Pass TTFT latency in 9489.js (chat.js)
const CHAT_START_OLD = 'let p=await (0,h.mt)(),q=(p.providerThinking||{})[B]||null,u=await (0,j.wk)(';
const CHAT_START_NEW = 'let p=await (0,h.mt)(),q=(p.providerThinking||{})[B]||null,_t0=Date.now(),u=await (0,j.wk)(';

const CHAT_SUCC_OLD = 'onRequestSuccess:async()=>{await (0,f.Pt)(b.connectionId,b,C),(0,g.vO)(b.connectionId,C)}';
const CHAT_SUCC_NEW = 'onRequestSuccess:async()=>{await (0,f.Pt)(b.connectionId,b,C,Date.now()-_t0),(0,g.vO)(b.connectionId,C)}';

for (const dir of [BUILD_SERVER, path.join(BUILD_SERVER, "chunks")]) {
  const f = path.join(dir, "9489.js");
  patchFile(f, '_t0=Date.now(),u=await', CHAT_START_OLD, CHAT_START_NEW);
  patchFile(f, 'Date.now()-_t0)', CHAT_SUCC_OLD, CHAT_SUCC_NEW);
}

if (!DRY_RUN && patchedFiles.size > 0) {
  console.log("\nVerifying syntax with node --check...");
  for (const f of patchedFiles) {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    console.log(`[SYNTAX OK] ${path.relative(ROOT, f)}`);
  }
}

console.log(`\n[patch-9r-orchestrator] Complete. Patched ${patchedCount} operations across ${patchedFiles.size} files.`);
