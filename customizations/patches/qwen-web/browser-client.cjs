/**
 * Qwen Web Browser Client - executes the completion fetch INSIDE the logged-in
 * browser page so cookies, origin and TLS fingerprint are genuine. Direct Node
 * fetch triggers Alibaba anti-bot (FAIL_SYS_USER_VALIDATE / RGV587_ERROR).
 * Returns {status, contentType, text} for offline SSE parsing.
 */
"use strict";
const PW_PATH = process.env.PLAYWRIGHT_PATH || "C:/Users/Administrator/.9router/runtime/node_modules/playwright-core";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PROFILE = process.env.QWEN_BROWSER_PROFILE_PATH || "C:/Users/Administrator/.9router/browser-profiles/qwen";

async function chatViaBrowser({ model = "qwen3.7-plus", messages, stream = true, profilePath = PROFILE, timeoutMs = 60000 }) {
  const pw = require(PW_PATH);
  const ctx = await pw.chromium.launchPersistentContext(profilePath, {
    headless: true, executablePath: CHROME, args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(5000);
    const result = await page.evaluate(async ({ model, messages, stream }) => {
      const tok = localStorage.getItem("token");
      if (!tok) return { status: 0, contentType: "", text: "NO_TOKEN" };
      const r = await fetch("/api/v2/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, stream }),
      });
      return { status: r.status, contentType: r.headers.get("content-type") || "", text: await r.text() };
    }, { model, messages, stream });
    return result;
  } finally {
    await ctx.close();
  }
}

module.exports = { chatViaBrowser };