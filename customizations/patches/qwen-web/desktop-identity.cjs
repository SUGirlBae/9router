/**
 * Qwen Desktop identity — byte-faithful copy of the installed Qwen.exe 1.0.3 client.
 *
 * Static evidence (this workstation):
 *   C:\Program Files\Qwen\resources\app.asar
 *     out/main/index.js          app version "1.0.3"; BrowserWindow{webviewTag:true, webSecurity:false,
 *                                nodeIntegrationInSubFrames:true}; contextBridge preload
 *     out/renderer/assets/index-J-5aykDP.js
 *                                WEBVIEW_URL = "https://chat.qwen.ai"
 *                                useragent   = navigator.userAgent + ` AliDesktop(QWENCHAT/${version})`
 *                                webpreferences = "nodeIntegrationInSubFrames=true, sandbox=false"
 *     out/preload/index.js       exposes window.electron (electron-toolkit) and window.electronAPI
 *   Qwen.exe binary strings     Chrome/134.0.6998.179, Electron/35.1.4
 *
 * Web-app contract (qwen-chat-fe 0.3.42 main.js, assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.42/js):
 *   isDesktop() = !!window.electronAPI && /AliDesktop\(QWENCHAT\/\d+\.\d+\.\d+\)/.test(navigator.userAgent)
 *   request wrapper $O() sets: Accept: application/json, Content-Type: application/json,
 *     Version: 0.3.42, source: "desktop" when isDesktop(), Authorization: Bearer <token>
 *     (except /auths/refresh), X-Request-Id: uuid4, Timezone: Date toString without "(zone)".
 *   desktop-only: feature_config.mcp is attached when mcpEnabled && isDesktop().
 *   token store: localStorage "qwen_access_token_state" {version:1,stateId,token,expiresAt,updatedAt,sourceId}
 *     with legacy fallback "token" + "at_expire_time"; logout marker "qwen_token_logged_out_marker".
 *
 * Consequence: the browser context must carry the exact Electron UA, Chromium 134 client hints
 * (Electron has no Google Chrome brand), and a window.electronAPI of the shape the preload exposes.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP_APP_VERSION = "1.0.3";
const DESKTOP_CHROMIUM_FULL = "134.0.6998.179";
const DESKTOP_ELECTRON_VERSION = "35.1.4";
const WEB_APP_VERSION = "0.3.42";
const BAXIA_VERSION = "2.5.37";

const QWEN_DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  `Qwen/${DESKTOP_APP_VERSION} Chrome/${DESKTOP_CHROMIUM_FULL} Electron/${DESKTOP_ELECTRON_VERSION} ` +
  `Safari/537.36 AliDesktop(QWENCHAT/${DESKTOP_APP_VERSION})`;

// Chromium 134 UA-CH: Electron keeps the Chromium brand only (no "Google Chrome") and the
// M134 greasey brand is "Not-A.Brand";24. Platform facts read from this host (Win11 26200 -> 19.0.0).
const QWEN_DESKTOP_UA_METADATA = Object.freeze({
  brands: Object.freeze([
    Object.freeze({ brand: "Chromium", version: "134" }),
    Object.freeze({ brand: "Not-A.Brand", version: "24" }),
  ]),
  fullVersionList: Object.freeze([
    Object.freeze({ brand: "Chromium", version: DESKTOP_CHROMIUM_FULL }),
    Object.freeze({ brand: "Not-A.Brand", version: "24.0.0.0" }),
  ]),
  fullVersion: DESKTOP_CHROMIUM_FULL,
  platform: "Windows",
  platformVersion: "19.0.0",
  architecture: "x86",
  bitness: "64",
  model: "",
  mobile: false,
  wow64: false,
});

const QWEN_TOKEN_KEYS = Object.freeze({
  state: "qwen_access_token_state",
  legacyToken: "token",
  legacyExpiry: "at_expire_time",
  loggedOutMarker: "qwen_token_logged_out_marker",
  sessionMarker: "qwen_token_session_marker",
  deviceId: "qwen_chat_device_id",
});

function resolveLocale() {
  return process.env.QWEN_LOCALE || "en-US";
}

function resolveTimezone() {
  // Matches the web client: new Date().toString().replace(/\s*\(.+\)$/, "")
  return new Date().toString().replace(/\s*\(.+\)$/, "");
}

/**
 * Context options every Qwen browser context must receive (UA + locale).
 * Playwright forwards `userAgent` to Emulation.setUserAgentOverride.
 */
