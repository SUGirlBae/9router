const { chromium } = require("C:/Users/Administrator/.9router/runtime/node_modules/playwright-core");
const fs = require("fs");

const PROFILE = process.env.PROFILE || "C:/Users/Administrator/.9router/browser-profiles/default";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "C:/Users/Administrator/Documents/Qoder/2026-11-03/10707d32/qwen-net.json";

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, executablePath: CHROME, viewport: null,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const hits = [];

  ctx.on("request", (req) => {
    const u = req.url();
    if (!/chat\.qwen\.ai|qwen\.ai|api\.qwen/.test(u)) return;
    if (/\.js|\.css|\.png|\.svg|\.woff|\.ico|\.webp/.test(u)) return;
    hits.push({ dir: "req", method: req.method(), url: u, headers: req.headers(), post: req.postData() });
  });
  ctx.on("response", async (r) => {
    const u = r.url();
    if (!/chat\.qwen\.ai|api\.qwen/.test(u)) return;
    if (/\.js|\.css|\.png|\.svg|\.woff|\.ico|\.webp/.test(u)) return;
    let body = "";
    try { body = (await r.text()).slice(0, 900); } catch (e) { body = "<unreadable>"; }
    hits.push({ dir: "res", status: r.status(), url: u, ct: r.headers()["content-type"], body });
  });

  await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 90000 }).catch((e) => console.log("goto:", e.message));
  await page.waitForTimeout(18000);

  const state = await page.evaluate(() => ({
    url: location.href,
    lsKeys: Object.keys(localStorage),
    cookies: document.cookie.split(";").map((c) => c.split("=")[0].trim()),
    hasTextarea: !!document.querySelector("textarea"),
    bodyHead: document.body.innerText.slice(0, 300),
  }));

  fs.writeFileSync(OUT, JSON.stringify(hits, null, 1));
  console.log("url:", state.url);
  console.log("textarea:", state.hasTextarea);
  console.log("localStorage keys:", state.lsKeys.join(", "));
  console.log("cookie names:", state.cookies.join(", "));
  console.log("body:", JSON.stringify(state.bodyHead));
  console.log("\nnetwork hits:", hits.length);
  for (const h of hits.slice(0, 25)) {
    if (h.dir === "req") console.log(`  -> ${h.method} ${h.url.slice(0, 120)}`);
    else console.log(`  <- ${h.status} ${h.url.slice(0, 110)} [${h.ct}] ${String(h.body).slice(0, 140).replace(/\n/g, " ")}`);
  }
  await ctx.close();
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
