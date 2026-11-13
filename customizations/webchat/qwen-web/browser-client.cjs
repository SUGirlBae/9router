/**
 * Qwen Web Browser Client — @notebooklm-style storage_state.json + UI-Driven CDP Stream Interceptor
 *
 * Why this architecture:
 * 1. Alibaba's Baxia anti-bot (`RGV587_ERROR`) blocks raw `fetch('/api/v2/chat/completions')`
 *    even inside `page.evaluate`, because `bx-ua`/`bx-umidtoken`/`bx-v` are only signed when
 *    triggered through Qwen's UI submission (`textarea.message-input-textarea` + `button.send-button`).
 * 2. Modeled after `@notebooklm`: authentication is decoupled into `qwen-storage-state.json`
 *    (`browser.newContext({ storageState })`), eliminating `--user-data-dir` lock collisions
 *    (`exitCode=21`) and protecting the worker from `[webLogin] pruned ... from profile default`.
 * 3. CDP (`Fetch.enable` at `Response` stage -> `Fetch.takeResponseBodyAsStream` -> `IO.read`)
 *    streams the SSE response chunks in real time with zero full-response buffering.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { resolveQwenAgentOptions, formatMessagesForUiPrompt } = require("./qwen-tools.cjs");

const PW_PATH = process.env.PLAYWRIGHT_PATH || "C:/Users/Administrator/.9router/runtime/node_modules/playwright-core";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

function resolveDefaultProfile() {
  if (process.env.QWEN_BROWSER_PROFILE_PATH && fs.existsSync(process.env.QWEN_BROWSER_PROFILE_PATH)) {
    return process.env.QWEN_BROWSER_PROFILE_PATH;
  }
  const candidates = [
    process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "browser-profiles", "default") : null,
    "D:/9router/data/browser-profiles/default",
    "D:/9router/appdata/browser-profiles/qwen",
    "C:/Users/Administrator/.9router/browser-profiles/qwen",
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "D:/9router/data/browser-profiles/default";
}

function resolveStorageStatePath() {
  if (process.env.QWEN_STORAGE_STATE_PATH) return process.env.QWEN_STORAGE_STATE_PATH;
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, "qwen-storage-state.json");
  return "D:/9router/data/qwen-storage-state.json";
}

const DEFAULT_PROFILE = resolveDefaultProfile();
const DEFAULT_STORAGE_STATE = resolveStorageStatePath();
const DEFAULT_IDLE_TIMEOUT_MS = Number(process.env.QWEN_POOL_IDLE_MS || 90000);
const DEFAULT_STALL_TIMEOUT_MS = Number(process.env.QWEN_STREAM_STALL_MS || 120000);

function cleanupProfileLock(profilePath, force = false) {
  if (!profilePath) return;
  const lock = path.join(profilePath, "lockfile");
  if (!force && !fs.existsSync(lock)) return;
  try {
    const resolved = path.resolve(profilePath);
    // Encode command as UTF-16LE Base64 for PowerShell -EncodedCommand to eliminate injection risks
    const psScript = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*${resolved.replace(/'/g, "''")}*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    const { execFileSync } = require("node:child_process");
    execFileSync("powershell", ["-NoProfile", "-EncodedCommand", encoded], { stdio: "ignore", windowsHide: true, timeout: 5000 });
  } catch {}
  try {
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
  } catch {}
}

/**
 * Syncs cookies + localStorage from a persistent Chrome profile into `qwen-storage-state.json`
 * (equivalent to `notebooklm auth refresh --browser-cookies`).
 */
async function syncStorageStateFromProfile(profilePath = DEFAULT_PROFILE, statePath = DEFAULT_STORAGE_STATE) {
  const pw = require(PW_PATH);
  cleanupProfileLock(profilePath);
  const ctx = await pw.chromium.launchPersistentContext(profilePath, {
    headless: true,
    executablePath: CHROME,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => !!localStorage.getItem("token"), { timeout: 10000 }).catch(() => {});
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const state = await ctx.storageState({ path: statePath });
    return state;
  } finally {
    await ctx.close().catch(() => {});
  }
}

let queuePromise = Promise.resolve();
function enqueue(fn) {
  const next = queuePromise.then(fn, fn);
  queuePromise = next.catch(() => {});
  return next;
}

/**
 * Read response body chunks from a paused CDP Fetch request via IO.read stream handle.
 * A per-read stall watchdog aborts hung upstream streams (no chunk within stallTimeoutMs),
 * and an AbortSignal race allows immediate client-side cancellation.
 */
