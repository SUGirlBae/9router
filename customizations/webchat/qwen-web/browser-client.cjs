/**
 * Qwen Web Browser Client - UI-driven capture (proven pattern from probe-qwen-contract.js).
 * Types the prompt into the chat textarea, presses Enter, and captures the real
 * /api/v2/chat/completions response via waitForResponse. Inherits genuine cookies,
 * bx-anti-bot tokens and TLS fingerprint; avoids Alibaba FAIL_SYS_USER_VALIDATE.
 * Returns {status, contentType, text}.
 */
"use strict";
const PW_PATH = process.env.PLAYWRIGHT_PATH || "C:/Users/Administrator/.9router/runtime/node_modules/playwright-core";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PROFILE = process.env.QWEN_BROWSER_PROFILE_PATH || "C:/Users/Administrator/.9router/browser-profiles/qwen";

async function chatViaBrowser({ model = "qwen3.7-plus", messages, stream = true, profilePath = PROFILE, timeoutMs = 90000 }) {
  const pw = require(PW_PATH);
  const ctx = await pw.chromium.launchPersistentContext(profilePath, {
    headless: true, executablePath: CHROME, args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    console.log("[browser-client] goto...");
    await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(8000);
    const prompt = messages.map(m => (typeof m.content === "string" ? m.content : "")).join("\n").slice(0, 2000);
    const box = page.locator("textarea").first();
    await box.click({ timeout: 15000 });
    await box.fill(prompt);
    await page.waitForTimeout(1000);
    console.log("[browser-client] send + waitForResponse...");
    const respPromise = page.waitForResponse(r => /\/api\/v2\/chat\/completions/.test(r.url()) && r.request().method() === "POST", { timeout: timeoutMs });
    await page.keyboard.press("Enter");
    const resp = await respPromise;
    const text = await resp.text();
    console.log("[browser-client] captured status=", resp.status());
    return { status: resp.status(), contentType: resp.headers()["content-type"] || "", text };
  } finally {
    await ctx.close().catch(() => {});
  }
}

module.exports = { chatViaBrowser };