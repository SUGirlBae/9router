/**
 * Adds qwen-web + kimi-web to the web-login provider config map (route.js `let k={...}`),
 * so POST /api/providers/web-login {provider, profile} can import a logged-in browser
 * profile and create a real provider connection (router e2e routing).
 *   node patch-9r-weblogin-map.js           # dry run
 *   node patch-9r-weblogin-map.js --apply   # patch + node --check
 *   node patch-9r-weblogin-map.js --revert  # restore backup
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ROOT = process.env.NINEROUTER_ROOT || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router";
const FILE = path.join(ROOT, "app/.next-cli-build/server/app/api/providers/web-login/route.js");
const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
const BAK = FILE + ".pre-webloginmap.bak";
const MARK = '"qwen-web":{loginUrl:';
const NEEDLE = 'let k={"grok-web":';
const ENTRIES =
  '"qwen-web":{loginUrl:"https://chat.qwen.ai/",cookieDomain:".qwen.ai",tokenSources:[{type:"localStorage",name:"token"}],credentialFrom:"localStorageValue",validateToken:a=>{if("string"!=typeof a||!a.trim())return!1;let b;try{b=JSON.parse(a)}catch{return a.length>=20}if(b&&"object"==typeof b)return"string"==typeof b.value&&b.value.trim().length>=20;return a.length>=20}},' +
  '"kimi-web":{loginUrl:"https://www.kimi.com/",cookieDomain:".kimi.com",tokenSources:[{type:"localStorage",name:"token"}],credentialFrom:"localStorageValue"},';
const REPLACEMENT = 'let k={' + ENTRIES + '"grok-web":';

if (REVERT) {
  if (fs.existsSync(BAK)) { fs.writeFileSync(FILE, fs.readFileSync(BAK)); console.log("restored from .pre-webloginmap.bak"); }
  else console.log("no backup, untouched");
  process.exit(0);
}
const text = fs.readFileSync(FILE, "utf8");
if (text.includes(MARK)) { console.log("already applied"); process.exit(0); }
const hits = text.split(NEEDLE).length - 1;
if (hits !== 1) { console.log(`REFUSED: expected 1 occurrence of needle, found ${hits}`); process.exit(1); }
if (!APPLY) { console.log("would patch web-login map (needle unique): add qwen-web + kimi-web"); process.exit(0); }
if (!fs.existsSync(BAK)) fs.writeFileSync(BAK, text);
fs.writeFileSync(FILE, text.replace(NEEDLE, REPLACEMENT));
execFileSync(process.execPath, ["--check", FILE], { stdio: "pipe" });
if (!fs.readFileSync(FILE, "utf8").includes(MARK)) { console.log("post-write verification failed"); process.exit(1); }
console.log("patched web-login map + node --check ok; restart 9router to load");