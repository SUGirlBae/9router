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
const FORK_CLI = path.join(FORK_PKG_DIR, "cli.js");

/** Extract a JS function body by brace matching (immune to quoting/formatting). */
function extractFunctionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name}() not found`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced braces in ${name}()`);
}

function walkJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("1. 9router-fork package identity and version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(FORK_PKG_DIR, "package.json"), "utf8"));
  assert.equal(pkg.name, "9router-fork");
  assert.equal(pkg.version, "0.5.119");
});

test("2. fork cli.js isolates DATA_DIR, port 20130 and the runtime preload", () => {
  const cli = fs.readFileSync(FORK_CLI, "utf8");
  assert.match(cli, /DEFAULT_PORT\s*=\s*20130/);
  assert.match(cli, /process\.env\.DATA_DIR/);
  assert.match(cli, /getAppDataDir\(\)[\s\S]{0,200}"9router-fork"/);
  // preload must be guarded by an existence check, never a bare absolute --require
  assert.match(cli, /function netKeeperArgs\(\)/);
  assert.match(cli, /fs\.existsSync\(keeper\)\s*\?\s*\["--require",\s*keeper\]\s*:\s*\[\]/);
  assert.doesNotMatch(cli, /--require",\s*"C:\//, "no hardcoded --require path may remain");
});

test("3. killAllAppProcesses only matches this fork (both platforms)", () => {
  const body = extractFunctionBody(fs.readFileSync(FORK_CLI, "utf8"), "killAllAppProcesses");
  assert.match(body, /includes\("9router-fork"\)/);
  assert.doesNotMatch(body, /next-server/, "must not kill every next-server on the machine");
  assert.doesNotMatch(body, /includes\("9router"\)\s*&&/, "must not match the bare 9router substring");
  assert.doesNotMatch(body, /tray_windows_release/);
});

test("4. autostart.js uses APP_NAME = 9router-fork and Startup/9router-fork.vbs exists", () => {
  const auto = fs.readFileSync(path.join(FORK_PKG_DIR, "src/cli/tray/autostart.js"), "utf8");
  assert.match(auto, /const APP_NAME = "9router-fork"/);
  assert.ok(fs.existsSync(FORK_VBS), "Startup/9router-fork.vbs must exist");
  const vbs = fs.readFileSync(FORK_VBS, "utf8");
  assert.match(vbs, /9router-fork\\cli\.js/);
  assert.match(vbs, /--tray --skip-update/);
});

test("5. PowerShell shim + isolated tunnel state exist", () => {
  assert.ok(fs.existsSync(FORK_SHIM), "bin/9router-fork.cmd must exist");
  const shim = fs.readFileSync(FORK_SHIM, "utf8");
  assert.match(shim, /9router-fork\\cli\.js/);
  const state = JSON.parse(fs.readFileSync(path.join(FORK_DATA_DIR, "tunnel/state.json"), "utf8"));
  assert.equal(state.shortId, "b54hwc");
});

test("6. compiled tunnel chunks resolve the local port from env (TUNNEL_LOCAL_PORT > PORT)", () => {
  const serverDir = path.join(FORK_PKG_DIR, "app/.next-cli-build/server");
  const files = walkJs(serverDir);
  const hits = files.filter((f) => {
    const s = fs.readFileSync(f, "utf8");
    return s.includes("Number(process.env.TUNNEL_LOCAL_PORT)") && s.includes("Number(process.env.PORT)");
  });
  assert.ok(hits.length > 0, "expected at least one chunk to derive the tunnel port from env");
  // Ensure no lingering hardcoded 20128-only default in the tunnel enable path
  const tunnelChunks = files.filter((f) => fs.readFileSync(f, "utf8").includes("enable start (port="));
  assert.ok(tunnelChunks.length > 0, "tunnel enable chunk not found");
  for (const f of tunnelChunks) {
    const s = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(
      s,
      /async function \w+\(a=20128\)\{console\.log\(`\[Tunnel\] enable start/,
      `hardcoded 20128 tunnel default returned in ${path.basename(f)}`
    );
  }
});

test("7. compiled version shutdown/update routes are scoped to 9router-fork", () => {
  const serverDir = path.join(FORK_PKG_DIR, "app/.next-cli-build/server/app/api/version");
  for (const name of ["shutdown", "update"]) {
    const file = path.join(serverDir, name, "route.js");
    assert.ok(fs.existsSync(file), `${name}/route.js must exist`);
    const s = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(s, /includes\("next-server"\)/, `${name}/route.js still kills every next-server`);
    assert.match(s, /includes\("9router-fork"\)/, `${name}/route.js must scope to 9router-fork`);
    assert.doesNotMatch(s, /\["cloudflared","tray_windows_release"\]/, `${name}/route.js kills global cloudflared`);
    assert.doesNotMatch(s, /APPDATA\|\|"","9router"\)/, `${name}/route.js reads stock MITM pid file`);
  }
});
