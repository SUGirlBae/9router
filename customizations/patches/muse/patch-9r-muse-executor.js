// Installs the direct muse-web executor into the 9router bundle (plan P5).
//
//   node muse/patch-9r-muse-executor.js            # dry run, writes nothing
//   node muse/patch-9r-muse-executor.js --apply    # install + patch + verify
//   node muse/patch-9r-muse-executor.js --revert   # restore both chunks
//
// Four things happen, each idempotent and each reversible:
//   1. the driver tree is copied to %APPDATA%/9router/runtime/muse/
//   2. 9r-net-keeper.js gains a guarded loader that sets globalThis.__9rMuseWrap
//   3. chunks/5330.js registry needle  -> wrapped executor, browser one intact
//   4. chunks/2598.js muse-web descriptor -> serviceKinds + real model ids
// Every patched file keeps a .pre-musehttp.bak and must pass node --check.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = process.env.NINEROUTER_ROOT || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router";
const BUILD = path.join(ROOT, "app/.next-cli-build/server");
const CHUNKS = path.join(BUILD, "chunks");
const RUNTIME = path.join(process.env.APPDATA || "", "9router", "runtime");
const HERE = __dirname;
const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");

const EXECUTOR_FILE = path.join(CHUNKS, "5330.js");
const KEEPER = path.join(RUNTIME, "9r-net-keeper.js");

const REGISTRY_NEEDLE = ',"muse-web":new y._5';
const REGISTRY_REPLACEMENT = ',"muse-web":(globalThis.__9rMuseWrap?globalThis.__9rMuseWrap(new y._5):new y._5)';
// The bare serviceKinds substring occurs 3x in 2598.js (other webCookie
// providers), so the needle has to carry muse-web's own tail to stay unique.
const SERVICE_NEEDLE = 'serviceKinds:["image","video"],videoConfig:{executorDriven:!0},authHint:"Paste your muse.ai cookies';
const SERVICE_REPLACEMENT = 'serviceKinds:["image","video","llm"],videoConfig:{executorDriven:!0},authHint:"Paste your muse.ai cookies';
const KEEPER_MARK = "MUSE-EXEC-LOADER";

const DRIVER_FILES = [
  "muse-bridge.cjs",
  "muse-web-http-executor.cjs",
  "lib/noise.cjs",
  "lib/pb.cjs",
  "lib/wire.cjs",
  "lib/gateway.cjs",
  "lib/session.cjs",
  "lib/pool.cjs",
  "lib/media.cjs",
];

const log = [];
function note(step, result) {
  log.push(`${step.padEnd(34)} ${result}`);
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
    const backup = `${file}.pre-musehttp.bak`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
    fs.writeFileSync(file, next);
    checkSyntax(file);
    if (!fs.readFileSync(file, "utf8").includes(marker)) throw new Error("post-write verification failed");
  }
  return APPLY ? "patched + node --check ok" : "would patch (needle unique)";
}

function revertFile(file) {
  const backup = `${file}.pre-musehttp.bak`;
  if (!fs.existsSync(backup)) return "no backup, untouched";
  fs.writeFileSync(file, fs.readFileSync(backup));
  return "restored from .pre-musehttp.bak";
}

