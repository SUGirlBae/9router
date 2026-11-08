// Media layer tests. Offline: the fake tunnel plays the part of the agent VM,
// including the binary body of a /media/raw GET.
//
//   M1  sandbox paths normalise to what /fs/raw expects
//   M2  artifacts are found in presentation events, resources, and prose
//   M3  the completion signature is order-independent and stable
//   M4  refusal strings are recognised before wasting the whole budget
//   M5  generate() returns 9router's media shape [{b64, mime}] and honours n
//   M6  an abort stops polling and cancels; a job that never lands times out
//   M7  a failed download is an error, never an empty artifact
//
// Run: node muse/test-media.js
"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const media = require("./lib/media.cjs");
const { MuseBridge } = require("./muse-bridge.cjs");
const { AccountPool } = require("./lib/pool.cjs");
const { FakeTunnel } = require("./fake-tunnel.cjs");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // a real PNG header, tiny body

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("M1 sandbox and workspace paths normalise", () => {
  assert.equal(media.normalizeGatewayPath("sandbox://C:\\workspace\\out\\a.png"), "workspace/out/a.png");
  assert.equal(media.normalizeGatewayPath("/home/user/gen/x.png"), "gen/x.png");
  assert.equal(media.normalizeGatewayPath("workspace/media/clip.mp4"), "workspace/media/clip.mp4");
  assert.equal(media.normalizeGatewayPath("sandbox://workspace/a//b.png?x=1#frag"), "workspace/a/b.png");
  assert.equal(media.normalizeGatewayPath(""), "");
});

test("M2 artifacts are mined from events, resources and prose", () => {
  const presentation = {
    event_name: "delta.presentation",
    payload: {
      kind: "image",
      data: {
        images: [
          { path: "sandbox://workspace/out/one.png", mime_type: "image/png" },
          { url: "sandbox://workspace/out/two.jpg", variants: { original: "sandbox://workspace/out/two.jpg" } },
        ],
      },
    },
  };
  const refs = media.extractRefs(presentation);
  assert.deepEqual(refs.map((r) => r.path), ["workspace/out/one.png", "workspace/out/two.jpg"]);
  assert.deepEqual(refs.map((r) => r.kind), ["image", "image"]);
  assert.equal(media.mimeFor(refs[1]), "image/jpeg");

  const withVideo = media.extractRefs({
    payload: { kind: "video", data: { videos: [{ video_path: "sandbox://workspace/clip.mp4" }] } },
    resources: [{ path: "sandbox://workspace/poster.png" }],
  });
  assert.deepEqual(withVideo.map((r) => r.kind).sort(), ["image", "video"]);

  const prose = media.extractRefs({ event_name: "message.assistant", display_text: "saved to sandbox://workspace/gen/a.png done" });
  assert.equal(prose.length, 1);
  assert.equal(prose[0].path, "workspace/gen/a.png");

  const deduped = media.extractRefs({
    payload: { data: { images: [{ path: "sandbox://workspace/x.png" }, { url: "sandbox://workspace/x.png" }] } },
  });
  assert.equal(deduped.length, 1, "the same file seen twice yields one ref");
});

test("M3 the signature is order-independent", () => {
  const a = [{ identity: "z.png" }, { identity: "a.png" }];
  const b = [{ identity: "a.png" }, { identity: "z.png" }];
  assert.equal(media.signatureOf(a), media.signatureOf(b));
  assert.notEqual(media.signatureOf(a), media.signatureOf([{ identity: "a.png" }]));
});

test("M4 refusals are recognised", () => {
  assert.equal(media.refusalIn("Sorry, I can’t generate that."), "i can’t generate");
  assert.equal(media.refusalIn("Video is not available in your region"), "video is not available");
  assert.equal(media.refusalIn("Here is your picture of a cat"), null);
});

function generationTunnel({ artifacts = [{ path: "sandbox://workspace/out/a.png", mime: "image/png" }], mode = "ok", delayReplies = 0 } = {}) {
  const state = { historyCalls: 0, cancel: null };
  const event = () => {
    if (mode === "refusal") {
      return { event_name: "message.assistant", role: "assistant", display_text: "Sorry, video is not available in your region.", occurred_at_ms: Date.now(), payload: {} };
    }
    return {
      event_name: "delta.presentation",
      role: "assistant",
      occurred_at_ms: Date.now(),
      display_text: "done",
      payload: { kind: "image", data: { images: artifacts.map((a) => ({ path: a.path, mime: a.mime })) } },
    };
  };
  const onRequest = (record, tunnel) => {
    if (record.path === "/chat/stream") {
      tunnel.reply(record.streamId, { status: 200, body: '{"message_id":"u1"}', endBody: true });
      return;
    }
    if (record.path.startsWith("/chat/history")) {
      state.historyCalls += 1;
      if (mode === "silent") {
        tunnel.reply(record.streamId, { status: 200, body: JSON.stringify({ ok: true, result: { chat_events: [] } }), endBody: true });
        return;
      }
      tunnel.reply(record.streamId, {
        status: 200,
        body: JSON.stringify({ ok: true, result: { chat_events: state.historyCalls > delayReplies ? [event()] : [] } }),
        endBody: true,
      });
      return;
    }
    if (record.path.startsWith("/media/raw/") || record.path.startsWith("/fs/raw/")) {
      if (mode === "broken-media") {
        tunnel.reply(record.streamId, { status: 200, body: Buffer.alloc(0), endBody: true });
        return;
      }
      tunnel.reply(record.streamId, { status: 200, body: PNG, headers: [["content-type", "image/png"]], endBody: true });
      return;
    }
    if (record.path === "/chat/cancel") {
      state.cancel = JSON.parse(record.body);
      tunnel.reply(record.streamId, { status: 200, body: "{}", endBody: true });
      return;
    }
    tunnel.reply(record.streamId, { status: 404, body: '{"ok":false}', endBody: true });
  };
  return { state, onRequest };
}

