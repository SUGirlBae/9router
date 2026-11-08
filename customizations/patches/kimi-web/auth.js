/**
 * Kimi Web Auth - extract session token from browser cookies/localStorage
 * Profile path via env KIMI_BROWSER_PROFILE_PATH or default in .9router/browser-profiles/kimi
 */
"use strict";
const DEFAULT = process.env.KIMI_BROWSER_PROFILE_PATH || "/c/Users/Administrator/.9router/browser-profiles/kimi";

function loadPlaywright() { return require(process.env.PLAYWRIGHT_PATH || "C:/Users/Administrator/.9router/runtime/node_modules/playwright-core"); }

async function getSessionToken(profilePath = DEFAULT) {
  const pw = loadPlaywright();
  const ctx = await pw.chromium.launchPersistentContext(profilePath, { headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto("https://www.kimi.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    // Try localStorage first (token), then cookie
    const tok = await page.evaluate(() => localStorage.getItem("token"));
    if (tok && typeof tok === "string" && tok.length >= 30) return tok;
    const c = await ctx.cookies("https://www.kimi.com");
    const auth = c.find(x => /session|access|bearer/i.test(x.name));
    if (auth && typeof auth.value === "string") return auth.value;
    throw new Error("No valid kim.com session token found");
  } finally { await ctx.close(); }
}

function validateToken(t) { if (!t || typeof t !== "string") return false; try { const p = JSON.parse(t); if (p && typeof p === "object") return typeof p.token === "string"; } catch {} return t.trim().length >= 30; }

module.exports = { getSessionToken, validateToken, DEFAULT };