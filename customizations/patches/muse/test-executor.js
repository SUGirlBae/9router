// Executor wrapper tests: the contract between 9router's muse-web executor and
// the direct driver. The driver is stubbed (no network, no credentials), the
// base executor is a recorder, so every case asserts who answered.
//
//   X1  a healthy direct path answers chat and the browser executor is untouched
//   X2  streaming returns SSE bytes ending in [DONE]
//   X3  a direct failure falls back to the browser executor (R8)
//   X4  tool traffic goes straight to the browser executor (unchanged behaviour)
//   X5  generateMedia returns exactly the [{b64, mime}] shape 9router expects
//   X6  a media failure falls back too (R12)
//   X7  NINEROUTER_MUSE_HTTP=0 disables the driver completely
//   X8  methods the driver does not own still reach the base executor
//   X9  a missing driver degrades to the browser path instead of crashing
//
// Run: node muse/test-executor.js
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = path.join(os.tmpdir(), `muse-exec-${process.pid}`);
fs.mkdirSync(path.join(HOME, "lib"), { recursive: true });

fs.writeFileSync(
  path.join(HOME, "muse-bridge.cjs"),
  `"use strict";
class MuseBridge {
  constructor() { this.mode = process.env.__MUSE_STUB_MODE || "ok"; }
  async *chat(opts) {
    if (opts && opts.toolChoice === "required") throw Object.assign(new Error("this request requires a tool call"), { kind: "policy" });
    if (this.mode === "fail") throw Object.assign(new Error("tunnel died"), { kind: "upstream" });
    if (this.mode === "quota") throw Object.assign(new Error("out of credits"), { kind: "quota" });
    if (this.mode === "policy") throw Object.assign(new Error("no tool calling"), { kind: "policy" });
    yield { delta: "alpha " };
    yield { delta: "beta" };
    yield { done: true, text: "alpha beta", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, sessionId: "sess-1" };
  }
  async generate(opts) {
    if (this.mode === "media-fail") throw Object.assign(new Error("vm offline"), { kind: "upstream" });
    if (this.mode === "media-policy") throw Object.assign(new Error("video not available in region"), { kind: "policy" });
    return { kind: opts.kind, sessionId: "s", artifacts: Array.from({ length: Number(opts.n || 1) }, (_, i) => ({ b64: "AAECAw==", mime: opts.kind === "video" ? "video/mp4" : "image/png", path: "out/" + i })) };
  }
  async testConnection() { return { ok: true, kind: "muse-web" }; }
  accounts() { return []; }
  close() {}
}
module.exports = { MuseBridge };
`
);

fs.writeFileSync(
  path.join(HOME, "lib", "pool.cjs"),
  `"use strict";
class AccountPool {
  constructor(o) { this.o = o; }
  load() { return [{ label: "stub", cookies: "hatch_sess=1", state: "active", cooldownUntil: 0 }]; }
  available() { return this.load(); }
  describe() { return [{ label: "stub", state: "active" }]; }
  save() {} mark() {} markUsed() {}
}
module.exports = { AccountPool, COOLDOWN_MS: 3600000 };
`
);

function freshExecutor(env = {}) {
  delete require.cache[require.resolve("./muse-web-http-executor.cjs")];
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  process.env.MUSE_HOME = HOME;
  process.env.MUSE_RUNTIME = HOME;
  let mod;
  try {
    mod = require("./muse-web-http-executor.cjs");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    for (const [key, value] of Object.entries(env)) {
      if (value === null) delete process.env[key];
      else process.env[key] = String(value);
    }
  }
  return mod;
}

function fakeBase() {
  const calls = [];
  return {
    calls,
    async execute(ctx) {
      calls.push({ op: "execute", model: ctx.model });
      return { response: new Response(JSON.stringify({ from: "browser" }), { status: 200, headers: { "content-type": "application/json" } }), url: "https://muse.ai/thread/new", headers: {}, transformedBody: { from: "browser" } };
    },
    async generateMedia(opts) {
      calls.push({ op: "generateMedia", kind: opts.kind });
      return [{ b64: "QlJPV1NFUg==", mime: "image/png" }];
    },
    async testConnection() {
      calls.push({ op: "testConnection" });
      return { ok: true, via: "browser" };
    },
  };
}

