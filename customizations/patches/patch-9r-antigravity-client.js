// Patches 9router's bundled Next.js build to align Antigravity client fingerprint:
// - Upgrades ANTIGRAVITY_IDE_VERSION to 2.29.1 (or env ANTIGRAVITY_VERSION)
// - Replaces hardcoded darwin/arm64 with host platform/arch
// - Adds X-Client-Version header to AntigravityExecutor.buildHeaders
// - Updates connection test fallback UA
//
// Usage:
//   node patch-9r-antigravity-client.js [--dry-run] [--revert] [appDir]

const fs = require("fs");
const path = require("path");

const DRY_RUN = process.argv.includes("--dry-run");
const REVERT = process.argv.includes("--revert");

const customTarget = process.argv.find((a) => !a.startsWith("--") && a !== process.argv[0] && a !== process.argv[1]);
const APP_DIR = customTarget || path.resolve(__dirname, "../../app");
const BUILD_DIR = path.join(APP_DIR, ".next-cli-build");
const SERVER_DIR = path.join(BUILD_DIR, "server");
const STATIC_DIR = path.join(BUILD_DIR, "static");

const BAK_EXT = ".pre-agclient.bak";

if (!fs.existsSync(BUILD_DIR)) {
  console.error(`ERROR: Build directory not found: ${BUILD_DIR}`);
  process.exit(1);
}

if (REVERT) {
  console.log(`Reverting Antigravity patches in ${BUILD_DIR}...`);
  let restored = 0;
  function revertDir(d) {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) {
        revertDir(p);
      } else if (f.endsWith(BAK_EXT)) {
        const orig = p.slice(0, -BAK_EXT.length);
        fs.copyFileSync(p, orig);
        fs.unlinkSync(p);
        console.log(`[RESTORED] ${orig}`);
        restored++;
      }
    }
  }
  revertDir(SERVER_DIR);
  revertDir(STATIC_DIR);
  console.log(`Revert finished. Restored ${restored} files.`);
  process.exit(0);
}

const PATCHES = [
  // 1. Shared constants (8499.js in server/ and server/chunks/)
  {
    name: "8499 shared constants",
    files: ["server/8499.js", "server/chunks/8499.js"],
    marker: "process.env.ANTIGRAVITY_VERSION||",
    needle: 'o="2.24.0",p="https://daily-cloudcode-pa.googleapis.com",q=`antigravity/hub/${o} darwin/arm64`',
    replacement:
      'o=process.env.ANTIGRAVITY_VERSION||"2.29.1",p="https://daily-cloudcode-pa.googleapis.com",q=`antigravity/hub/${o} ${process.platform==="win32"?"windows":process.platform==="darwin"?"darwin":"linux"}/${process.arch==="x64"?"amd64":process.arch==="arm64"?"arm64":process.arch}`',
  },
  // 2. AntigravityExecutor.buildHeaders (2380.js)
  {
    name: "2380 buildHeaders X-Client-Version",
    files: ["server/2380.js", "server/chunks/2380.js"],
    marker: '"X-Client-Version":process.env.ANTIGRAVITY_VERSION||',
    needle:
      'buildHeaders(a,b=!0,c=null){return{"Content-Type":"application/json",Authorization:`Bearer ${a.accessToken}`,"User-Agent":this.config.headers?.["User-Agent"]||h.K["User-Agent"]}}',
    replacement:
      'buildHeaders(a,b=!0,c=null){return{"Content-Type":"application/json",Authorization:`Bearer ${a.accessToken}`,"User-Agent":this.config.headers?.["User-Agent"]||h.K["User-Agent"],"X-Client-Version":process.env.ANTIGRAVITY_VERSION||"2.29.1"}}',
  },
  // 3. Provider test fallback User-Agent (8896.js)
  {
    name: "8896 testUtils UA fallback",
    files: ["server/8896.js", "server/chunks/8896.js"],
    marker: 'd="antigravity"===a.provider?p.YT.loadCodeAssistUserAgent||`antigravity/hub/',
    needle:
      'd="antigravity"===a.provider?p.YT.loadCodeAssistUserAgent||"antigravity/hub/2.24.0 darwin/arm64":"google-api-nodejs-client/9.15.1 gemini-cli/0.34.0"',
    replacement:
      'd="antigravity"===a.provider?p.YT.loadCodeAssistUserAgent||`antigravity/hub/${process.env.ANTIGRAVITY_VERSION||"2.29.1"} ${process.platform==="win32"?"windows":process.platform==="darwin"?"darwin":"linux"}/${process.arch==="x64"?"amd64":process.arch==="arm64"?"arm64":process.arch}`:"google-api-nodejs-client/9.15.1 gemini-cli/0.34.0"',
  },
  // 4. Provider metadata in 2598.js
  {
    name: "2598 provider metadata UA",
    files: ["server/2598.js", "server/chunks/2598.js"],
    marker: 'g=`antigravity/hub/${process.env.ANTIGRAVITY_VERSION||',
    needle: 'g="antigravity/hub/2.24.0 darwin/arm64",h={id:"antigravity",priority:20,alias:"ag"',
    replacement:
      'g=`antigravity/hub/${process.env.ANTIGRAVITY_VERSION||"2.29.1"} ${process.platform==="win32"?"windows":process.platform==="darwin"?"darwin":"linux"}/${process.arch==="x64"?"amd64":process.arch==="arm64"?"arm64":process.arch}`,h={id:"antigravity",priority:20,alias:"ag"',
  },
  // 5. Provider metadata in 4480.js
  {
    name: "4480 provider metadata UA",
    files: ["server/4480.js", "server/chunks/4480.js"],
    marker: 'g=`antigravity/hub/${process.env.ANTIGRAVITY_VERSION||',
    needle: 'g="antigravity/hub/2.24.0 darwin/arm64",h={id:"antigravity",priority:20,alias:"ag"',
    replacement:
      'g=`antigravity/hub/${process.env.ANTIGRAVITY_VERSION||"2.29.1"} ${process.platform==="win32"?"windows":process.platform==="darwin"?"darwin":"linux"}/${process.arch==="x64"?"amd64":process.arch==="arm64"?"arm64":process.arch}`,h={id:"antigravity",priority:20,alias:"ag"',
  },
];

