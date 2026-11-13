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
  let ctx;
  try {
    ctx = await playwright.chromium.launchPersistentContext(profilePath, {
      headless: true,
      executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch(e){ throw new Error("Failed to launch browser: "+e.message); }
  if(!ctx.pages().length){ await ctx.newPage(); }
  const page = ctx.pages()[0];
  await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(10000); // extra hydration time
  let token = null;
  try{
    await page.waitForFunction(()=>{const t=localStorage.getItem("token");return typeof t==="string";},{timeout:30000});
    token = await page.evaluate(()=>localStorage.getItem("token"));
  }catch(e){ console.warn("waitForFunction failed:",e.message); }
  if(!validateToken(token)){
    console.warn("Token state:",{exists:!!token, type:typeof token,len:token?token.length:0, val:token&&token.slice(0,40)});
    throw new Error("No valid token found in localStorage");
  }
  console.log("Token loaded successfully len=",token.length);
  await ctx.close();
  return token;
}

async function getCookieJar(profilePath = DEFAULT_PROFILE) {
  const playwright = loadPlaywright();
  const ctx = await playwright.chromium.launchPersistentContext(profilePath, { headless: true });
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