const ctx = (extra = {}) => ({
  model: "muse-chat",
  stream: false,
  body: JSON.stringify({ model: "muse-chat", messages: [{ role: "user", content: "hi" }] }),
  credentials: { apiKey: "hatch_sess=abc" },
  signal: undefined,
  log: () => {},
  ...extra,
});

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("X1 a healthy direct path answers chat, browser untouched", async () => {
  const base = fakeBase();
  const { wrap } = freshExecutor({ __MUSE_STUB_MODE: "ok" });
  const executor = wrap(base);
  const result = await executor.execute(ctx());
  const payload = await result.response.json();
  assert.equal(payload.choices[0].message.content, "alpha beta");
  assert.equal(payload.object, "chat.completion");
  assert.equal(payload.usage.total_tokens, 0, "Muse gives no token counts, zeros are honest");
  assert.equal(base.calls.length, 0, "the browser executor was never touched");
  assert.match(result.url, /^noise:/);
});

test("X2 streaming yields SSE frames ending in [DONE]", async () => {
  const base = fakeBase();
  const { wrap } = freshExecutor({ __MUSE_STUB_MODE: "ok" });
  const result = await wrap(base).execute(ctx({ stream: true }));
  assert.equal(result.response.headers.get("content-type"), "text/event-stream");
  const text = await result.response.text();
  const frames = text.split("\n\n").filter((f) => f.startsWith("data: "));
  assert.ok(frames.length >= 3, `expected several frames, got ${frames.length}`);
  assert.equal(frames[frames.length - 1], "data: [DONE]");
  const joined = frames
    .slice(0, -1)
    .map((f) => (JSON.parse(f.slice(6)).choices[0].delta || {}).content || "")
    .join("");
  assert.equal(joined, "alpha beta");
});

test("X3 a direct failure falls back to the browser executor", async () => {
  const base = fakeBase();
  const { wrap } = freshExecutor({ __MUSE_STUB_MODE: "fail" });
  const result = await wrap(base).execute(ctx());
  assert.deepEqual(await result.response.json(), { from: "browser" });
  assert.deepEqual(base.calls, [{ op: "execute", model: "muse-chat" }]);
});

test("X4 quota failures fall back rather than masking the browser answer", async () => {
  const base = fakeBase();
  const { wrap } = freshExecutor({ __MUSE_STUB_MODE: "quota" });
  await wrap(base).execute(ctx());
  assert.equal(base.calls[0].op, "execute", "the browser path gets its chance");
});

test("X5 tool-carrying requests are served directly, not dumped on the browser", async () => {
  const base = fakeBase();
  const { wrap } = freshExecutor({ __MUSE_STUB_MODE: "ok" });
  const result = await wrap(base).execute(
    ctx({ body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }] }) })
  );
  const payload = await result.response.json();
  assert.equal(payload.choices[0].message.content, "alpha beta", "9router advertises tools for muse-chat, so this must not dead-end");
  assert.equal(base.calls.length, 0, "the broken browser executor is not used");

  const strict = await wrap(base).execute(
    ctx({ body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }], tool_choice: "required" }) })
  );
  assert.equal(strict.response.status, 400, "a mandatory tool call is a clear 400");
  assert.equal((await strict.response.json()).error.code, "policy");
});

test("X5b generateMedia returns the 9router media shape", async () => {
  const base = fakeBase();
  const { wrap } = freshExecutor({ __MUSE_STUB_MODE: "ok" });
  const out = await wrap(base).generateMedia({ prompt: "a cat", kind: "image", n: 2, credentials: { apiKey: "hatch_sess=x" }, log: () => {} });
  assert.equal(out.length, 2, "n is honoured");
  assert.deepEqual(Object.keys(out[0]).sort(), ["b64", "mime"], "exactly {b64, mime}");
  assert.equal(Buffer.from(out[0].b64, "base64").toString("hex"), "00010203", "bytes round-trip");
  assert.equal(out[0].mime, "image/png");
  assert.equal(base.calls.length, 0);
});

