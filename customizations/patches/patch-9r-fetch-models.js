/**
 * Installer for Universal "Fetch Models" button across all providers in 9router.
 *   node patch-9r-fetch-models.js           # dry run
 *   node patch-9r-fetch-models.js --apply   # patch + check
 *   node patch-9r-fetch-models.js --revert  # restore backups
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = process.env.NINEROUTER_ROOT || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router";
const BUILD = path.join(ROOT, "app/.next-cli-build");
const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");

const log = [];
function note(step, result) {
  log.push(`${step.padEnd(40)} ${result}`);
}

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function checkSyntax(file) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

function patchOne(file, needle, replacement, marker) {
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(marker)) return "already applied";
  const hits = countOf(text, needle);
  if (hits !== 1) throw new Error(`expected 1 occurrence in ${path.basename(file)}, found ${hits}`);
  const next = text.replace(needle, replacement);
  if (APPLY) {
    const backup = `${file}.pre-fetchmodels.bak`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
    fs.writeFileSync(file, next);
    checkSyntax(file);
    if (!fs.readFileSync(file, "utf8").includes(marker)) throw new Error("post-write verification failed");
  }
  return APPLY ? "patched + node --check ok" : "would patch (needle unique)";
}

function revertOne(file) {
  const backup = `${file}.pre-fetchmodels.bak`;
  if (!fs.existsSync(backup)) return "no backup, untouched";
  fs.writeFileSync(file, fs.readFileSync(backup));
  return "restored from .pre-fetchmodels.bak";
}

const ROUTE_FILE = path.join(BUILD, "server/app/api/providers/[id]/models/route.js");
const SERVER_PAGE = path.join(BUILD, "server/app/(dashboard)/dashboard/providers/[id]/page.js");
const STATIC_PAGE = path.join(BUILD, "static/chunks/app/(dashboard)/dashboard/providers/[id]/page-f98f1e29fd6fc471.js");

if (REVERT) {
  note("route.js", revertOne(ROUTE_FILE));
  note("server page.js", revertOne(SERVER_PAGE));
  note("static page chunk", revertOne(STATIC_PAGE));
  console.log(log.join("\n"));
  process.exit(0);
}

// 1. Backend Route: fallback to static catalog when provider has no dynamic resolver
const ROUTE_NEEDLE = 'let g=A[c.provider];if(!g)return d.NextResponse.json({error:`Provider ${c.provider} does not support models listing`},{status:400});';
const ROUTE_REPLACEMENT = 'let g=A[c.provider];if(!g){let sl=x(c.provider);if(sl&&sl.length>0)return d.NextResponse.json({provider:c.provider,connectionId:c.id,models:sl});return d.NextResponse.json({error:`Provider ${c.provider} does not support models listing`},{status:400});}';
const ROUTE_MARK = 'let sl=x(c.provider);';
try {
  note("backend models route", patchOne(ROUTE_FILE, ROUTE_NEEDLE, ROUTE_REPLACEMENT, ROUTE_MARK));
} catch (err) {
  note("backend models route", `REFUSED: ${err.message}`);
}

// 2. Server Page: universal fetch button and regex prefix strip
const S_BTN_NEEDLE = '("qoder"===q||"qoder-cn"===q)&&s.some(a=>!1!==a.isActive)&&';
const S_BTN_REPLACEMENT = 's.some(a=>!1!==a.isActive)&&';
const S_LBL_NEEDLE = '(0,B.Tl)("Fetch Qoder Models")';
const S_LBL_REPLACEMENT = '(0,B.Tl)("Fetch Models")';
const S_REG_NEEDLE = '.replace(/^(qoder-cn|qoder)\\//,"");a';
const S_REG_REPLACEMENT = '.replace(RegExp("^("+q+"|"+bE+"|qoder|qoder-cn)/","i"),"");a';

try {
  let text = fs.readFileSync(SERVER_PAGE, "utf8");
  if (text.includes('(0,B.Tl)("Fetch Models")')) {
    note("server page.js universal fetch", "already applied");
  } else {
    let next = text;
    if (countOf(next, S_BTN_NEEDLE) === 1) next = next.replace(S_BTN_NEEDLE, S_BTN_REPLACEMENT);
    else throw new Error("S_BTN_NEEDLE not unique");
    if (countOf(next, S_LBL_NEEDLE) === 1) next = next.replace(S_LBL_NEEDLE, S_LBL_REPLACEMENT);
    else throw new Error("S_LBL_NEEDLE not unique");
    if (countOf(next, S_REG_NEEDLE) === 1) next = next.replace(S_REG_NEEDLE, S_REG_REPLACEMENT);
    else throw new Error("S_REG_NEEDLE not unique");

    if (APPLY) {
      const backup = `${SERVER_PAGE}.pre-fetchmodels.bak`;
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
      fs.writeFileSync(SERVER_PAGE, next);
      checkSyntax(SERVER_PAGE);
    }
    note("server page.js universal fetch", APPLY ? "patched + node --check ok" : "would patch (all needles unique)");
  }
} catch (err) {
  note("server page.js universal fetch", `REFUSED: ${err.message}`);
}

// 3. Static Page chunk: universal fetch button and regex prefix strip
const ST_BTN_NEEDLE = '("qoder"===f||"qoder-cn"===f)&&y.some(e=>!1!==e.isActive)&&';
const ST_BTN_REPLACEMENT = 'y.some(e=>!1!==e.isActive)&&';
const ST_LBL_NEEDLE = '(0,T.Tl)("Fetch Qoder Models")';
const ST_LBL_REPLACEMENT = '(0,T.Tl)("Fetch Models")';
const ST_REG_NEEDLE = '.replace(/^(qoder-cn|qoder)\\//,"");e';
const ST_REG_REPLACEMENT = '.replace(RegExp("^("+f+"|"+tP+"|qoder|qoder-cn)/","i"),"");e';

try {
  let text = fs.readFileSync(STATIC_PAGE, "utf8");
  if (text.includes('(0,T.Tl)("Fetch Models")')) {
    note("static page chunk universal fetch", "already applied");
  } else {
    let next = text;
    if (countOf(next, ST_BTN_NEEDLE) === 1) next = next.replace(ST_BTN_NEEDLE, ST_BTN_REPLACEMENT);
    else throw new Error("ST_BTN_NEEDLE not unique");
    if (countOf(next, ST_LBL_NEEDLE) === 1) next = next.replace(ST_LBL_NEEDLE, ST_LBL_REPLACEMENT);
    else throw new Error("ST_LBL_NEEDLE not unique");
    if (countOf(next, ST_REG_NEEDLE) === 1) next = next.replace(ST_REG_NEEDLE, ST_REG_REPLACEMENT);
    else throw new Error("ST_REG_NEEDLE not unique");

    if (APPLY) {
      const backup = `${STATIC_PAGE}.pre-fetchmodels.bak`;
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, text);
      fs.writeFileSync(STATIC_PAGE, next);
      checkSyntax(STATIC_PAGE);
    }
    note("static page chunk universal fetch", APPLY ? "patched + node --check ok" : "would patch (all needles unique)");
  }
} catch (err) {
  note("static page chunk universal fetch", `REFUSED: ${err.message}`);
}

console.log(log.join("\n"));
console.log(
  APPLY
    ? "\nwritten. 9router must restart to load the new chunks — this script does NOT restart it."
    : "\ndry run: nothing was written. Re-run with --apply after reviewing this plan."
);
console.log("rollback any time: node patch-9r-fetch-models.js --revert");
