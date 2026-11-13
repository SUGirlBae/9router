#!/usr/bin/env node
"use strict";
// Scope the app-level "shutdown/update" kill in a 9router bundle to its OWN processes.
//
// The upstream compiled routes `app/api/version/{shutdown,update}` kill every process
// whose command line contains "9router", "next-server", "\bin\app\" or "cli.js", plus
// EVERY cloudflared.exe on the machine. In a dual-instance layout (stock 20128 +
// 9router-fork 20130) that means pressing "Update" on either dashboard silently kills
// the other instance and both tunnels.
//
// This patch rewrites those two compiled route chunks so the fork only ever touches
// processes whose command line contains "9router-fork", and never enumerates
// cloudflared/tray binaries globally.
//
// Usage:
//   node patch-9r-fork-kill-scope.js                # patch bundle next to %APPDATA%\npm
//   node patch-9r-fork-kill-scope.js --root <dir>   # patch <dir>/app
//   node patch-9r-fork-kill-scope.js --revert
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const APP_NAME = "9router-fork";
const ROUTES = [
  ["app", "api", "version", "shutdown", "route.js"],
  ["app", "api", "version", "update", "route.js"],
];

function parseArgs(argv) {
  const out = { root: null, revert: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--revert") out.revert = true;
    else if (argv[i] === "--root") out.root = argv[++i];
  }
  return out;
}

function defaultRoot() {
  const appData = process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
  return path.join(appData, "npm", "node_modules", APP_NAME);
}

// Exact upstream predicates (minified but stable across 0.5.x builds).
const WIN_PREDICATE =
  'c.includes("9router")||c.includes("next-server")||c.includes("\\\\bin\\\\app\\\\")||c.includes("/bin/app/")||c.includes("cli.js")';
const WIN_PREDICATE_SCOPED = `c.includes("${APP_NAME}")`;
const UNIX_PREDICATE =
  'b.includes("9router")||b.includes("next-server")||b.includes("cloudflared")||b.includes("/bin/app/")||b.includes("tray_darwin")||b.includes("tray_linux")';
const UNIX_PREDICATE_SCOPED = `b.includes("${APP_NAME}")`;
const GLOBAL_BINARIES = '["cloudflared","tray_windows_release"]';
const GLOBAL_BINARIES_SCOPED = "[]";
const MITM_DIR_UPSTREAM = 'process.env.APPDATA||"","9router")';
const MITM_DIR_SCOPED = `process.env.APPDATA||"","${APP_NAME}")`;

function patchFile(file, { revert }) {
  const bak = `${file}.pre-forkkillscope.bak`;
  if (revert) {
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, file);
      fs.unlinkSync(bak);
      return "reverted";
    }
    return "no-backup";
  }
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(WIN_PREDICATE_SCOPED) && src.includes(GLOBAL_BINARIES_SCOPED)) return "already-applied";

  const before = src;
  src = src.split(WIN_PREDICATE).join(WIN_PREDICATE_SCOPED);
  src = src.split(UNIX_PREDICATE).join(UNIX_PREDICATE_SCOPED);
  src = src.split(GLOBAL_BINARIES).join(GLOBAL_BINARIES_SCOPED);
  src = src.split(MITM_DIR_UPSTREAM).join(MITM_DIR_SCOPED);

  if (src === before) return "no-match";
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  fs.writeFileSync(file, src);
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  return "patched";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkgRoot = path.resolve(args.root || defaultRoot());
  const serverDir = path.join(pkgRoot, "app", ".next-cli-build", "server");
  if (!fs.existsSync(serverDir)) {
    console.error(`[fork-kill-scope] server dir not found: ${serverDir}`);
    process.exit(1);
  }
  let touched = 0;
  for (const rel of ROUTES) {
    const file = path.join(serverDir, ...rel);
    if (!fs.existsSync(file)) {
      console.log(`[fork-kill-scope] SKIP missing ${rel.join("/")}`);
      continue;
    }
    const status = patchFile(file, args);
    console.log(`[fork-kill-scope] ${status.padEnd(16)} ${rel.join("/")}`);
    if (status === "patched" || status === "reverted") touched++;
    if (status === "no-match") {
      console.error("[fork-kill-scope] FAILED: predicate not found — upstream chunk shape changed, update this patch.");
      process.exitCode = 1;
    }
  }
  console.log(`[fork-kill-scope] ${touched} file(s) updated. Restart ${APP_NAME} to load the new chunks.`);
}

main();
