// Idempotent patch installer for 9router Antigravity Anti-Abuse & Safe MITM Shield
// Upgrades Google Antigravity protocol to 2.31.1 (cl=1012564305), strips X-Client-Version,
// injects Telemetry Sinkhole into MITM server, and neutralizes Windows Registry setx.
//
// Usage: node patch-9r-antigravity-shield.js [--apply] [--dry-run] [--revert] [--root <dir>]

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
const BUILD_STATIC = path.join(ROOT, "app/.next-cli-build/static");
const MITM_SERVER = path.join(ROOT, "app/src/mitm/server.js");

console.log(`[patch-9r-antigravity-shield] Root: ${ROOT}`);
console.log(`[patch-9r-antigravity-shield] Mode: ${REVERT ? "REVERT" : DRY_RUN ? "DRY-RUN" : "APPLY"}`);

if (REVERT) {
  console.log("Reverting files from .pre-agshield.bak...");
  for (const dir of [BUILD_SERVER, BUILD_STATIC, path.dirname(MITM_SERVER)]) {
    function scan(d) {
      if (!fs.existsSync(d)) return;
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) scan(p);
        else if (f.endsWith(".pre-agshield.bak")) {
          const orig = p.slice(0, -".pre-agshield.bak".length);
          fs.copyFileSync(p, orig);
          console.log(`[RESTORED] ${orig}`);
        }
      }
    }
    scan(dir);
  }
  process.exit(0);
}

let patchedCount = 0;
const patchedFiles = new Set();

function countMatches(source, needle) {
  if (needle instanceof RegExp) {
    const flags = needle.flags.includes("g") ? needle.flags : `${needle.flags}g`;
    return [...source.matchAll(new RegExp(needle.source, flags))].length;
  }
  return source.split(needle).length - 1;
}

