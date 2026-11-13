import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const FORK_PKG_DIR = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router-fork";
const FORK_DATA_DIR = "C:/Users/Administrator/AppData/Roaming/9router-fork";
const FORK_SHIM = path.join(FORK_DATA_DIR, "bin", "9router-fork.cmd");
const FORK_VBS = path.join(
  process.env.APPDATA || "C:/Users/Administrator/AppData/Roaming",
  "Microsoft/Windows/Start Menu/Programs/Startup/9router-fork.vbs"
);

test("1. 9router-fork package identity and version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(FORK_PKG_DIR, "package.json"), "utf8"));
  assert.equal(pkg.name, "9router-fork");
  assert.equal(pkg.version, "0.5.119");
});

test("2. 9router-fork cli.js enforces DATA_DIR, port 20130, isolated keeper & process filter", () => {
  const cli = fs.readFileSync(path.join(FORK_PKG_DIR, "cli.js"), "utf8");
  assert.match(cli, /DEFAULT_PORT\s*=\s*20130/);
  assert.match(cli, /9router-fork/);
  assert.match(cli, /9router-fork\/runtime\/9r-net-keeper\.js/);
  assert.match(cli, /process\.env\.DATA_DIR/);
  assert.doesNotMatch(cli, /cmd\.includes\("9router"\)\s*&&\s*\(cmd\.includes\("cli\.js"\)/);
  assert.doesNotMatch(cli, /\|\|\s*cmd\.includes\("next-server"\)/);
});

test("3. autostart.js uses APP_NAME = 9router-fork and Startup/9router-fork.vbs exists", () => {
  const auto = fs.readFileSync(path.join(FORK_PKG_DIR, "src/cli/tray/autostart.js"), "utf8");
  assert.match(auto, /const APP_NAME = "9router-fork"/);
  assert.ok(fs.existsSync(FORK_VBS), "Startup/9router-fork.vbs must exist");
  const vbs = fs.readFileSync(FORK_VBS, "utf8");
  assert.match(vbs, /9router-fork\\cli\.js/);
  assert.match(vbs, /--tray --skip-update/);
});

test("4. 9router-fork PowerShell shim, isolated tunnel state & tunnel port follow PORT=20130", () => {
  assert.ok(fs.existsSync(FORK_SHIM), "bin/9router-fork.cmd must exist");
  const shim = fs.readFileSync(FORK_SHIM, "utf8");
  assert.match(shim, /9router-fork\\cli\.js/);
  const state = JSON.parse(fs.readFileSync(path.join(FORK_DATA_DIR, "tunnel/state.json"), "utf8"));
  assert.equal(state.shortId, "b54hwc");
  const tunnelChunk = fs.readFileSync(path.join(FORK_PKG_DIR, "app/.next-cli-build/server/chunks/6457.js"), "utf8");
  assert.match(tunnelChunk, /Number\(process\.env\.PORT\)\|\|20128/);
});