console.log(`Applying Antigravity patches to: ${BUILD_DIR}`);
console.log(`Dry run: ${DRY_RUN}`);

let totalPatched = 0;
for (const patch of PATCHES) {
  for (const relFile of patch.files) {
    const fullPath = path.join(BUILD_DIR, relFile);
    if (!fs.existsSync(fullPath)) {
      console.log(`[SKIP] Missing: ${relFile}`);
      continue;
    }
    const content = fs.readFileSync(fullPath, "utf8");
    if (content.includes(patch.marker)) {
      console.log(`[ALREADY] ${relFile} (${patch.name})`);
      continue;
    }
    const count = content.split(patch.needle).length - 1;
    if (count !== 1) {
      console.error(`[ERROR] ${relFile}: expected 1 occurrence of needle for ${patch.name}, found ${count}`);
      process.exit(1);
    }
    if (!DRY_RUN) {
      const bakPath = fullPath + BAK_EXT;
      if (!fs.existsSync(bakPath)) {
        fs.copyFileSync(fullPath, bakPath);
      }
      const newContent = content.replace(patch.needle, patch.replacement);
      fs.writeFileSync(fullPath, newContent, "utf8");
      console.log(`[PATCHED] ${relFile} (${patch.name})`);
      totalPatched++;
    } else {
      console.log(`[WOULD PATCH] ${relFile} (${patch.name})`);
      totalPatched++;
    }
  }
}

// Static chunk for UI
const staticChunksDir = path.join(STATIC_DIR, "chunks");
if (fs.existsSync(staticChunksDir)) {
  const staticFiles = fs.readdirSync(staticChunksDir).filter((f) => f.startsWith("1321-") && f.endsWith(".js") && !f.includes(".bak"));
  for (const sf of staticFiles) {
    const fullPath = path.join(staticChunksDir, sf);
    const content = fs.readFileSync(fullPath, "utf8");
    const marker = 's="antigravity/hub/2.29.1';
    if (content.includes(marker)) {
      console.log(`[ALREADY] static/${sf}`);
      continue;
    }
    const needle = 's="antigravity/hub/2.24.0 darwin/arm64",r={id:"antigravity",priority:20,alias:"ag"';
    const rep = 's="antigravity/hub/2.29.1 windows/amd64",r={id:"antigravity",priority:20,alias:"ag"';
    if (content.includes(needle)) {
      if (!DRY_RUN) {
        const bak = fullPath + BAK_EXT;
        if (!fs.existsSync(bak)) fs.copyFileSync(fullPath, bak);
        fs.writeFileSync(fullPath, content.replace(needle, rep), "utf8");
        console.log(`[PATCHED] static/${sf}`);
        totalPatched++;
      } else {
        console.log(`[WOULD PATCH] static/${sf}`);
        totalPatched++;
      }
    }
  }
}

console.log(`\nDone. Patched ${totalPatched} target locations.`);