function patchFile(filePath, marker, needle, replacement, expectedMatches = 1) {
  if (!fs.existsSync(filePath)) return;
  let s = fs.readFileSync(filePath, "utf8");
  if (s.includes(marker)) return;

  const matches = countMatches(s, needle);
  if (matches === 0) return;
  if (matches !== expectedMatches) {
    const expectedLabel = expectedMatches === 1 ? "one" : String(expectedMatches);
    throw new Error(`expected exactly ${expectedLabel} match${expectedMatches === 1 ? "" : "es"} for ${marker}, found ${matches} in ${filePath}`);
  }

  const next = expectedMatches === 1
    ? s.replace(needle, replacement)
    : (needle instanceof RegExp ? s.replace(needle, replacement) : s.replaceAll(needle, replacement));
  if (next === s) return;

  if (!DRY_RUN) {
    const bak = filePath + ".pre-agshield.bak";
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, s);
    fs.writeFileSync(filePath, next);
  }
  console.log(`[PATCHED] ${path.relative(ROOT, filePath)} (${marker.slice(0, 40)})`);
  patchedCount++;
  patchedFiles.add(filePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. MITM SERVER: Telemetry Sinkhole + Version Upgrade to 2.31.1
// ─────────────────────────────────────────────────────────────────────────────

const SINKHOLE_MARKER = '((e.headers?.host||"")+(e.url||"")).includes(p)';
const SINKHOLE_NEEDLE = 'let r=vu(e.headers.host);';
const SINKHOLE_NEEDLE_PREV = 'if(["recordCodeAssistMetrics","recordTrajectoryAnalytics","fetchAdminControls","listExperiments","play.googleapis.com/log","feedback-pa.googleapis.com"].some(p=>(e.url||"").includes(p))){t.writeHead(200,{"Content-Type":"application/json","x-9router-sinkhole":"absorbed"});t.end(JSON.stringify({status:"OK",response:{}}));return}let r=vu(e.headers.host);';
const SINKHOLE_REPL = 'if(["recordCodeAssistMetrics","recordTrajectoryAnalytics","fetchAdminControls","listExperiments","play.googleapis.com","feedback-pa.googleapis.com","/log"].some(p=>((e.headers?.host||"")+(e.url||"")).includes(p))){t.writeHead(200,{"Content-Type":"application/json","x-9router-sinkhole":"absorbed"});t.end(JSON.stringify({status:"OK",response:{}}));return}let r=vu(e.headers.host);';

const OLD_MITM_UA = 'function No(e,t){return typeof e!="string"||!e.includes("antigravity/")?e:e.replace(/antigravity\\/[^\\s]+/,`antigravity/${t}`)}';
const NEW_MITM_UA = 'function No(e,t){return typeof e!="string"||!e.includes("antigravity/")?e:e.includes("antigravity/hub/")?e.replace(/antigravity\\/hub\\/[^\\s()]+/,`antigravity/hub/${t}`):e.replace(/antigravity\\/[^\\s()]+/,`antigravity/${t}`)}';

patchFile(MITM_SERVER, SINKHOLE_MARKER, SINKHOLE_NEEDLE_PREV, SINKHOLE_REPL);
patchFile(MITM_SERVER, SINKHOLE_MARKER, SINKHOLE_NEEDLE, SINKHOLE_REPL);
patchFile(MITM_SERVER, 'e.includes("antigravity/hub/")', OLD_MITM_UA, NEW_MITM_UA);
patchFile(MITM_SERVER, 'er="2.31.1";', 'var er="2.24.0";', 'var er="2.31.1";');
patchFile(MITM_SERVER, 'er="2.31.1";', 'var er="2.29.1";', 'var er="2.31.1";');
patchFile(MITM_SERVER, 'er="2.31.1";', 'var er="2.31.0";', 'var er="2.31.1";');

// ─────────────────────────────────────────────────────────────────────────────
// 2. CHUNKS 915.js: Neutralize Windows Registry setx NODE_EXTRA_CA_CERTS
// ─────────────────────────────────────────────────────────────────────────────

const OLD_SETX = 'd(`setx NODE_EXTRA_CA_CERTS "${a}"`';
const NEW_SETX = 'd(`echo skip-setx`';

for (const dir of [BUILD_SERVER, path.join(BUILD_SERVER, "chunks")]) {
  const f = path.join(dir, "915.js");
  patchFile(f, 'd(`echo skip-setx`', OLD_SETX, NEW_SETX);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CHUNK 2380.js: Strip X-Client-Version & Force Canonical 2.31.1 User-Agent
// ─────────────────────────────────────────────────────────────────────────────

const AG_HEADERS_RE = /"User-Agent":this\.config\.headers\?\.\["User-Agent"\]\|\|h\.K\["User-Agent"\],"X-Client-Version":process\.env\.ANTIGRAVITY_VERSION\|\|"2\.[0-9.]+"/g;
const AG_HEADERS_REPL = '"User-Agent":`antigravity/hub/2.31.1 (os_type=${process.platform==="win32"?"windows":process.platform==="darwin"?"darwin":"linux"}; arch=${process.arch==="x64"?"amd64":process.arch==="arm64"?"arm64":"386"}; cl=1012564305; auth_method=oauth; datacollection_opt_in=false)`';

const OLD_UA_PRECEDENCE = '"User-Agent":this.config.headers?.["User-Agent"]||`antigravity/hub/2.31.1';
const NEW_UA_PRECEDENCE = '"User-Agent":`antigravity/hub/2.31.1';

const OLD_REQ_ID_FN = 'function w({body:a,request:b,credentials:c,model:d,requestType:e}){if(o.test(a?.requestId||""))return a.requestId;let f=b?.sessionId||a?.request?.sessionId||c?._clientSessionId||c?.connectionId||c?.email||"anonymous",g=v(`antigravity:conversation:${f}`),h=v(`antigravity:trajectory:${f}:${d}:${e}`),i=Math.max(1,2*(Array.isArray(b?.contents)?b.contents.length:1)-1);return`agent/${g}/${Date.now()}/${h}/${i}`}';
const NEW_REQ_ID_FN = 'function w({body:a,request:b,credentials:c,model:d,requestType:e}){let _ak=c?.email||c?.connectionId||c?.id||"";if(o.test(a?.requestId||"")&&!_ak)return a.requestId;let f=b?.sessionId||a?.request?.sessionId||c?._clientSessionId||_ak||"anonymous",g=v(`antigravity:conversation:${_ak}:${f}`),h=v(`antigravity:trajectory:${_ak}:${f}:${d}:${e}`),i=Math.max(1,2*(Array.isArray(b?.contents)?b.contents.length:1)-1);return`agent/${g}/${Date.now()}/${h}/${i}`}';

const OLD_SESSION_ID_SCOPING = 'let f=b.request?.sessionId||(0,j.oV)({headers:d?.rawHeaders,body:b,connectionId:d?.email||d?.connectionId,scope:"antigravity"}),g=(0,j.E9)(f)||f';
const NEW_SESSION_ID_SCOPING = 'let _ak=d?.email||d?.connectionId||d?.id||"",f=b.request?.sessionId||(0,j.oV)({headers:d?.rawHeaders,body:b,connectionId:_ak,scope:"antigravity"}),_sf=_ak?`${_ak}:${f}`:f,g=(0,j.E9)(_sf)||f';

for (const dir of [BUILD_SERVER, path.join(BUILD_SERVER, "chunks")]) {
  const f = path.join(dir, "2380.js");
  patchFile(f, '"User-Agent":`antigravity/hub/2.31.1', OLD_UA_PRECEDENCE, NEW_UA_PRECEDENCE);
  patchFile(f, '"User-Agent":`antigravity/hub/2.31.1', AG_HEADERS_RE, AG_HEADERS_REPL);
  patchFile(f, 'antigravity:conversation:${_ak}:${f}', OLD_REQ_ID_FN, NEW_REQ_ID_FN);
  patchFile(f, '_sf=_ak?`${_ak}:${f}`:f', OLD_SESSION_ID_SCOPING, NEW_SESSION_ID_SCOPING);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. CHUNKS 2598, 4480, 8499, 8896: Update shared ANTIGRAVITY_IDE_VERSION to 2.31.1
//    and replace space-delimited UA with canonical (%s) format
// ─────────────────────────────────────────────────────────────────────────────

const OLD_UA_TEMPLATE_RE = /`antigravity\/hub\/\$\{[^}]+\}\s+\$\{process\.platform===[\s\S]*?process\.arch\}`/g;
const NEW_UA_TEMPLATE = '`antigravity/hub/2.31.1 (os_type=${process.platform==="win32"?"windows":process.platform==="darwin"?"darwin":"linux"}; arch=${process.arch==="x64"?"amd64":process.arch==="arm64"?"arm64":"386"}; cl=1012564305; auth_method=oauth; datacollection_opt_in=false)`';

for (const dir of [BUILD_SERVER, path.join(BUILD_SERVER, "chunks")]) {
  for (const f of ["2598.js", "4480.js", "8499.js", "8896.js"]) {
    const full = path.join(dir, f);
    patchFile(full, 'cl=1012564305; auth_method=oauth', OLD_UA_TEMPLATE_RE, NEW_UA_TEMPLATE);
    patchFile(full, 'ANTIGRAVITY_VERSION||"2.31.1"', 'ANTIGRAVITY_VERSION||"2.29.1"', 'ANTIGRAVITY_VERSION||"2.31.1"');
    patchFile(full, 'ANTIGRAVITY_VERSION||"2.31.1"', 'ANTIGRAVITY_VERSION||"2.31.0"', 'ANTIGRAVITY_VERSION||"2.31.1"');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CHUNK 8416.js: Strip X-Client-Name and X-Client-Version from usage API
// ─────────────────────────────────────────────────────────────────────────────

const OLD_USAGE_H1 = '"X-Client-Name":"antigravity","X-Client-Version":e.Tr},body:JSON.stringify';
const NEW_USAGE_H1 = '},body:JSON.stringify';

for (const dir of [BUILD_SERVER, path.join(BUILD_SERVER, "chunks")]) {
  const f = path.join(dir, "8416.js");
  patchFile(f, 'User-Agent":g.userAgent,"Content-Type":"application/json"},body:JSON.stringify', OLD_USAGE_H1, NEW_USAGE_H1, 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. CHUNK 8895.js: Forward proxyOptions on 401/403 retry refreshCredentials
// ─────────────────────────────────────────────────────────────────────────────

for (const dir of [BUILD_SERVER, path.join(BUILD_SERVER, "chunks")]) {
  const f = path.join(dir, "8895.js");
  patchFile(f, 'a2.refreshCredentials(c,d,a5)', 'a2.refreshCredentials(c,d)', 'a2.refreshCredentials(c,d,a5)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. STATIC REGISTRY CHUNKS
// ─────────────────────────────────────────────────────────────────────────────

const staticChunksDir = path.join(BUILD_STATIC, "chunks");
if (fs.existsSync(staticChunksDir)) {
  for (const f of fs.readdirSync(staticChunksDir)) {
    if (f.startsWith("1321-") && f.endsWith(".js") && !f.endsWith(".bak")) {
      const full = path.join(staticChunksDir, f);
      patchFile(full, 'antigravity/hub/2.31.1', 'antigravity/hub/2.29.1', 'antigravity/hub/2.31.1');
      patchFile(full, 'antigravity/hub/2.31.1', 'antigravity/hub/2.31.0', 'antigravity/hub/2.31.1');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Syntax check
// ─────────────────────────────────────────────────────────────────────────────

if (!DRY_RUN && patchedFiles.size > 0) {
  console.log("\nVerifying syntax with node --check...");
  for (const f of patchedFiles) {
    if (f.endsWith(".js")) {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
      console.log(`[SYNTAX OK] ${path.relative(ROOT, f)}`);
    }
  }
}

console.log(`\n[patch-9r-antigravity-shield] Complete. Patched ${patchedCount} operations across ${patchedFiles.size} files.`);