test("X6 a media failure falls back to the browser executor", async () => {
  const base = fakeBase();
  const { wrap } = freshExecutor({ __MUSE_STUB_MODE: "media-fail" });
  const out = await wrap(base).generateMedia({ prompt: "a cat", kind: "image", credentials: { apiKey: "hatch_sess=x" }, log: () => {} });
  assert.deepEqual(out, [{ b64: "QlJPV1NFUg==", mime: "image/png" }]);
  assert.equal(base.calls[0].op, "generateMedia");
});

test("X7 NINEROUTER_MUSE_HTTP=0 disables the driver", async () => {
  const base = fakeBase();
  const { wrap } = freshExecutor({ __MUSE_STUB_MODE: "ok", NINEROUTER_MUSE_HTTP: "0" });
  const result = await wrap(base).execute(ctx());
  assert.deepEqual(await result.response.json(), { from: "browser" });
  assert.equal(base.calls.length, 1);
  const off = await wrap(base).generateMedia({ prompt: "x", kind: "image", credentials: { apiKey: "h" }, log: () => {} });
  assert.equal(off[0].b64, "QlJPV1NFUg==");
});

test("X8 methods the driver does not own reach the base executor", async () => {
  const base = fakeBase();
  const { wrap } = freshExecutor({ __MUSE_STUB_MODE: "ok" });
  const executor = wrap(base);
  assert.deepEqual(await executor.testConnection(), { ok: true, via: "browser" });
  assert.equal(base.calls[0].op, "testConnection");
  base.marker = "kept";
  assert.equal(executor.marker, "kept", "reads pass through the proxy");
  executor.other = 42;
  assert.equal(base.other, 42, "writes land on the base executor");
});

test("X9 a missing driver degrades instead of crashing", async () => {
  const saved = process.env.MUSE_HOME;
  process.env.MUSE_HOME = path.join(HOME, "does-not-exist");
  delete require.cache[require.resolve("./muse-web-http-executor.cjs")];
  try {
    const base = fakeBase();
    const mod = require("./muse-web-http-executor.cjs");
    const result = await mod.wrap(base).execute(ctx());
    assert.deepEqual(await result.response.json(), { from: "browser" }, "chat still works via the browser");
    assert.equal(base.calls.length, 1);
  } finally {
    process.env.MUSE_HOME = saved;
    delete require.cache[require.resolve("./muse-web-http-executor.cjs")];
  }
});

test("X10 a non-callable logger from the host must not break the path", async () => {
  const base = fakeBase();
  const { wrap } = freshExecutor({ __MUSE_STUB_MODE: "fail" });
  const fallback = await wrap(base).execute(ctx({ log: { info() {}, warn() {} } }));
  assert.deepEqual(await fallback.response.json(), { from: "browser" }, "an object logger does not break the fallback");
  const also = await wrap(base).execute(ctx({ log: "not-a-function" }));
  assert.deepEqual(await also.response.json(), { from: "browser" }, "nor does a string one");
  const media = await wrap(base).generateMedia({ prompt: "x", kind: "image", log: { info() {} }, credentials: { apiKey: "h" } });
  assert.deepEqual(media, [{ b64: "QlJPV1NFUg==", mime: "image/png" }], "and the media fallback");
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`ok   ${c.name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${c.name}\n     ${String(err && err.message).split("\n").join("\n     ")}`);
      if (process.env.EXEC_STACK) console.log(err && err.stack);
    }
  }
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(failed ? `${failed}/${cases.length} FAILED` : `all ${cases.length} executor cases passed`);
  process.exit(failed ? 1 : 0);
})();
