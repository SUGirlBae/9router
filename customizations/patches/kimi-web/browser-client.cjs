/**
 * Kimi Web Browser Client - UI-driven capture (same proven pattern as qwen).
 * Kimi chat input is a contenteditable div (not textarea). Captures the real
 * /api/chat/{id}/completion/stream response with genuine cookies/TLS.
 */
"use strict";
const PW_PATH = process.env.PLAYWRIGHT_PATH || "C:/Users/Administrator/.9router/runtime/node_modules/playwright-core";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PROFILE = process.env.KIMI_BROWSER_PROFILE_PATH || "C:/Users/Administrator/.9router/browser-profiles/kimi";

async function chatViaBrowser({ messages, profilePath = PROFILE, timeoutMs = 90000 }) {
  const pw = require(PW_PATH);
  const ctx = await pw.chromium.launchPersistentContext(profilePath, {
    headless: true, executablePath: CHROME, args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto("https://www.kimi.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(8000);
    const prompt = messages.map(m => (typeof m.content === "string" ? m.content : "")).join("\n").slice(0, 2000);
    const box = page.locator('[contenteditable="true"]').first();
    await box.click({ timeout: 15000 });
    await box.fill(prompt);
    await page.waitForTimeout(1000);
    const respPromise = page.waitForResponse(r => /\/api\/chat\/.+\/completion\/stream/.test(r.url()) && r.request().method() === "POST", { timeout: timeoutMs });
    await page.keyboard.press("Enter");
    const resp = await respPromise;
    const text = await resp.text();
    return { status: resp.status(), contentType: resp.headers()["content-type"] || "", text };
  } finally {
    await ctx.close().catch(() => {});
  }
}
module.exports = { chatViaBrowser };