function desktopContextOptions(extra = {}) {
  return {
    userAgent: QWEN_DESKTOP_UA,
    locale: resolveLocale(),
    ...extra,
  };
}

/**
 * Preload surface of the installed app (out/preload/index.js). The web app tests
 * `!!window.electronAPI` and calls on_event/open_external_link, so provide a faithful
 * no-op bridge. Runs before any page script, like the real preload.
 */
const QWEN_ELECTRON_API_INIT_SCRIPT = `(() => {
  if (window.electronAPI) return;
  const noop = () => {};
  const listeners = Object.create(null);
  window.electronAPI = {
    PRELOAD_FILE_PATH: "",
    open_devtool: noop,
    toggle_hidden_devtools: noop,
    get_app_version: () => Promise.resolve(${JSON.stringify(DESKTOP_APP_VERSION)}),
    get_platform_info: () => Promise.resolve({ os: "win32" }),
    open_external_link: () => Promise.resolve(true),
    show_native_dialog: () => Promise.resolve("cancel"),
    request_file_access: () => Promise.resolve({ filePath: "" }),
    mcp_client_connect: noop,
    mcp_client_close: noop,
    mcp_client_tool_list: () => Promise.resolve([]),
    mcp_client_get_config: () => Promise.resolve({}),
    mcp_client_tool_call: () => Promise.resolve(null),
    mcp_client_update_config: () => Promise.resolve({}),
    switch_theme: noop,
    switch_ln: noop,
    update_title_bar_for_system_theme: noop,
    on_event: (type, cb) => { (listeners[type] || (listeners[type] = [])).push(cb); },
    send_event: noop,
  };
  window.electron = window.electron || { ipcRenderer: { on: noop, send: noop, invoke: () => Promise.resolve(null), sendToHost: noop } };
})();`;

/**
 * Install the preload-equivalent bridge for every page/frame the context creates.
 * Must run before navigation.
 */
async function installDesktopIdentity(context) {
  if (!context || typeof context.addInitScript !== "function") return false;
  try {
    await context.addInitScript({ content: QWEN_ELECTRON_API_INIT_SCRIPT });
    return true;
  } catch {
    return false;
  }
}

/**
 * Complete the identity at the CDP layer. Playwright's UA override omits
 * userAgentMetadata, so sec-ch-ua* and navigator.userAgentData would otherwise
 * report the host Chrome build. The session is kept on the page so later calls
 * (and navigations that reset the override) can re-apply it.
 */
async function applyDesktopClientHints(page) {
  if (!page || page.__9rQwenDesktopHints) return false;
  const ctx = typeof page.context === "function" ? page.context() : null;
  if (!ctx || typeof ctx.newCDPSession !== "function") return false;
  let cdp = null;
  try {
    cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: QWEN_DESKTOP_UA,
      acceptLanguage: `${resolveLocale()},${resolveLocale().split("-")[0]};q=0.9`,
      platform: "Win32",
      userAgentMetadata: QWEN_DESKTOP_UA_METADATA,
    });
    page.__9rQwenDesktopHints = true;
    page.__9rQwenCdp = cdp;
    if (typeof page.on === "function") {
      // Playwright re-sends its own UA override on frame navigation; follow it.
      page.on("framenavigated", () => {
        if (page.__9rQwenCdp) {
          page.__9rQwenCdp
            .send("Emulation.setUserAgentOverride", {
              userAgent: QWEN_DESKTOP_UA,
              acceptLanguage: `${resolveLocale()},${resolveLocale().split("-")[0]};q=0.9`,
              platform: "Win32",
              userAgentMetadata: QWEN_DESKTOP_UA_METADATA,
            })
            .catch(() => {});
        }
      });
    }
    return true;
  } catch {
    if (cdp) await cdp.detach().catch(() => {});
    return false;
  }
}

