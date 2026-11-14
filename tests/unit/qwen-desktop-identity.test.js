import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const identity = require("../../customizations/patches/qwen-web/desktop-identity.cjs");

// Verbatim contract of the shipped clients (see module docstring for evidence):
//   desktop UA = <Electron default UA> + " AliDesktop(QWENCHAT/1.0.3)"
//   Electron 35.1.4 default UA product tokens: Qwen/1.0.3 Chrome/134.0.6998.179 Electron/35.1.4
const EXPECTED_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Qwen/1.0.3 Chrome/134.0.6998.179 Electron/35.1.4 Safari/537.36 AliDesktop(QWENCHAT/1.0.3)";

test("desktop UA is byte-identical to the installed Qwen.exe 1.0.3 webview UA", () => {
  assert.equal(identity.QWEN_DESKTOP_UA, EXPECTED_UA);
  assert.doesNotMatch(identity.QWEN_DESKTOP_UA, /HeadlessChrome/);
});

test("desktop UA satisfies the web app's own desktop detector and fails the mobile detector", () => {
  // qwen-chat-fe 0.3.42 main.js
  const isDesktop = (ua, hasElectronAPI) =>
    !!hasElectronAPI && /AliDesktop\(QWENCHAT\/\d+\.\d+\.\d+\)/.test(ua);
  const isMobileApp = (ua) => /AliApp\((?:QWENCHAT|QWEN)\/[^)]*\)/.test(ua);
  assert.equal(isDesktop(identity.QWEN_DESKTOP_UA, true), true);
  assert.equal(isMobileApp(identity.QWEN_DESKTOP_UA), false);
});

test("client hints advertise Chromium 134 with no Google Chrome brand (Electron behavior)", () => {
  const md = identity.QWEN_DESKTOP_UA_METADATA;
  assert.deepEqual(
    md.brands.map((b) => b.brand),
    ["Chromium", "Not-A.Brand"]
  );
  assert.equal(md.fullVersion, "134.0.6998.179");
  assert.equal(md.platform, "Windows");
  assert.equal(md.platformVersion, "19.0.0");
  assert.equal(md.architecture, "x86");
  assert.equal(md.bitness, "64");
  assert.equal(md.wow64, false);
  assert.ok(!JSON.stringify(md).includes("Google Chrome"));
});

test("desktopContextOptions forces UA + locale while letting callers add context options", () => {
  const opts = identity.desktopContextOptions({ storageState: "x.json", viewport: { width: 1, height: 2 } });
  assert.equal(opts.userAgent, identity.QWEN_DESKTOP_UA);
  assert.equal(opts.locale, "en-US");
  assert.equal(opts.storageState, "x.json");
  assert.deepEqual(opts.viewport, { width: 1, height: 2 });
});