if (REVERT) {
  note("revert 5330.js registry", revertFile(EXECUTOR_FILE));
  // Every bundle that carried the descriptor has its own backup.
  const root = path.join(ROOT, "app");
  const walkBackups = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkBackups(full);
      else if (full.endsWith(".pre-musehttp.bak")) {
        const target = full.replace(/\.pre-musehttp\.bak$/, "");
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
const targetDir = path.join(RUNTIME, "muse");
for (const relative of DRIVER_FILES) {
  const source = path.join(HERE, relative);
  if (!fs.existsSync(source)) {
    note(`copy ${relative}`, "MISSING SOURCE — aborting");
    console.error(`driver file not found: ${source}`);
    process.exit(1);
  }
  const destination = path.join(targetDir, relative);
  const bytes = fs.statSync(source).size;
  if (APPLY) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  note(`copy ${relative}`, `${APPLY ? "installed" : "would copy"} ${bytes} B -> runtime/muse/`);
}

// 2. keeper loader
const loaderBlock = [
  "",
  `// ${KEEPER_MARK}: publish the direct muse-web driver for the patched registry.`,
  "// Guarded so a broken driver can never stop the router.",
  "try {",
  '  if (process.env.NINEROUTER_MUSE_HTTP !== "0") {',
  "    const museHome = process.env.MUSE_HOME || require(\"node:path\").join(__dirname, \"muse\");",
  "    if (require(\"node:fs\").existsSync(require(\"node:path\").join(museHome, \"muse-bridge.cjs\"))) {",
  "      process.env.MUSE_HOME = museHome;",
  "      process.env.MUSE_RUNTIME = __dirname;",
  "      globalThis.__9rMuseWrap = require(require(\"node:path\").join(museHome, \"muse-web-http-executor.cjs\")).wrap;",
  "    }",
  "  }",
  "} catch (err) {",
  '  console.log("[keeper] muse driver not loaded:", err.message);',
  "}",
].join("\n");

let keeperResult;
if (fs.existsSync(KEEPER)) {
  const keeperText = fs.readFileSync(KEEPER, "utf8");
  if (keeperText.includes(KEEPER_MARK)) keeperResult = "already applied";
  else if (APPLY) {
    fs.writeFileSync(`${KEEPER}.pre-musehttp.bak`, keeperText);
    fs.writeFileSync(KEEPER, keeperText + "\n" + loaderBlock + "\n");
    checkSyntax(KEEPER);
    keeperResult = "appended loader + node --check ok";
  } else keeperResult = "would append guarded loader";
} else keeperResult = "KEEPER MISSING — no --require hook";
note("9r-net-keeper.js loader", keeperResult);

// 3 + 4. bundle patches
try {
  note("chunks/5330.js registry", patchFile(EXECUTOR_FILE, REGISTRY_NEEDLE, REGISTRY_REPLACEMENT, "__9rMuseWrap"));
} catch (err) {
  note("chunks/5330.js registry", `REFUSED: ${err.message}`);
}
// The provider descriptor is duplicated across several bundles: the server chunk
// that routes requests, other server chunks that build the model catalog, and a
// static chunk that feeds the dashboard's model picker. Patching only one leaves
// `muse-web/muse-chat` callable but invisible in /v1/models and in the UI.
function descriptorFiles() {
  const hits = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.js$/.test(entry.name)) {
        let text;
        try {
          text = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (countOf(text, SERVICE_NEEDLE) >= 1) hits.push(full);
      }
    }
  };
  walk(path.join(ROOT, "app"));
  return hits;
}

{
  const files = descriptorFiles();
  if (!files.length) note("descriptor files", "NONE FOUND — serviceKinds not patched");
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    try {
      note(`descriptor ${rel.slice(-46)}`, patchFile(file, SERVICE_NEEDLE, SERVICE_REPLACEMENT, SERVICE_REPLACEMENT));
    } catch (err) {
      note(`descriptor ${rel.slice(-46)}`, `REFUSED: ${err.message}`);
    }
  }
}

// 5. Host cookie fix for muse-web fallback Playwright runner
const COOKIE_NEEDLE = 's(m).map(({name:a,value:b})=>({name:a,value:b,domain:".muse.ai",path:"/",secure:!0,httpOnly:!1,sameSite:"Lax",expires:-1}))';
const COOKIE_REPLACEMENT = 's(m).map(({name:a,value:b})=>a.startsWith("__Host-")?{name:a,value:b,url:"https://muse.ai/",secure:!0,httpOnly:!1,sameSite:"Lax"}:{name:a,value:b,domain:".muse.ai",path:"/",secure:!0,httpOnly:!1,sameSite:"Lax"})';
try {
  note("5330.js __Host- cookie fix", patchFile(EXECUTOR_FILE, COOKIE_NEEDLE, COOKIE_REPLACEMENT, 'url:"https://muse.ai/"'));
} catch (err) {
  note("5330.js __Host- cookie fix", `REFUSED: ${err.message}`);
}

console.log(log.join("\n"));
console.log(
  APPLY
    ? "\nwritten. 9router must restart to load the new chunks — this script does NOT restart it."
    : "\ndry run: nothing was written. Re-run with --apply after reviewing this plan."
);
console.log("rollback any time: node muse/patch-9r-muse-executor.js --revert");