async function refreshDesktopClientHints(page) {
  if (!page || !page.__9rQwenCdp) return applyDesktopClientHints(page);
  try {
    await page.__9rQwenCdp.send("Emulation.setUserAgentOverride", {
      userAgent: QWEN_DESKTOP_UA,
      acceptLanguage: `${resolveLocale()},${resolveLocale().split("-")[0]};q=0.9`,
      platform: "Win32",
      userAgentMetadata: QWEN_DESKTOP_UA_METADATA,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token store (mirrors main.js zw()/Bw())
// ---------------------------------------------------------------------------

function isValidTokenState(state) {
  return Boolean(
    state &&
      typeof state === "object" &&
      state.version === 1 &&
      typeof state.stateId === "string" &&
      state.stateId.length > 0 &&
      typeof state.token === "string" &&
      state.token.length > 0 &&
      typeof state.expiresAt === "number" &&
      Number.isFinite(state.expiresAt) &&
      typeof state.updatedAt === "number" &&
      Number.isFinite(state.updatedAt) &&
      typeof state.sourceId === "string"
  );
}

/** Parse storage-state origins into {token, expiresAt, source}; scans every qwen origin. */
function pickQwenToken(originStates = []) {
  const origins = (originStates || []).filter(
    (o) => o && typeof o.origin === "string" && o.origin.includes("qwen")
  );
  for (const origin of origins) {
    const items = origin.localStorage || [];
    const rawState = items.find((x) => x.name === QWEN_TOKEN_KEYS.state)?.value;
    if (!rawState) continue;
    try {
      const parsed = JSON.parse(rawState);
      if (isValidTokenState(parsed)) {
        return { token: parsed.token, expiresAt: parsed.expiresAt, source: "state" };
      }
    } catch {}
  }
  for (const origin of origins) {
    const items = origin.localStorage || [];
    const legacyToken = items.find((x) => x.name === QWEN_TOKEN_KEYS.legacyToken)?.value;
    const legacyExpiry = Number(items.find((x) => x.name === QWEN_TOKEN_KEYS.legacyExpiry)?.value);
    if (legacyToken && Number.isFinite(legacyExpiry) && legacyExpiry > 0) {
      return { token: legacyToken, expiresAt: legacyExpiry, source: "legacy" };
    }
  }
  return null;
}

/** In-page token read using the same rules as the web client. */
async function readQwenTokenFromPage(page) {
  if (!page || typeof page.evaluate !== "function") return null;
  try {
    return await page.evaluate((keys) => {
      const get = (k) => {
        try {
          return localStorage.getItem(k);
        } catch {
          return null;
        }
      };
      const raw = get(keys.state);
      if (raw) {
        try {
          const s = JSON.parse(raw);
          if (
            s &&
            s.version === 1 &&
            typeof s.stateId === "string" &&
            s.stateId.length > 0 &&
            typeof s.token === "string" &&
            s.token.length > 0 &&
            typeof s.expiresAt === "number" &&
            Number.isFinite(s.expiresAt)
          ) {
            return { token: s.token, expiresAt: s.expiresAt, source: "state" };
          }
        } catch {}
      }
      const legacy = get(keys.legacyToken);
      const expiry = Number(get(keys.legacyExpiry));
      if (legacy && Number.isFinite(expiry) && expiry > 0) {
        return { token: legacy, expiresAt: expiry, source: "legacy" };
      }
      return null;
    }, QWEN_TOKEN_KEYS);
  } catch {
    return null;
  }
}

/**
 * Exact header set observed on a live chat.qwen.ai request from this identity
 * (captured 2026-11-15 via CDP Fetch response-stage interception):
 *
 *   Accept: application/json          Content-Type: application/json
 *   Accept-Language: en-US,en;q=0.9   Origin: https://chat.qwen.ai
 *   Referer: https://chat.qwen.ai/c/<chat_id>
 *   Timezone: Sun Nov 15 2026 02:22:10 GMT+0700
 *   Version: 0.3.42                   X-Accel-Buffering: no
 *   X-Request-Id: <uuid4>             bx-v: 2.5.37
 *   sec-ch-ua: "Chromium";v="134", "Not-A.Brand";v="24"
 *   sec-ch-ua-mobile: ?0              sec-ch-ua-platform: "Windows"
 *   source: desktop                   Authorization: Bearer <token>
 *   User-Agent: <QWEN_DESKTOP_UA>
 */
function qwenRequestHeaders({ token = null, chatId = null, requestId = crypto.randomUUID() } = {}) {
  const lang = resolveLocale();
  const headers = {
    Accept: "application/json",
    "Accept-Language": `${lang},${lang.split("-")[0]};q=0.9`,
    "Content-Type": "application/json",
    Origin: "https://chat.qwen.ai",
    Referer: chatId ? `https://chat.qwen.ai/c/${chatId}` : "https://chat.qwen.ai/",
    Timezone: resolveTimezone(),
    "User-Agent": QWEN_DESKTOP_UA,
    Version: WEB_APP_VERSION,
    "X-Accel-Buffering": "no",
    "X-Request-Id": requestId,
    "bx-v": BAXIA_VERSION,
    "sec-ch-ua": '"Chromium";v="134", "Not-A.Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    source: "desktop",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Optional protocol capture (QWEN_CAPTURE_DIR=...). Writes one JSON per captured
// chat request with credential-bearing values redacted, so the exact wire shape
// of the installed web client can be diffed against this provider.
// ---------------------------------------------------------------------------

const CAPTURE_REDACT = new Set([
  "cookie",
  "authorization",
  "set-cookie",
  "bx-ua",
  "bx-umidtoken",
  "tfstk",
  "isg",
  "x-5s",
  "x-signature",
  "x-csrf-token",
]);

function redactHeaderValue(name, value) {
  const lower = String(name || "").toLowerCase();
  if (!CAPTURE_REDACT.has(lower)) return value;
  const text = String(value ?? "");
  const digest = crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);
  return `<redacted ${text.length}B sha256:${digest}>`;
}

function captureDir() {
  return process.env.QWEN_CAPTURE_DIR || null;
}

function captureChatRequest(pausedParams) {
  const dir = captureDir();
  if (!dir || !pausedParams?.request) return null;
  try {
    const req = pausedParams.request;
    // CDP sends Fetch.Request.headers as a name->value object, while
    // responseHeaders is an array of {name,value}.
    const headerList = (input) =>
      Array.isArray(input)
        ? input
        : input && typeof input === "object"
          ? Object.entries(input).map(([name, value]) => ({ name, value }))
          : [];
    const headers = headerList(req.headers);
    const responseHeaders = headerList(pausedParams.responseHeaders);
    const snapshot = {
      capturedAt: new Date().toISOString(),
      url: req.url,
      method: req.method,
      requestHeaders: headers.map((h) => ({
        name: h.name,
        value: redactHeaderValue(h.name, h.value),
      })),
      postData: req.postData ?? null,
      postDataParsed: (() => {
        try {
          return req.postData ? JSON.parse(req.postData) : null;
        } catch {
          return null;
        }
      })(),
      responseStatus: pausedParams.responseStatusCode ?? null,
      responseHeaders: responseHeaders.map((h) => ({
        name: h.name,
        value: redactHeaderValue(h.name, h.value),
      })),
    };
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `qwen-request-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
    return file;
  } catch {
    return null;
  }
}

module.exports = {
  DESKTOP_APP_VERSION,
  BAXIA_VERSION,
  qwenRequestHeaders,
  DESKTOP_CHROMIUM_FULL,
  DESKTOP_ELECTRON_VERSION,
  WEB_APP_VERSION,
  QWEN_DESKTOP_UA,
  QWEN_DESKTOP_UA_METADATA,
  QWEN_TOKEN_KEYS,
  QWEN_ELECTRON_API_INIT_SCRIPT,
  desktopContextOptions,
  installDesktopIdentity,
  applyDesktopClientHints,
  refreshDesktopClientHints,
  pickQwenToken,
  readQwenTokenFromPage,
  resolveTimezone,
  captureChatRequest,
};