test("captureChatRequest redacts credentials but keeps the wire shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-cap-"));
  const prev = process.env.QWEN_CAPTURE_DIR;
  process.env.QWEN_CAPTURE_DIR = dir;
  try {
    const body = JSON.stringify({
      model: "qwen3.7-plus",
      messages: [{ role: "user", content: "hi", chat_type: "t2t" }],
      stream: true,
      feature_config: { thinking_enabled: false, output_schema: "phase" },
    });
    const file = identity.captureChatRequest({
      request: {
        url: "https://chat.qwen.ai/api/v2/chat/completions?chat_id=abc",
        method: "POST",
        headers: [
          { name: "authorization", value: "Bearer super-secret-token" },
          { name: "Cookie", value: "token=secret; cna=xyz" },
          { name: "x-request-id", value: "b6f1" },
          { name: "bx-v", value: "2.5.3" },
        ],
        postData: body,
      },
      responseStatusCode: 200,
      responseHeaders: [{ name: "content-type", value: "text/event-stream" }],
    });
    assert.ok(file && fs.existsSync(file), "capture file must be written");
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    const h = Object.fromEntries(snap.requestHeaders.map((x) => [x.name.toLowerCase(), x.value]));
    assert.match(h.authorization, /^<redacted \d+B sha256:[0-9a-f]{8}>$/);
    assert.match(h.cookie, /^<redacted \d+B sha256:[0-9a-f]{8}>$/);
    assert.equal(h["x-request-id"], "b6f1");
    assert.equal(h["bx-v"], "2.5.3");
    assert.equal(snap.postDataParsed.feature_config.output_schema, "phase");
    assert.equal(snap.postDataParsed.messages[0].chat_type, "t2t");
    assert.equal(snap.responseStatus, 200);
  } finally {
    if (prev === undefined) delete process.env.QWEN_CAPTURE_DIR;
    else process.env.QWEN_CAPTURE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("qwenRequestHeaders reproduces the captured live request header set", () => {
  const h = identity.qwenRequestHeaders({ token: "tok", chatId: "chat-1", requestId: "rid" });
  assert.equal(h.Accept, "application/json");
  assert.equal(h["Content-Type"], "application/json");
  assert.equal(h["Accept-Language"], "en-US,en;q=0.9");
  assert.equal(h.Origin, "https://chat.qwen.ai");
  assert.equal(h.Referer, "https://chat.qwen.ai/c/chat-1");
  assert.match(h.Timezone, /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}$/);
  assert.equal(h.Version, "0.3.42");
  assert.equal(h["X-Accel-Buffering"], "no");
  assert.equal(h["X-Request-Id"], "rid");
  assert.equal(h["bx-v"], "2.5.37");
  assert.equal(h["sec-ch-ua"], '"Chromium";v="134", "Not-A.Brand";v="24"');
  assert.equal(h["sec-ch-ua-mobile"], "?0");
  assert.equal(h["sec-ch-ua-platform"], '"Windows"');
  assert.equal(h.source, "desktop");
  assert.equal(h.Authorization, "Bearer tok");
  assert.equal(h["User-Agent"], identity.QWEN_DESKTOP_UA);
});

test("pickQwenToken prefers qwen_access_token_state and falls back to legacy token+expiry", () => {
  const state = JSON.stringify({
    version: 1,
    stateId: "s1",
    token: "state-token-abcdefghijklmnop",
    expiresAt: 1794683996000,
    updatedAt: 1794683990000,
    sourceId: "native",
  });
  const origins = [
    {
      origin: "https://chat.qwen.ai",
      localStorage: [
        { name: "qwen_access_token_state", value: state },
        { name: "token", value: "legacy-token" },
        { name: "at_expire_time", value: "1794683996000" },
      ],
    },
  ];
  assert.deepEqual(identity.pickQwenToken(origins), {
    token: "state-token-abcdefghijklmnop",
    expiresAt: 1794683996000,
    source: "state",
  });

  const legacyOnly = [
    {
      origin: "https://chat.qwen.ai",
      localStorage: [
        { name: "token", value: "legacy-token" },
        { name: "at_expire_time", value: "1794683996000" },
      ],
    },
  ];
  assert.deepEqual(identity.pickQwenToken(legacyOnly), {
    token: "legacy-token",
    expiresAt: 1794683996000,
    source: "legacy",
  });

  assert.equal(identity.pickQwenToken([{ origin: "https://chat.qwen.ai", localStorage: [] }]), null);
  assert.equal(identity.pickQwenToken([]), null);
});

test("capture is disabled when QWEN_CAPTURE_DIR is unset", () => {
  const prev = process.env.QWEN_CAPTURE_DIR;
  delete process.env.QWEN_CAPTURE_DIR;
  try {
    const out = identity.captureChatRequest({ request: { url: "https://chat.qwen.ai/api/v2/chat/completions", headers: [] } });
    assert.equal(out, null);
  } finally {
    if (prev !== undefined) process.env.QWEN_CAPTURE_DIR = prev;
  }
});