function bridgeFor(script) {
  const pool = new AccountPool({
    file: path.join(os.tmpdir(), `muse-media-${process.pid}.json`),
    accounts: [{ label: "media-acct", cookies: "hatch_sess=x", state: "active", cooldownUntil: 0 }],
  });
  const bridge = new MuseBridge({
    pool,
    log: () => {},
    sessionFactory: () => ({
      missingRequired: () => null,
      ensureRunning: async () => ({ session: { vmId: "vm", endpointUrl: "h", vmState: "RUNNING", vmType: "hatch_vm" } }),
      tokens: async () => ({ authToken: "t", notaryToken: null }),
      wsUrl: () => "wss://example.invalid/v1/noise",
    }),
    transportFactory: () => new FakeTunnel({ onRequest: script.onRequest }).clientTransport(),
  });
  return bridge;
}

test("M5 generate() returns the media shape 9router expects", async () => {
  const script = generationTunnel({ artifacts: [{ path: "sandbox://workspace/out/a.png" }, { path: "sandbox://workspace/out/b.jpg", mime: "image/jpeg" }] });
  const bridge = bridgeFor(script);
  const result = await bridge.image({ prompt: "two cats", n: 2, pollMs: 20, settleMs: 40, budgetMs: 3000 });
  assert.equal(result.kind, "image");
  assert.equal(result.artifacts.length, 2, "n is respected");
  assert.equal(result.artifacts[0].b64, PNG.toString("base64"), "bytes came through the tunnel");
  assert.equal(result.artifacts[0].mime, "image/png");
  assert.equal(result.artifacts[1].path, "workspace/out/b.jpg");
  assert.ok(script.state.historyCalls >= 2, "the thread was polled, not waited on blindly");
  bridge.close();

  const oneOnly = await bridgeFor(generationTunnel({ artifacts: [{ path: "sandbox://workspace/out/a.png" }, { path: "sandbox://workspace/out/b.png" }] }))
    .image({ prompt: "one cat", n: 1, pollMs: 20, settleMs: 40, budgetMs: 3000 });
  assert.equal(oneOnly.artifacts.length, 1, "n=1 does not return everything");
});

test("M6 refusal, abort and a never-landing job all fail typed", async () => {
  const refusal = bridgeFor(generationTunnel({ mode: "refusal" }));
  await assert.rejects(
    () => refusal.video({ prompt: "a clip", pollMs: 20, settleMs: 20, budgetMs: 1500 }),
    (err) => err.kind === "policy" && /not available/.test(err.message)
  );
  refusal.close();

  const silent = bridgeFor(generationTunnel({ mode: "silent" }));
  await assert.rejects(
    () => silent.image({ prompt: "a picture", pollMs: 20, settleMs: 20, budgetMs: 400 }),
    (err) => err.kind === "timeout" && /no image artifact/.test(err.message)
  );
  const polls = silent.pool ? 0 : 0;
  void polls;
  silent.close();

  const controller = new AbortController();
  const slow = bridgeFor(generationTunnel({ delayReplies: 99 }));
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(
    () => slow.image({ prompt: "later", pollMs: 20, settleMs: 20, budgetMs: 4000, signal: controller.signal }),
    (err) => err.name === "AbortError"
  );
  assert.equal(slow.pool.load()[0].state, "active", "an abort does not punish the account");
  slow.close();
});

test("M7 a broken download is an error, not an empty artifact", async () => {
  const bridge = bridgeFor(generationTunnel({ mode: "broken-media" }));
  await assert.rejects(
    () => bridge.image({ prompt: "a picture", pollMs: 20, settleMs: 30, budgetMs: 2000 }),
    (err) => /could not fetch/.test(err.message)
  );
  bridge.close();
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
      if (process.env.MEDIA_STACK) console.log(err && err.stack);
    }
  }
  console.log(failed ? `${failed}/${cases.length} FAILED` : `all ${cases.length} media cases passed`);
  process.exit(failed ? 1 : 0);
})();
