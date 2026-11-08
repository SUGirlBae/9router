const fs = require("fs");
const path = require("path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const CHUNK = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router/app/.next-cli-build/server/chunks/6690.js";
const RUNTIME_PKG = "C:/Users/Administrator/.9router/runtime/package.json";

(async () => {
  const src = fs.readFileSync(CHUNK, "utf8");

  // Reproduce the loader's fallback branch exactly as shipped:
  // createRequire(<runtime>/package.json).resolve("playwright-core") -> import(fileURL)
  const req = createRequire(RUNTIME_PKG);
  const entry = req.resolve("playwright-core");
  console.log("fallback resolves to CJS entry:", path.basename(entry));
  let ns = await import(pathToFileURL(entry).href);

  // If the patch is present, run the real helper code extracted from the shipped bundle.
  const helper = src.match(/function __9rEsmNs\(a\)\{[\s\S]*?return a\}/);
  if (helper) {
    console.log("patched helper found -> applying it");
    ns = eval(helper[0] + "; __9rEsmNs(ns)");
  } else {
    console.log("no patch present -> using raw namespace");
  }

  const chromium = ns.chromium;
  console.log("typeof chromium:", typeof chromium);
  console.log("typeof chromium?.launchPersistentContext:", typeof chromium?.launchPersistentContext);

  if (!chromium || typeof chromium.launchPersistentContext !== "function") {
    console.error("FAIL: would throw \"Cannot read properties of undefined (reading 'launchPersistentContext')\"");
    process.exit(1);
  }
  console.log("PASS: web-login can call chromium.launchPersistentContext()");
})().catch((e) => {
  console.error("FAIL (probe error):", e.message);
  process.exit(1);
});