async function* readCDPStreamChunks(cdp, requestId, signal, stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS) {
  const { stream: handle } = await cdp.send("Fetch.takeResponseBodyAsStream", { requestId });
  let stallTimer = null;
  const clearStall = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  let onAbortListener = null;
  const abortPromise = new Promise((_, rej) => {
    if (signal?.aborted) rej(new Error("Request aborted"));
    else {
      onAbortListener = () => rej(new Error("Request aborted"));
      signal?.addEventListener("abort", onAbortListener, { once: true });
    }
  });

  try {
    while (true) {
      if (signal?.aborted) break;
      const readPromise = cdp.send("IO.read", { handle });
      // Suppress UnhandledPromiseRejection if stall or abort wins the race
      readPromise.catch(() => {});

      const stallPromise = new Promise((_, rej) => {
        clearStall();
        stallTimer = setTimeout(
          () => rej(new Error(`CDP stream stall: no chunk received within ${stallTimeoutMs}ms`)),
          stallTimeoutMs
        );
      });

      let result;
      try {
        result = await Promise.race([readPromise, stallPromise, abortPromise]);
      } finally {
        clearStall();
      }

      const { data, base64Encoded, eof } = result;
      if (data) {
        const text = base64Encoded ? Buffer.from(data, "base64").toString("utf8") : data;
        if (text) yield text;
      }
      if (eof) break;
    }
  } finally {
    clearStall();
    if (onAbortListener && signal) {
      signal.removeEventListener("abort", onAbortListener);
    }
    try {
      await cdp.send("IO.close", { handle });
    } catch {}
  }
}

class QwenBrowserPool {
  constructor(options = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
    this.launcher = options.launcher || null;
    this.storageStatePath = options.storageStatePath || DEFAULT_STORAGE_STATE;
    this.browser = null;
    this.ctx = null;
    this.page = null;
    this.profilePath = null;
    this.idleTimer = null;
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  async _launchContext(profilePath, timeoutMs) {
    if (typeof this.launcher === "function") {
      return this.launcher(profilePath, timeoutMs);
    }
    const pw = require(PW_PATH);

    // Prefer @notebooklm-style storage_state.json context (lock-free, immune to webLogin pruning)
    if (!fs.existsSync(this.storageStatePath) && fs.existsSync(profilePath)) {
      try {
        await syncStorageStateFromProfile(profilePath, this.storageStatePath);
      } catch {}
    }

    if (fs.existsSync(this.storageStatePath)) {
      this.browser = await pw.chromium.launch({
        headless: true,
        executablePath: CHROME,
        args: ["--disable-blink-features=AutomationControlled"],
      });
      const ctx = await this.browser.newContext({
        storageState: this.storageStatePath,
        viewport: { width: 1280, height: 800 },
      });
      const origClose = ctx.close.bind(ctx);
      const browserRef = this.browser;
      ctx.close = async () => {
        try {
          await origClose();
        } catch {}
        try {
          await browserRef.close();
        } catch {}
      };
      return ctx;
    }

    // Fallback to persistent profile context if storageState is absent
    cleanupProfileLock(profilePath);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await pw.chromium.launchPersistentContext(profilePath, {
          headless: true,
          executablePath: CHROME,
          args: ["--disable-blink-features=AutomationControlled"],
        });
      } catch (err) {
        if (attempt === 1) {
          cleanupProfileLock(profilePath, true);
          await new Promise((r) => setTimeout(r, 1000));
        } else {
          throw err;
        }
      }
    }
  }

  async acquire(profilePath = DEFAULT_PROFILE, timeoutMs = 60000) {
    this._clearIdleTimer();

    if (this.ctx && this.page && !this.page.isClosed() && this.profilePath === profilePath) {
      return { ctx: this.ctx, page: this.page, reused: true };
    }

    await this.close();
    this.profilePath = profilePath;
    this.ctx = await this._launchContext(profilePath, timeoutMs);
    this.page = this.ctx.pages()[0] || (await this.ctx.newPage());
    await this.page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: timeoutMs });
    try {
      await this.page.waitForFunction(
        () => !!localStorage.getItem("token") && !!document.querySelector("textarea"),
        { timeout: 12000 }
      );
      // Allow Baxia anti-bot SDK (tfstk__ / isg__) to finish initial hydration on cold start
      await new Promise((r) => setTimeout(r, 2000));
    } catch {
      await new Promise((r) => setTimeout(r, 2500));
    }
    return { ctx: this.ctx, page: this.page, reused: false };
  }

  release() {
    this._clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.close().catch(() => {});
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async close() {
    this._clearIdleTimer();
    const ctxToClose = this.ctx;
    const browserToClose = this.browser;
    this.ctx = null;
    this.browser = null;
    this.page = null;
    this.profilePath = null;
    if (ctxToClose) {
      try {
        await ctxToClose.close();
      } catch {}
    }
    if (browserToClose) {
      try {
        await browserToClose.close();
      } catch {}
    }
  }
}

