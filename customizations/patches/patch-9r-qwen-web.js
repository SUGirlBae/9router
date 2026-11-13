/**
 * Installer for qwen-web provider into 9router bundle.
 *   node patch-9r-qwen-web.js          # dry run, writes nothing
 *   node patch-9r-qwen-web.js --apply   # install + patch + verify
 *   node patch-9r-qwen-web.js --revert  # restore both chunks
 *
 * Four things happen, each idempotent and reversible:
 *   1. driver tree copied to %APPDATA%/9router/runtime/webchat/qwen-web/
 *   2. 9r-net-keeper.js gains a guarded loader that sets globalThis.__9rQwenWrap
 *   3. chunks/5330.js registry needle -> wrapped executor
 *   4. chunks/2598.js qwen-web descriptor -> serviceKinds ["image","video","llm"]
 * Every patched file keeps .pre-{provider}.bak and must pass node --check.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = process.env.NINEROUTER_ROOT || "D:/9router";
const BUILD = path.join(ROOT, "app/.next-cli-build/server");
const CHUNKS = path.join(BUILD, "chunks");
const STATIC = path.join(BUILD, "static/chunks");
const RUNTIME = path.join(process.env.APPDATA || "D:/9router/appdata", "9router", "runtime");
const HERE = __dirname;
const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");

const EXECUTOR_FILE = path.join(CHUNKS, "5330.js");
const DESCRIPTOR_STATIC = path.join(STATIC, "1321-*-*.js"); // static model picker chunk
const KEEPER = path.join(RUNTIME, "9r-net-keeper.js");

const REGISTRY_NEEDLE = ',"chatgpt-web":';
const REGISTRY_REPLACEMENT = ',"qwen-web":(globalThis.__9rQwenExec?new (globalThis.__9rQwenExec())():new w.id),"chatgpt-web":';
// Needle unique to qwen's descriptor snippet in descriptor files
const SERVICE_NEEDLE = null; // descriptor insertion deferred: catalog entry requires verified needle
const SERVICE_REPLACEMENT = null; // skip descriptor patch to avoid corrupting existing providers
const KEEPER_MARK = "QWEN-WEB-LOADER";

const DRIVER_FILES = [
  "qwen-web/auth.js",
  "qwen-web/client.cjs",
  "qwen-web/qwen-tools.cjs",
  "qwen-web/sse.cjs",
  "qwen-web/error.cjs",
  "qwen-web/executor.cjs",
  "qwen-web/browser-client.cjs",
];

const log = [];
function note(step, result) {
  log.push(`${step.padEnd(36)} ${result}`);
}

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function checkSyntax(file) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

function patchFile(file, needle, replacement, marker) {
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(marker)) return "already applied";
  const hits = countOf(text, needle);
  if (hits !== 1) throw new Error(`expected exactly 1 occurrence in ${path.basename(file)}, found ${hits}`);
  const next = text.replace(needle, replacement);
  if (APPLY) {
    const backup = `${file}.pre-qwenweb.bak`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
    fs.writeFileSync(file, next);
    checkSyntax(file);
    if (!fs.readFileSync(file, "utf8").includes(marker)) throw new Error("post-write verification failed");
  }
  return APPLY ? "patched + node --check ok" : "would patch (needle unique)";
}

function revertFile(file) {
  const backup = `${file}.pre-qwenweb.bak`;
  if (!fs.existsSync(backup)) return "no backup, untouched";
  fs.writeFileSync(file, fs.readFileSync(backup));
  return "restored from .pre-qwenweb.bak";
}

if (REVERT) {
  note("revert 5330.js registry", revertFile(EXECUTOR_FILE));
  const root = path.join(ROOT, "app");
  const walkBackups = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkBackups(full);
      else if (full.endsWith(".pre-qwenweb.bak")) {
        const target = full.replace(/\.pre-qwenweb\.bak$/, "");
        if (path.basename(target) !== path.basename(EXECUTOR_FILE)) note(`revert ${path.relative(root, target)}`, revertFile(target));
      }
    }
  };
  walkBackups(root);
  console.log(log.join("\n"));
  console.log("\nrestart 9router to load the reverted chunks.");
  process.exit(0);
}

// 1. driver tree
const targetDir = path.join(RUNTIME, "webchat", "qwen-web");
for (const relative of DRIVER_FILES) {
  const source = path.join(HERE, relative);
  if (!fs.existsSync(source)) {
    note(`copy ${relative}`, "MISSING SOURCE — aborting");
    console.error(`driver file not found: ${source}`);
    process.exit(1);
  }
  const destination = path.join(targetDir, relative.split("/")[1] || relative);
  const bytes = fs.statSync(source).size;
  if (APPLY) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  note(`copy ${relative}`, `${APPLY ? "installed" : "would copy"} ${bytes} B -> runtime/webchat/qwen-web/`);
}

// 2. keeper loader
const loaderBlock = [
  "",
  `// ${KEEPER_MARK}: publish the qwen-web driver for the patched registry.`,
  "// Guarded so a broken driver can never stop the router.",
  "try {",
  "  if (process.env.NINEROUTER_QWEN_WEB !== \"0\") {",
  "    const qwHome = process.env.QWEN_HOME || require(\"node:path\").join(__dirname, \"webchat\", \"qwen-web\");",
  "    if (require(\"node:fs\").existsSync(require(\"node:path\").join(qwHome, \"client.cjs\"))) {",
  "      process.env.QWEN_HOME = qwHome;",
  "      process.env.QWEN_TRANSPORT = \"browser\";",
  "      process.env.QWEN_RUNTIME = __dirname;",
  "      globalThis.__9rQwenExec = (Base) => require(require(\"node:path\").join(qwHome, \"executor.cjs\")).createWebchatExecutor(Base, { id: \"qwen-web\", baseUrl: \"https://chat.qwen.ai\", transport: process.env.QWEN_TRANSPORT || \"direct\", home: qwHome });",
  "    }",
  "  }",
  "} catch (err) {",
  '  console.log("[keeper] qwen-web driver not loaded:", err.message);',
  "}",
].join("\n");

let keeperResult;
if (fs.existsSync(KEEPER)) {
  const keeperText = fs.readFileSync(KEEPER, "utf8");
  const OLD_BIND = '{ id: "qwen-web", baseUrl: "https://chat.qwen.ai" }';
  const NEW_BIND = '{ id: "qwen-web", baseUrl: "https://chat.qwen.ai", transport: "browser", home: require("node:path").join(__dirname, "webchat", "qwen-web") }';
  if (keeperText.includes(KEEPER_MARK) && keeperText.includes(OLD_BIND)) {
    // Upgrade an older loader binding to browser transport (qwen direct fetch hits anti-bot).
    if (APPLY) {
      fs.writeFileSync(`${KEEPER}.pre-qwenweb.bak`, keeperText);
      fs.writeFileSync(KEEPER, keeperText.replace(OLD_BIND, NEW_BIND));
      checkSyntax(KEEPER);
      keeperResult = "upgraded binding to browser transport + node --check ok";
    } else keeperResult = "would upgrade binding to browser transport";
  } else if (keeperText.includes(KEEPER_MARK)) keeperResult = "already applied";
  else if (APPLY) {
    fs.writeFileSync(`${KEEPER}.pre-qwenweb.bak`, keeperText);
    fs.writeFileSync(KEEPER, keeperText + "\n" + loaderBlock + "\n");
    checkSyntax(KEEPER);
    keeperResult = "appended loader + node --check ok";
  } else keeperResult = "would append guarded loader";
} else keeperResult = "KEEPER MISSING — no --require hook";
note("9r-net-keeper.js loader", keeperResult);

// 3 + 4. bundle patches
try {
  note("chunks/5330.js registry", patchFile(EXECUTOR_FILE, REGISTRY_NEEDLE, REGISTRY_REPLACEMENT, "__9rQwenExec"));
} catch (err) {
  note("chunks/5330.js registry", `REFUSED: ${err.message}`);
}

// 4. Descriptor files (insert or upgrade qwen-web descriptor before deepseek-web)
const DESC_MARK = 'id:"qwen3.7-plus-think"';
const OLD_QWEN_DESCRIPTOR = '{id:"qwen-web",priority:220,alias:"qwen-web",aliases:["qw-web"],uiAlias:"qwen-web",display:{name:"Qwen Web",icon:"auto_awesome",color:"#615ced",textIcon:"QW",website:"https://chat.qwen.ai"},category:"webCookie",authType:"cookie",authHint:"Login via browser or paste token from chat.qwen.ai localStorage (DevTools → Application → Local Storage)",transport:{baseUrl:"https://chat.qwen.ai",format:"openai",authType:"cookie"},models:[{id:"qwen3.7-plus",name:"Qwen 3.7 Plus"},{id:"qwen3.7-max",name:"Qwen 3.7 Max"},{id:"qwen3.7-72b",name:"Qwen 3.7 72B"},{id:"qwen3.7-coder",name:"Qwen 3.7 Coder"},{id:"qwen-max",name:"Qwen Max"},{id:"qwen-plus",name:"Qwen Plus"},{id:"qwen-turbo",name:"Qwen Turbo"}]},';
const DESC_NEEDLE = '{id:"deepseek-web",priority:220,';
const QWEN_DESCRIPTOR = '{id:"qwen-web",priority:220,alias:"qwen-web",aliases:["qw-web"],uiAlias:"qwen-web",display:{name:"Qwen Web",icon:"auto_awesome",color:"#615ced",textIcon:"QW",website:"https://chat.qwen.ai"},category:"webCookie",authType:"cookie",authHint:"Login via browser or paste token from chat.qwen.ai localStorage (DevTools → Application → Local Storage)",transport:{baseUrl:"https://chat.qwen.ai",format:"openai",authType:"cookie"},models:[{id:"qwen3.7-plus",name:"Qwen 3.7 Plus",supportsReasoning:true},{id:"qwen3.7-plus-think",name:"Qwen 3.7 Plus Think",supportsReasoning:true},{id:"qwen3.7-plus-search",name:"Qwen 3.7 Plus Search",supportsReasoning:true},{id:"qwen3.7-plus-think-search",name:"Qwen 3.7 Plus Think+Search",supportsReasoning:true},{id:"qwen3.7-max",name:"Qwen 3.7 Max",supportsReasoning:true},{id:"qwen3.7-72b",name:"Qwen 3.7 72B",supportsReasoning:true},{id:"qwen3.7-coder",name:"Qwen 3.7 Coder",supportsReasoning:true},{id:"qwen-max",name:"Qwen Max",supportsReasoning:true},{id:"qwen-plus",name:"Qwen Plus",supportsReasoning:true},{id:"qwen-turbo",name:"Qwen Turbo"}]},';
const DESC_REPLACEMENT = QWEN_DESCRIPTOR + DESC_NEEDLE;

function findFilesWith(needle, marker) {
  const hits = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.js$/.test(entry.name) && !entry.name.includes(".bak")) {
        let text;
        try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
        if (marker && text.includes(marker)) {
          hits.push({ file: full, state: "already applied" });
        } else if (text.includes(OLD_QWEN_DESCRIPTOR)) {
          hits.push({ file: full, state: "needs upgrade" });
        } else if (countOf(text, needle) >= 1) {
          hits.push({ file: full, state: "needs patch" });
        }
      }
    }
  };
  walk(path.join(ROOT, "app", ".next-cli-build"));
  return hits;
}

const descFiles = findFilesWith(DESC_NEEDLE, DESC_MARK);
if (!descFiles.length) note("descriptor files", "NONE FOUND");
for (const { file, state } of descFiles) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (state === "already applied") {
    note(`desc ${rel.slice(-45)}`, "already applied");
  } else if (state === "needs upgrade") {
    try {
      note(`desc ${rel.slice(-45)}`, patchFile(file, OLD_QWEN_DESCRIPTOR, QWEN_DESCRIPTOR, DESC_MARK));
    } catch (err) {
      note(`desc ${rel.slice(-45)}`, `REFUSED: ${err.message}`);
    }
  } else {
    try {
      note(`desc ${rel.slice(-45)}`, patchFile(file, DESC_NEEDLE, DESC_REPLACEMENT, DESC_MARK));
    } catch (err) {
      note(`desc ${rel.slice(-45)}`, `REFUSED: ${err.message}`);
    }
  }
}

// 5. WebLoginButton providers set
const WEBLOGIN_MARK = '"uc-web","qwen-web"';
const WEBLOGIN_NEEDLE = '"muse-web","deepseek-web","uc-web"';
const WEBLOGIN_REPLACEMENT = '"muse-web","deepseek-web","uc-web","qwen-web"';
const webLoginFiles = findFilesWith(WEBLOGIN_NEEDLE, WEBLOGIN_MARK);
for (const { file, state } of webLoginFiles) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (state === "already applied") {
    note(`weblogin ${rel.slice(-42)}`, "already applied");
  } else {
    try {
      note(`weblogin ${rel.slice(-42)}`, patchFile(file, WEBLOGIN_NEEDLE, WEBLOGIN_REPLACEMENT, WEBLOGIN_MARK));
    } catch (err) {
      note(`weblogin ${rel.slice(-42)}`, `REFUSED: ${err.message}`);
    }
  }
}

// 6. webIdentity probe in 3697.js
const IDENTITY_MARK = 'async "qwen-web"(a){';
const IDENTITY_NEEDLE = 'return j(h.includes("@")?h:"")}};function q(a){return Object.hasOwn(p,a)}';
const IDENTITY_REPLACEMENT = 'return j(h.includes("@")?h:"")},async "qwen-web"(a){let b=String(a||"").trim();try{let a=JSON.parse(b);"string"==typeof a?.value&&(b=a.value)}catch{}if(!b||b.length<20)return k("Missing or invalid token");let c=n(b);return j(c?.id?`qwen-${c.id.slice(0,8)}`:"qwen-user")}};function q(a){return Object.hasOwn(p,a)}';
const idFiles = findFilesWith(IDENTITY_NEEDLE, IDENTITY_MARK);
for (const { file, state } of idFiles) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (state === "already applied") {
    note(`identity ${rel.slice(-42)}`, "already applied");
  } else {
    try {
      note(`identity ${rel.slice(-42)}`, patchFile(file, IDENTITY_NEEDLE, IDENTITY_REPLACEMENT, IDENTITY_MARK));
    } catch (err) {
      note(`identity ${rel.slice(-42)}`, `REFUSED: ${err.message}`);
    }
  }
}

// 7. Icon copy
const iconSrc = path.join(ROOT, "app", "public", "providers", "qwen.png");
const iconDst = path.join(ROOT, "app", "public", "providers", "qwen-web.png");
if (fs.existsSync(iconSrc) && !fs.existsSync(iconDst)) {
  if (APPLY) fs.copyFileSync(iconSrc, iconDst);
  note("qwen-web icon", APPLY ? "installed" : "would copy");
} else {
  note("qwen-web icon", "already present");
}

// 8. Safety fallback in providers/[id] page (prevents "Provider not found" on stale cache)
const S_PAGE_NEEDLE = "l.zN[q]||l.fg[q]||l.IS[q]||l.nJ[q]||l.br[q]";
const S_PAGE_REPL = 'l.zN[q]||l.fg[q]||l.IS[q]||l.nJ[q]||l.br[q]||("qwen-web"===q?{id:"qwen-web",name:"Qwen Web",color:"#615ced",textIcon:"QW",website:"https://chat.qwen.ai",category:"webCookie",authType:"cookie"}:null)';
const ST_PAGE_NEEDLE = "m.zN[f]||m.fg[f]||m.IS[f]||m.nJ[f]||m.br[f]";
const ST_PAGE_REPL = 'm.zN[f]||m.fg[f]||m.IS[f]||m.nJ[f]||m.br[f]||("qwen-web"===f?{id:"qwen-web",name:"Qwen Web",color:"#615ced",textIcon:"QW",website:"https://chat.qwen.ai",category:"webCookie",authType:"cookie"}:null)';

const sPagePath = path.join(ROOT, "app/.next-cli-build/server/app/(dashboard)/dashboard/providers/[id]/page.js");
const stPagePath = path.join(ROOT, "app/.next-cli-build/static/chunks/app/(dashboard)/dashboard/providers/[id]/page-f98f1e29fd6fc471.js");

if (fs.existsSync(sPagePath)) {
  try {
    note("server page fallback", patchFile(sPagePath, S_PAGE_NEEDLE, S_PAGE_REPL, '"qwen-web"===q'));
  } catch (e) {
    note("server page fallback", `REFUSED: ${e.message}`);
  }
}
if (fs.existsSync(stPagePath)) {
  try {
    note("static chunk fallback", patchFile(stPagePath, ST_PAGE_NEEDLE, ST_PAGE_REPL, '"qwen-web"===f'));
  } catch (e) {
    note("static chunk fallback", `REFUSED: ${e.message}`);
  }
}

console.log(log.join("\n"));
console.log(
  APPLY
    ? "\nwritten. 9router must restart to load the new chunks — this script does NOT restart it."
    : "\ndry run: nothing was written. Re-run with --apply after reviewing this plan."
);
console.log("rollback any time: node patches/patch-9r-qwen-web.js --revert");