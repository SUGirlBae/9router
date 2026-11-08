// Re-applies the muse-web direct executor after an `npm i -g 9router`.
// Registered in reinstall-9router-fixes.js, which calls this with no arguments,
// so the apply flag lives here rather than in the caller.
"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const installer = path.join(__dirname, "muse", "patch-9r-muse-executor.js");
if (!fs.existsSync(installer)) {
  console.log("muse installer not found, skipping");
  process.exit(0);
}

// A fresh install overwrites the bundle, so a leftover backup from the previous
// version would restore stale chunks on --revert. Drop a backup only when the
// chunk it belongs to is unpatched, i.e. the bundle really was reinstalled.
const chunksDir = path.join(
  process.env.NINEROUTER_ROOT || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router",
  "app/.next-cli-build/server/chunks"
);
for (const [chunk, marker] of [["5330.js", "__9rMuseWrap"], ["2598.js", 'serviceKinds:["image","video","llm"]']]) {
  const backup = path.join(chunksDir, `${chunk}.pre-musehttp.bak`);
  let text = "";
  try {
    text = fs.readFileSync(path.join(chunksDir, chunk), "utf8");
  } catch {
    continue;
  }
  if (!text.includes(marker) && fs.existsSync(backup)) {
    fs.unlinkSync(backup);
    console.log(`dropped stale backup for ${chunk} (bundle is unpatched again)`);
  }
}

const out = execFileSync(process.execPath, [installer, "--apply"], { encoding: "utf8" });
console.log(out.trim().split("\n").slice(-6).join("\n"));