const defaultPool = new QwenBrowserPool();

async function ensureUiModelSelected(page) {
  const trigger = page.locator("div.wms-trigger, [aria-label='Select Model']").first();
  try {
    await trigger.waitFor({ state: "visible", timeout: 5000 });
  } catch {
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const current = (await trigger.innerText().catch(() => "")).toLowerCase();
      if (current.includes("3.7-plus")) return;

      await trigger.click({ timeout: 3000 });
      const option = page.locator(".wms-list__name-text").filter({ hasText: /qwen3\.7-plus/i }).first();
      await option.waitFor({ state: "visible", timeout: 2500 });
      await option.click({ timeout: 3000 });

      // Wait until the trigger reflects Qwen3.7-Plus
      await page.waitForFunction(
        () => {
          const el = document.querySelector("div.wms-trigger, [aria-label='Select Model']");
          return el && (el.innerText || "").toLowerCase().includes("3.7-plus");
        },
        { timeout: 3000 }
      );
      return;
    } catch {
      await page.keyboard.press("Escape").catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

async function ensureUiModes(page, { thinkingEnabled, searchEnabled } = {}) {
  if (thinkingEnabled) {
    try {
      const thinkTrigger = page.locator(".qwen-thinking-selector").first();
      if ((await thinkTrigger.count()) > 0) {
        const txt = (await thinkTrigger.innerText().catch(() => "")).toLowerCase();
        if (!txt.includes("thinking")) {
          await thinkTrigger.click({ timeout: 2000 });
          const opt = page.locator(".qwen-chat-v2-dropdown-menu-item-label").filter({ hasText: /^Thinking$/i }).first();
          if ((await opt.count()) > 0) await opt.click({ timeout: 2000 });
          else await page.keyboard.press("Escape").catch(() => {});
        }
      }
    } catch {}
  }

  if (searchEnabled) {
    try {
      const modeBtn = page.locator(".mode-select-open, [aria-label='Select Mode']").first();
      if ((await modeBtn.count()) > 0) {
        await modeBtn.click({ timeout: 2000 });
        const searchOpt = page.locator(".mode-select-dropdown-item-name").filter({ hasText: /^Web search$/i }).first();
        if ((await searchOpt.count()) > 0) await searchOpt.click({ timeout: 2000 });
        else await page.keyboard.press("Escape").catch(() => {});
      }
    } catch {}
  }
}

async function submitPromptViaQwenUI(page, promptText, reused, uiModes = {}) {
  const hasToken = await page.evaluate(() => !!localStorage.getItem("token"));
  if (!hasToken) {
    return { noToken: true };
  }

  // If reusing a warm tab that already has an active conversation, click "New Chat"
  // so the self-contained Agent trajectory prompt starts cleanly.
  if (reused && typeof page.locator === "function") {
    try {
      const newChatBtn = page.locator('[aria-label="New Chat"]').first();
      if ((await newChatBtn.count()) > 0) {
        await newChatBtn.click({ timeout: 3000 });
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch {}
  }

  await ensureUiModelSelected(page);
  await ensureUiModes(page, uiModes);

  const box = page.locator("textarea.message-input-textarea, textarea").first();
  await box.waitFor({ state: "visible", timeout: 15000 });
  await box.click({ timeout: 5000 });
  await box.fill(promptText);
  await new Promise((r) => setTimeout(r, 200));

  const sendBtn = page.locator('button.send-button:not([disabled]), button[aria-label="Send"]:not([disabled])').first();
  if ((await sendBtn.count()) > 0) {
    await sendBtn.click({ timeout: 5000 });
  } else {
    await box.press("Enter");
  }
  return { submitted: true };
}

async function doChatViaBrowserStream({
  model = "qwen3.7-plus",
  messages,
  stream = true,
  searchEnabled = false,
  thinkingEnabled = false,
  profilePath = DEFAULT_PROFILE,
  timeoutMs = 90000,
  signal,
  pool = defaultPool,
  onStreamDone = null,
}) {
  const { upstreamModel, chatMode } = resolveQwenAgentOptions(model, {
    web_search: searchEnabled,
    thinking: thinkingEnabled,
  });

  if (signal?.aborted) {
    throw new Error("Request aborted");
  }

  let session;
  try {
    session = await pool.acquire(profilePath, timeoutMs);
  } catch {
    await pool.close();
    session = await pool.acquire(profilePath, timeoutMs);
  }

  const { page, reused } = session;
  const cdp = await page.context().newCDPSession(page);

  let pausedResolver;
  const pausedPromise = new Promise((resolve) => {
    pausedResolver = resolve;
  });

  const onRequestPaused = (params) => {
    if (params.request && params.request.url && params.request.url.includes("/api/v2/chat/completions")) {
      pausedResolver(params);
    } else {
      cdp.send("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
    }
  };

  cdp.on("Fetch.requestPaused", onRequestPaused);

  let timeoutTimer = null;
  let abortListener = null;

  try {
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*/api/v2/chat/completions*", requestStage: "Response" }],
    });

    const promptText = formatMessagesForUiPrompt(messages);

    // Use UI-driven submission on real Playwright pages (bypasses Alibaba RGV587_ERROR anti-bot);
    // fall back to page.evaluate only for unit-test fake pages without page.locator.
    const triggerPromise =
      typeof page.locator === "function"
        ? submitPromptViaQwenUI(page, promptText, reused, { thinkingEnabled, searchEnabled }).catch((err) => ({
            evalError: String(err?.message || err),
          }))
        : page
            .evaluate(
              async ({ model, messages, stream, chatMode }) => {
                const tok = localStorage.getItem("token");
                if (!tok) return { noToken: true };
                const r = await fetch("/api/v2/chat/completions", {
                  method: "POST",
                  headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
                  body: JSON.stringify({ model, messages, stream, incremental_output: true, chat_mode: chatMode }),
                });
                return { status: r.status, contentType: r.headers.get("content-type") || "" };
              },
              { model: upstreamModel, messages, stream, chatMode }
            )
            .catch((err) => ({ evalError: String(err?.message || err) }));

    const timeoutPromise = new Promise((_, rej) => {
      timeoutTimer = setTimeout(() => rej(new Error("CDP stream interception timeout")), timeoutMs);
    });
    const abortPromise = new Promise((_, rej) => {
      if (signal?.aborted) rej(new Error("Request aborted"));
      else {
        abortListener = () => rej(new Error("Request aborted"));
        signal?.addEventListener("abort", abortListener, { once: true });
      }
    });

    // Wait for either UI trigger failure/noToken, CDP response interception, timeout, or abort
    const triggerRes = await Promise.race([
      pausedPromise.then((p) => ({ type: "paused", params: p })),
      triggerPromise.then((t) => ({ type: "trigger", result: t })),
      timeoutPromise,
      abortPromise,
    ]);

    if (triggerRes.type === "trigger") {
      if (triggerRes.result?.noToken) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (abortListener && signal) signal.removeEventListener("abort", abortListener);
        cdp.removeListener("Fetch.requestPaused", onRequestPaused);
        await cdp.send("Fetch.disable").catch(() => {});
        await cdp.detach().catch(() => {});
        await pool.close().catch(() => {});
        return { status: 0, contentType: "", text: "NO_TOKEN" };
      }
      if (triggerRes.result?.evalError) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (abortListener && signal) signal.removeEventListener("abort", abortListener);
        cdp.removeListener("Fetch.requestPaused", onRequestPaused);
        await cdp.send("Fetch.disable").catch(() => {});
        await cdp.detach().catch(() => {});
        await pool.close().catch(() => {});
        throw new Error(`Browser UI trigger error: ${triggerRes.result.evalError}`);
      }
    }

    const paused =
      triggerRes.type === "paused"
        ? triggerRes.params
        : await Promise.race([pausedPromise, timeoutPromise, abortPromise]);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (abortListener && signal) {
      signal.removeEventListener("abort", abortListener);
      abortListener = null;
    }

    const status = paused.responseStatusCode || 200;
    const headersList = Array.isArray(paused.responseHeaders) ? paused.responseHeaders : [];
    const ctHeader = headersList.find((h) => String(h.name).toLowerCase() === "content-type");
    const contentType = ctHeader ? ctHeader.value : "text/event-stream";

    if (status >= 400 || contentType.includes("application/json")) {
      let errText = "";
      for await (const chunk of readCDPStreamChunks(cdp, paused.requestId, signal)) {
        errText += chunk;
      }
      await cdp.send("Fetch.continueResponse", { requestId: paused.requestId }).catch(() => {});
      cdp.removeListener("Fetch.requestPaused", onRequestPaused);
      await cdp.send("Fetch.disable").catch(() => {});
      await cdp.detach().catch(() => {});
      if (status === 401 || status === 403 || errText.includes("RGV587_ERROR")) {
        await pool.close().catch(() => {});
      } else {
        pool.release();
      }
      return { status, contentType, text: errText };
    }

    async function* cdpChunkGenerator() {
      try {
        for await (const chunk of readCDPStreamChunks(cdp, paused.requestId, signal)) {
          yield chunk;
        }
        // Persist refreshed cookies/tokens back to storage_state.json (@notebooklm pattern)
        const ctxObj = page.context?.();
        if (pool.storageStatePath && typeof ctxObj?.storageState === "function") {
          await ctxObj.storageState({ path: pool.storageStatePath }).catch(() => {});
        }
      } finally {
        await cdp.send("Fetch.continueResponse", { requestId: paused.requestId }).catch(() => {});
        cdp.removeListener("Fetch.requestPaused", onRequestPaused);
        await cdp.send("Fetch.disable").catch(() => {});
        await cdp.detach().catch(() => {});
        pool.release();
        if (typeof onStreamDone === "function") {
          try {
            onStreamDone();
          } catch {}
        }
      }
    }

    return {
      status,
      contentType,
      stream: cdpChunkGenerator(),
    };
  } catch (err) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (abortListener && signal) signal.removeEventListener("abort", abortListener);
    cdp.removeListener("Fetch.requestPaused", onRequestPaused);
    await cdp.send("Fetch.disable").catch(() => {});
    await cdp.detach().catch(() => {});
    await pool.close().catch(() => {});
    throw err;
  }
}

