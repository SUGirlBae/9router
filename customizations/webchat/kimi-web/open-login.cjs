/**
 * Headful persistent Chrome at kimi.com for REAL user login.
 * - Detects login by: login/sign-in buttons gone AND chat input present.
 * - Writes READY file when logged in; closes GRACEFULLY (ctx.close) when CLOSE file appears,
 *   so cookies flush to the profile dir.
 * Usage: node open-login.cjs   (background). User logs in; agent touches CLOSE file to finish.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const PW_PATH = process.env.PLAYWRIGHT_PATH || "C:/Users/Administrator/.9router/runtime/node_modules/playwright-core";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PROFILE = process.env.KIMI_BROWSER_PROFILE_PATH || "C:/Users/Administrator/.9router/browser-profiles/kimi";
const DIR = __dirname;
const READY = path.join(DIR, "login-ready.txt");
const CLOSE = path.join(DIR, "login-close.txt");
for (const f of [READY, CLOSE]) { try { fs.unlinkSync(f); } catch {} }
(async () => {
  const pw = require(PW_PATH);
  const ctx = await pw.chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: CHROME, args: ["--disable-blink-features=AutomationControlled"] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://www.kimi.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("[login] window open; waiting for real login...");
  const timer = setInterval(async () => {
    if (fs.existsSync(CLOSE)) { clearInterval(timer); console.log("[login] CLOSE signal; flushing cookies..."); await ctx.close(); process.exit(0); }
    try {
      const loginBtn = await page.getByText(/log in|sign in|đăng nhập/i).count();
      const input = await page.locator('[contenteditable="true"], textarea').count();
      if (loginBtn === 0 && input > 0) { fs.writeFileSync(READY, new Date().toISOString()); console.log("[login] REAL login detected (no login btn, chat input present). READY written."); }
    } catch {}
  }, 4000);
})().catch(e => { console.error("[login] ERR", e.message); process.exit(1); });