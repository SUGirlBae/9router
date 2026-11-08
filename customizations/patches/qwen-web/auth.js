/**
 * Qwen Web Auth Module - extract Bearer token + cookies from Chrome profile
 * No hardcoded secrets; reads from user-provided browser profile path.
 */
"use strict";
const fs = require("fs");
const path = require("path");
// Lazy-load playwright only when browser functions are called (offline tests don't need it)
function loadPlaywright() {
  return require(process.env.PLAYWRIGHT_PATH || "C:/Users/Administrator/.9router/runtime/node_modules/playwright-core");
}

// Default profile path (configurable via env or CLI arg)
const DEFAULT_PROFILE = "/c/Users/Administrator/.9router/browser-profiles/qwen";

async function getBearerToken(profilePath = DEFAULT_PROFILE) {
  const playwright = loadPlaywright();
  const ctx = await playwright.chromium.launchPersistentContext(profilePath, {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });
    const token = await page.evaluate(() => localStorage.getItem("token"));
    if (!token || typeof token !== "string" || token.trim().length < 20) {
      throw new Error("No valid token found in localStorage");
    }
    return token;
  } finally {
    await ctx.close();
  }
}

async function getCookieJar(profilePath = DEFAULT_PROFILE) {
  const ctx = await chromium.launchPersistentContext(profilePath, { headless: true });
  try {
    const cookies = await ctx.cookies("https://chat.qwen.ai");
    // Return as header string: name=value; ...
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } finally {
    await ctx.close();
  }
}

function validateToken(token) {
  if (!token || typeof token !== "string") return false;
  // Reject logged-out placeholder like {"value": null, "__version": "0"}
  try {
    const parsed = JSON.parse(token);
    if (parsed && typeof parsed === "object") {
      return typeof parsed.value === "string" && parsed.value.trim().length >= 20;
    }
  } catch {}
  return token.trim().length >= 20;
}

module.exports = { getBearerToken, getCookieJar, validateToken, DEFAULT_PROFILE };