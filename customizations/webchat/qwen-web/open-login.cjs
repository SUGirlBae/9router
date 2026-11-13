/**
 * Headful Chrome Login Helper for Qwen-Web (D:\9router)
 * Opens https://chat.qwen.ai/ in a visible Chrome window on the shared qwen profile,
 * waits for the user to log in (detects valid `token` in localStorage),
 * updates D:\9router\data\db\data.sqlite + unlocks all Qwen models,
 * and gracefully closes the browser so the headless Warm Pool can take over.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { cleanupProfileLock } = require("./browser-client.cjs");

const PW_PATH = process.env.PLAYWRIGHT_PATH || "C:/Users/Administrator/.9router/runtime/node_modules/playwright-core";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PROFILE = process.env.QWEN_BROWSER_PROFILE_PATH || "D:/9router/data/browser-profiles/default";
const DB_PATH = process.env.QWEN_DB_PATH || "D:/9router/data/db/data.sqlite";

function extractValidToken(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.value === "string" && parsed.value.trim().length >= 20) {
        return parsed.value.trim();
      }
      return null;
    }
  } catch {}
  return trimmed.length >= 20 ? trimmed : null;
}

function saveTokenToDb(token) {
  if (!fs.existsSync(DB_PATH)) return false;
  const db = new DatabaseSync(DB_PATH);
  try {
    const row = db.prepare("SELECT * FROM providerConnections WHERE provider = 'qwen-web'").get();
    const nowIso = new Date().toISOString();
    if (row) {
      let data = {};
      try {
        data = JSON.parse(row.data || "{}");
      } catch {}
      data.apiKey = token;
      data.testStatus = "active";
      data.lastError = null;
      data.lastErrorAt = null;
      data.errorCode = null;
      data.rateLimitedUntil = null;
      data.backoffLevel = 0;
      for (const k of Object.keys(data)) {
        if (k.startsWith("modelLock_")) data[k] = null;
      }
      db.prepare("UPDATE providerConnections SET isActive = 1, data = ?, updatedAt = ? WHERE id = ?").run(
        JSON.stringify(data),
        nowIso,
        row.id
      );
      return true;
    }
    return false;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

(async () => {
  const pw = require(PW_PATH);
  cleanupProfileLock(PROFILE, true);

  console.log("[qwen-login] Opening Chrome window at https://chat.qwen.ai/ ...");
  const ctx = await pw.chromium.launchPersistentContext(PROFILE, {
    headless: false,
    executablePath: CHROME,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("[qwen-login] Please log in to your Qwen account in the opened Chrome window...");

  const deadline = Date.now() + 5 * 60 * 1000; // 5 minutes
  while (Date.now() < deadline) {
    if (page.isClosed()) {
      console.log("[qwen-login] Window was closed by user.");
      break;
    }
    try {
      const rawToken = await page.evaluate(() => {
        try {
          return localStorage.getItem("token");
        } catch {
          return null;
        }
      });
      const validToken = extractValidToken(rawToken);
      if (validToken) {
        console.log(`[qwen-login] Login detected! Token length=${validToken.length}. Saving to database...`);
        saveTokenToDb(validToken);
        await new Promise((r) => setTimeout(r, 1500));
        await ctx.close();
        console.log("[qwen-login] LOGIN_SUCCESS — Chrome closed and profile unlocked for 9router Warm Pool.");
        process.exit(0);
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }

  try {
    await ctx.close();
  } catch {}
  console.error("[qwen-login] Login timed out or window closed before token was found.");
  process.exit(1);
})().catch((err) => {
  console.error("[qwen-login] Error:", err.message);
  process.exit(1);
});
