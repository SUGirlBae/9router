const { chromium } = require("C:/Users/Administrator/.9router/runtime/node_modules/playwright-core");
const fs = require("fs");

const PROFILE = "C:/Users/Administrator/.9router/browser-profiles/qwen";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DIR = "C:/Users/Administrator/Documents/Qoder/2026-11-03/10707d32";
const JSONL = DIR + "/qwen-ui-requests.jsonl";
const OUT = DIR + "/qwen-chat-contract.json";
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

(async () => {
  fs.rmSync(JSONL, { force: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, executablePath: CHROME, viewport: null, args: ["--disable-blink-features=AutomationControlled"] });
  const page = ctx.pages()[0] || (await ctx.newPage());

  page.on("request", (req) => {
    const u = req.url();
    if (!/chat\.qwen\.ai\/api\/v2\/(chat\/completions|chats\/)/.test(u)) return;
    fs.appendFileSync(JSONL, JSON.stringify({ t: Date.now(), url: u, method: req.method(), headers: req.headers(), post: req.postData() }) + "\n");
    log("UI request captured:", req.method(), u.slice(0, 60));
  });

  await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => log("goto:", e.message));
  await page.waitForTimeout(12000);

  const box = page.locator("textarea").first();
  const n = await box.count().catch(() => 0);
  log("textarea count:", n, "| url:", page.url().slice(0, 70));
  if (n) {
    await box.click({ timeout: 8000 }).catch((e) => log("click:", e.message.split("\n")[0]));
    await box.fill("Reply with exactly: CONTRACT_PROBE").catch((e) => log("fill:", e.message.split("\n")[0]));
    await page.waitForTimeout(1200);
    await page.keyboard.press("Enter").catch(() => {});
    for (let i = 0; i < 12 && !fs.existsSync(JSONL); i++) await page.waitForTimeout(2500);
  }

  const uiReqs = fs.existsSync(JSONL) ? fs.readFileSync(JSONL, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  log("UI chat requests captured:", uiReqs.length);

  // bounded direct probe: read SSE incrementally, hard stop
  const tok = await page.evaluate(() => localStorage.getItem("token"));
  const direct = await page.evaluate(async ({ tok }) => {
    const readBounded = async (body, msCap) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort("cap"), msCap);
      try {
        const r = await fetch("https://chat.qwen.ai/api/v2/chat/completions", {
          method: "POST", signal: ac.signal,
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify(body),
        });
        const ct = r.headers.get("content-type");
        let text = "";
        if (r.body) {
          const rd = r.body.getReader();
          const dec = new TextDecoder();
          const end = Date.now() + msCap;
          while (Date.now() < end && text.length < 6000) {
            const { done, value } = await rd.read();
            if (done) break;
            text += dec.decode(value, { stream: true });
          }
          try { rd.cancel(); } catch {}
        }
        return { status: r.status, ct, text };
      } catch (e) {
        return { status: 0, ct: null, text: "ABORTED/ERR: " + String(e?.message || e) };
      } finally { clearTimeout(timer); }
    };
    return {
      stream: await readBounded({ model: "qwen3.7-plus", messages: [{ role: "user", content: "Reply with exactly: DIRECT-STREAM" }], stream: true }, 30000),
      nonstream: await readBounded({ model: "qwen3.7-plus", messages: [{ role: "user", content: "Reply with exactly: DIRECT-PLAIN" }], stream: false }, 30000),
    };
  }, { tok });

  for (const [k, v] of Object.entries(direct)) log(`direct[${k}] HTTP ${v.status} ct=${v.ct} len=${v.text.length}`);

  fs.writeFileSync(OUT, JSON.stringify({ uiReqs, direct, tokenLen: tok ? tok.length : 0 }, null, 1));
  console.log("\n=== UI request body (first) ===");
  console.log(uiReqs.length ? String(uiReqs[0].post).slice(0, 1200) : "(none captured)");
  console.log("\n=== direct stream head ===\n" + direct.stream.text.slice(0, 900));
  console.log("\n=== direct nonstream head ===\n" + direct.nonstream.text.slice(0, 900));
  await ctx.close();
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
