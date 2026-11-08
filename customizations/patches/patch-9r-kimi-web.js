/**
 * Installer for kimi-web provider into 9router bundle.
 *   node patch-9r-kimi-web.js          # dry run
 *   node patch-9r-kimi-web.js --apply  # install + patch + verify
 *   node patch-9r-kimi-web.js --revert # restore chunks
 */
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

const REGISTRY_NEEDLE = ',"gemini-web":new x.dQ';
const REGISTRY_REPLACEMENT = ',"gemini-web":new x.dQ,"kimi-web":(globalThis.__9rKimiExec?new (globalThis.__9rKimiExec())():new w.id)';
const SERVICE_NEEDLE = null; // descriptor insertion deferred: catalog entry requires verified needle
const SERVICE_REPLACEMENT = null; // skip descriptor patch to avoid corrupting existing providers
const KEEPER_MARK = "KIMI-WEB-LOADER";

const DRIVER_FILES = [
  "kimi-web/auth.js",
  "kimi-web/client.cjs",
  "kimi-web/sse.cjs",
  "kimi-web/error.cjs",
  "kimi-web/executor.cjs",
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
    const backup = `${file}.pre-kimiweb.bak`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
    fs.writeFileSync(file, next);
    checkSyntax(file);
    if (!fs.readFileSync(file, "utf8").includes(marker)) throw new Error("post-write verification failed");
  }
  return APPLY ? "patched + node --check ok" : "would patch (needle unique)";
}

function revertFile(file) {
  const backup = `${file}.pre-kimiweb.bak`;
  if (!fs.existsSync(backup)) return "no backup, untouched";
  fs.writeFileSync(file, fs.readFileSync(backup));
  return "restored from .pre-kimiweb.bak";
}

if (REVERT) {
  note("revert 5330.js registry", revertFile(EXECUTOR_FILE));
  const root = path.join(ROOT, "app");
  const walkBackups = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkBackups(full);
      else if (full.endsWith(".pre-kimiweb.bak")) {
        const target = full.replace(/\.pre-kimiweb\.bak$/, "");
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
const targetDir = path.join(RUNTIME, "webchat", "kimi-web");
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
  note(`copy ${relative}`, `${APPLY ? "installed" : "would copy"} ${bytes} B -> runtime/webchat/kimi-web/`);
}

// 2. keeper loader
const loaderBlock = [
  "",
  `// ${KEEPER_MARK}: publish the kimi-web driver for the patched registry.`,
  "// Guarded so a broken driver can never stop the router.",
  "try {",
  "  if (process.env.NINEROUTER_KIMI_WEB !== \"0\") {",
  "    const kiHome = process.env.KIMI_HOME || require(\"node:path\").join(__dirname, \"webchat\", \"kimi-web\");",
  "    if (require(\"node:fs\").existsSync(require(\"node:path\").join(kiHome, \"client.cjs\"))) {",
  "      process.env.KIMI_HOME = kiHome;",
  "      process.env.KIMI_RUNTIME = __dirname;",
  "      globalThis.__9rKimiExec = (Base) => require(require(\"node:path\").join(kiHome, \"executor.cjs\")).createWebchatExecutor(Base, { id: \"kimi-web\", baseUrl: \"https://www.kimi.com\" });",
  "    }",
  "  }",
  "} catch (err) {",
  '  console.log("[keeper] kimi-web driver not loaded:", err.message);',
  "}",
].join("\n");

let keeperResult;
if (fs.existsSync(KEEPER)) {
  const keeperText = fs.readFileSync(KEEPER, "utf8");
  if (keeperText.includes(KEEPER_MARK)) keeperResult = "already applied";
  else if (APPLY) {
    fs.writeFileSync(`${KEEPER}.pre-kimiweb.bak`, keeperText);
    fs.writeFileSync(KEEPER, keeperText + "\n" + loaderBlock + "\n");
    checkSyntax(KEEPER);
    keeperResult = "appended loader + node --check ok";
  } else keeperResult = "would append guarded loader";
} else keeperResult = "KEEPER MISSING — no --require hook";
note("9r-net-keeper.js loader", keeperResult);

// 3 + 4. bundle patches
try {
  note("chunks/5330.js registry", patchFile(EXECUTOR_FILE, REGISTRY_NEEDLE, REGISTRY_REPLACEMENT, "__9rKimiExec"));
} catch (err) {
  note("chunks/5330.js registry", `REFUSED: ${err.message}`);
}

function descriptorFiles() {
  const hits = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.js$/.test(entry.name)) {
        let text;
        try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
        if (countOf(text, SERVICE_NEEDLE) >= 1) hits.push(full);
      }
    }
  };
  walk(path.join(ROOT, "app"));
  return hits;
}

{
  if (!SERVICE_NEEDLE) {
    note("descriptor files", "SKIPPED (catalog insertion deferred; registry entry makes provider callable)");
  } else {
  const files = descriptorFiles();
  if (!files.length) note("descriptor files", "NONE FOUND — authHint not patched");
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    try {
      note(`descriptor ${rel.slice(-50)}`, patchFile(file, SERVICE_NEEDLE, SERVICE_REPLACEMENT, SERVICE_REPLACEMENT));
    } catch (err) {
      note(`descriptor ${rel.slice(-50)}`, `REFUSED: ${err.message}`);
    }
  }
  }
}

console.log(log.join("\n"));
console.log(
  APPLY
    ? "\nwritten. 9router must restart to load the new chunks — this script does NOT restart it."
    : "\ndry run: nothing was written. Re-run with --apply after reviewing this plan."
);
console.log("rollback any time: node patches/patch-9r-kimi-web.js --revert");