const TRANSIENT_ERROR_RE =
  /target closed|session closed|browser has been closed|context was destroyed|frame was detached|navigation interrupted|connection closed|page closed/i;

async function chatViaBrowserStream(options) {
  let resolveResult, rejectResult;
  const resultPromise = new Promise((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  enqueue(async () => {
    const pool = options.pool || defaultPool;
    let releaseQueueLock;
    const streamDonePromise = new Promise((r) => {
      releaseQueueLock = r;
    });

    try {
      let res;
      try {
        res = await doChatViaBrowserStream({ ...options, pool, onStreamDone: releaseQueueLock });
      } catch (err) {
        const msg = String(err?.message || err);
        if (TRANSIENT_ERROR_RE.test(msg) && !options.signal?.aborted) {
          await pool.close().catch(() => {});
          res = await doChatViaBrowserStream({ ...options, pool, onStreamDone: releaseQueueLock });
        } else {
          throw err;
        }
      }
      resolveResult(res);
      if (res && res.stream) {
        // Hold the serial browser lock until the active stream finishes, errors, or is cancelled
        await streamDonePromise;
      } else {
        releaseQueueLock();
      }
    } catch (err) {
      releaseQueueLock();
      rejectResult(err);
    }
  });

  return resultPromise;
}

async function chatViaBrowser(options) {
  const res = await chatViaBrowserStream(options);
  if (typeof res.text === "string") {
    return { status: res.status, contentType: res.contentType, text: res.text };
  }
  let fullText = "";
  if (res.stream) {
    for await (const ch of res.stream) {
      fullText += ch;
    }
  }
  return { status: res.status, contentType: res.contentType, text: fullText };
}

/**
 * @notebooklm-style in-place session refresh: syncs storage_state.json from the browser profile
 * if newer, closes stale pool, and returns the fresh token if valid.
 */
async function refreshTokenViaPool(profilePath = DEFAULT_PROFILE, statePath = DEFAULT_STORAGE_STATE) {
  return enqueue(async () => {
    try {
      await defaultPool.close();
      if (fs.existsSync(profilePath)) {
        const state = await syncStorageStateFromProfile(profilePath, statePath);
        const qwenOrigin = (state?.origins || []).find((o) => o.origin.includes("qwen.ai"));
        const tokEntry = (qwenOrigin?.localStorage || []).find((x) => x.name === "token");
        if (tokEntry?.value && tokEntry.value.length >= 20) {
          return { apiKey: tokEntry.value, accessToken: tokEntry.value };
        }
      }
      return null;
    } catch {
      return null;
    }
  });
}

module.exports = {
  QwenBrowserPool,
  defaultPool,
  readCDPStreamChunks,
  chatViaBrowserStream,
  chatViaBrowser,
  refreshTokenViaPool,
  syncStorageStateFromProfile,
  cleanupProfileLock,
  DEFAULT_PROFILE,
  DEFAULT_STORAGE_STATE,
};
