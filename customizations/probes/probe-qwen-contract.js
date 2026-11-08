const { chromium } = require("C:/Users/Administrator/.9router/runtime/node_modules/playwright-core");
const fs = require("fs");

const PROFILE = "C:/Users/Administrator/.9router/browser-profiles/qwen";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "C:/Users/Administrator/Documents/Qoder/2026-11-03/10707d32/qwen-chat-contract.json";

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, executablePath: CHROME, viewport: null, args: ["--disable-blink-features=AutomationControlled"] });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const calls = [];
  page.on("request", (req) => {
    const u = req.url();
    if (!/chat\.qwen\.ai\/api\/v2\/(chat\/completions|chats)/.test(u)) return;
    calls.push({ url: u, method: req.method(), headers: req.headers(), post: req.postData() });
  });
  const resps = [];
  page.on("response", async (r) => {
    if (!/chat\.qwen\.ai\/api\/v2\/chat\/completions/.test(r.url())) return;
    try { resps.push({ status: r.status(), ct: r.headers()["content-type"], body: (await r.text()).slice(0, 2500) }); } catch {}
  });

  await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(14000);

  const box = page.locator("textarea").first();
  console.log("textarea:", await box.count(), "| url:", page.url());
  await box.click({ timeout: 15000 }).catch((e) => console.log("click:", e.message));
  await box.fill("Reply with exactly: CONTRACT_PROBE").catch((e) => console.log("fill:", e.message));
  await page.waitForTimeout(1500);
  await page.keyboard.press("Enter").catch((e) => console.log("enter:", e.message));
  await page.waitForTimeout(25000);

  const visible = await page.evaluate(() => document.body.innerText.slice(-700));
  console.log("\ncaptured requests:", calls.length, "| responses:", resps.length);
  for (const c of calls) {
    console.log("\n->", c.method, c.url);
    console.log("   body:", String(c.post).slice(0, 1400));
    const auth = Object.entries(c.headers).filter(([k]) => /authorization|cookie|x-request|token|user-agent/i.test(k)).map(([k, v]) => `${k}=${String(v).slice(0, 45)}…(${String(v).length})`);
    console.log("   headers:", auth.join(" | "));
  }
  for (const r of resps) console.log("\n<- HTTP", r.status, "[", r.ct, "]\n", String(r.body).slice(0, 1200).replace(/\n/g, " "));

  // direct OpenAI-style probe with the bearer token
  const tok = await page.evaluate(() => localStorage.getItem("token"));
  const direct = await page.evaluate(async ({ tok }) => {
    const out = {};
    for (const body of [
      { model: "qwen3.7-plus", messages: [{ role: "user", content: "Reply with exactly: DIRECT-OPENAI" }], stream: true },
      { model: "qwen3.7-plus", messages: [{ role: "user", content: "Reply with exactly: DIRECT-NOSTREAM" }], stream: false },
    ]) {
      const r = await fetch("https://chat.qwen.ai/api/v2/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      out[body.stream ? "stream" : "nonstream"] = { status: r.status, ct: r.headers.get("content-type"), text: (await r.text()).slice(0, 900) };
    }
    return out;
  }, { tok });
  console.log("\n=== direct OpenAI-style probe ===");
  for (const [k, v] of Object.entries(direct)) console.log(`\n[${k}] HTTP ${v.status} [${v.ct}]\n${String(v.text).slice(0, 700).replace(/\n/g, " ")}`);

  fs.writeFileSync(OUT, JSON.stringify({ calls, resps, direct, pageTail: visible }, null, 1));
  await ctx.close();
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
