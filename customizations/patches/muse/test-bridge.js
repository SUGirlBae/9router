// Bridge tests: a whole turn against the in-process fake tunnel. Offline, no
// credentials, no quota.
//
//   B1  a turn streams more than one delta, then a terminal frame
//   B2  the final text is the complete answer, not the last fragment
//   B3  a turn that never answers is a typed timeout, never an empty success
//   B4  a quota refusal is typed quota and cools that account down
//   B5  an auth failure marks the account invalid and the next one is tried
//   B6  tool calls are refused before anything is sent
//   B7  an abort stops polling and cancels the turn
//   B8  a canned turn costs no fixed sleep (wall time stays tiny)
//   B9  session ids are stable per conversation and uuid-shaped
//   B10 message flattening keeps system text and detects images
//   B11 /model maps to an OpenAI model list, alias included
//   B12 testConnection reports the account it actually reached
//
// Run: node muse/test-bridge.js
"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { MuseBridge, flattenMessages, deterministicSessionId, pickAssistant } = require("./muse-bridge.cjs");
const { AccountPool } = require("./lib/pool.cjs");
const { FakeTunnel } = require("./fake-tunnel.cjs");
const { GatewayError } = require("./lib/gateway.cjs");

const tmpPoolFile = path.join(os.tmpdir(), `muse-pool-test-${process.pid}.json`);
const COOKIES = "hatch_sess=abc123; hatch_native_auth_device=dev";

function makePool(labels) {
  return new AccountPool({
    file: tmpPoolFile,
    accounts: labels.map((label) => ({ label, cookies: COOKIES, state: "active", cooldownUntil: 0 })),
  });
}

function fakeSession(account) {
  return {
    label: account.label,
    missingRequired: () => null,
    async ensureRunning() {
      return { session: { vmId: "vm-1", endpointUrl: "x.metaaivm.com", vmState: "RUNNING", vmType: "hatch_vm" }, woke: false, waitedMs: 0 };
    },
    async tokens() {
      return { authToken: "token", notaryToken: null };
    },
    wsUrl: () => "wss://example.invalid/v1/noise",
  };
}

// A scripted Muse VM: it answers /chat/stream with an ack, then grows the
// assistant snapshot in /chat/history the way the real channel does.
function scriptedTurn({ snapshots = ["Hel", "Hello ", "Hello there"], readyAt = null, script }) {
  const state = { historyCalls: 0, cancel: null, stream: null, tunnel: null };
  const onRequest = (record, tunnel) => {
    if (script && script(record, tunnel, state) === false) return;
    if (record.path === "/chat/stream") {
      state.stream = JSON.parse(record.body);
      tunnel.reply(record.streamId, { status: 200, body: JSON.stringify({ message_id: "user-msg-1", id: "user-msg-1" }), endBody: true });
      return;
    }
    if (record.path.startsWith("/chat/history")) {
      const index = Math.min(state.historyCalls, snapshots.length - 1);
      const text = snapshots[index];
      state.historyCalls += 1;
      const event = {
        event_name: "message.assistant",
        role: "assistant",
        message_id: "assistant-msg-1",
        reply_to_message_id: "user-msg-1",
        occurred_at_ms: Date.now(),
        display_text: text,
        display_text_ready: index >= (readyAt === null ? snapshots.length - 1 : readyAt),
        seq: index,
        payload: {},
      };
      tunnel.reply(record.streamId, {
        status: 200,
        body: JSON.stringify({ ok: true, result: { channel: "main", chat_events: [event], has_more: false, transcript_revision: index } }) + "\n",
        endBody: true,
      });
      return;
    }
    if (record.path === "/chat/cancel") {
      state.cancel = JSON.parse(record.body);
      tunnel.reply(record.streamId, { status: 200, body: '{"ok":true}', endBody: true });
      return;
    }
    if (record.path === "/model") {
      tunnel.reply(record.streamId, {
        status: 200,
        body: JSON.stringify({
          ok: true,
          result: {
            selected_model: "auto/auto",
            default_model: "auto/auto",
            available_models: [{ id: "auto/auto", provider: "auto", model: "auto", context_window_tokens: 350000, display_name: "Auto", preview_model: false }],
          },
        }),
        endBody: true,
      });
      return;
    }
    if (record.path === "/api/ping") {
      tunnel.reply(record.streamId, { status: 200, body: '{"ok":true,"server_ts_ms":1}', endBody: true });
      return;
    }
    tunnel.reply(record.streamId, { status: 404, body: '{"ok":false,"error":{"code":"not_found"}}', endBody: true });
  };
  return { state, onRequest };
}

function makeBridge({ labels = ["acct-a"], turn, ...rest } = {}) {
  const pool = makePool(labels);
  const scripted = turn || scriptedTurn({});
  const bridge = new MuseBridge({
    pool,
    pollIntervalMs: 10,
    quietMs: 30,
    turnBudgetMs: 1500,
    log: () => {},
    sessionFactory: (opts) => fakeSession(opts),
    transportFactory: () => {
      const tunnel = new FakeTunnel({ onRequest: scripted.onRequest });
      scripted.tunnel = tunnel;
      return tunnel.clientTransport();
    },
    ...rest,
  });
  return { bridge, pool, scripted };
}

async function collect(iterator) {
  const deltas = [];
  let final = null;
  for await (const chunk of iterator) {
    if (chunk.done) final = chunk;
    else if (chunk.delta) deltas.push(chunk.delta);
  }
  return { deltas, final };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("B1 a turn streams more than one delta", async () => {
  const { bridge } = makeBridge();
  const { deltas, final } = await collect(bridge.chat({ messages: [{ role: "user", content: "hi" }] }));
  assert.ok(deltas.length > 1, `expected several deltas, got ${deltas.length}`);
  assert.equal(deltas.join(""), "Hello there");
  assert.ok(final && final.done, "a terminal frame closes the stream");
  bridge.close();
});

test("B2 the terminal frame carries the whole answer", async () => {
  const { bridge } = makeBridge();
  const { final } = await collect(bridge.chat({ messages: [{ role: "user", content: "hi" }] }));
  assert.equal(final.text, "Hello there");
  assert.equal(final.sessionId.length, 36, "the thread id is a uuid");
  assert.deepEqual(final.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, "Muse gives no token counts, so zeros are honest");
  bridge.close();
});

test("B3 an unanswered turn is a typed timeout, never an empty success", async () => {
  const { bridge } = makeBridge({ turn: scriptedTurn({ snapshots: [""] }) });
  const iterator = bridge.chat({ messages: [{ role: "user", content: "hi" }] });
  await assert.rejects(async () => {
    for await (const chunk of iterator) void chunk;
  }, (err) => err instanceof GatewayError && err.kind === "timeout" && /no answer/.test(err.message));
  bridge.close();
});

test("B4 a quota refusal is typed quota and cools the account", async () => {
  const { bridge, pool } = makeBridge({ turn: scriptedTurn({ snapshots: ["You are out of credits for today"] }) });
  const iterator = bridge.chat({ messages: [{ role: "user", content: "hi" }] });
  await assert.rejects(async () => {
    for await (const x of iterator) void x;
  }, (err) => err instanceof GatewayError && err.kind === "quota");
  assert.equal(pool.load()[0].state, "cooling", "the account is parked for an hour");
  assert.equal(pool.available().length, 0, "and no longer offered");
  bridge.close();
});

test("B5 an auth failure marks invalid and moves to the next account", async () => {
  const seen = [];
  const pool = makePool(["acct-a", "acct-b"]);
  const bridge = new MuseBridge({
    pool,
    pollIntervalMs: 10,
    quietMs: 20,
    turnBudgetMs: 800,
    log: () => {},
    sessionFactory: (opts) => {
      seen.push(opts.label);
      if (opts.label === "acct-a") {
        return {
          missingRequired: () => null,
          async ensureRunning() {
            throw new GatewayError("auth", "muse.ai rejected the stored session (401)", { status: 401 });
          },
          tokens: async () => ({}),
          wsUrl: () => "wss://example.invalid",
        };
      }
      const fake = fakeSession(opts);
      return fake;
    },
    transportFactory: () => new FakeTunnel({ onRequest: scriptedTurn({}).onRequest }).clientTransport(),
  });
  const { final } = await collect(bridge.chat({ messages: [{ role: "user", content: "hi" }] }));
  assert.equal(final.text, "Hello there", "the second account served the turn");
  assert.deepEqual(seen, ["acct-a", "acct-b"]);
  assert.equal(pool.load()[0].state, "invalid");
  bridge.close();
});

test("B6 tools are stripped and answered, refused only when mandatory", async () => {
  const { bridge } = makeBridge();
  const out = [];
  for await (const chunk of bridge.chat({
    messages: [{ role: "user", content: "hi", tool_calls: [{ id: "1" }] }],
    tools: [{ type: "function" }],
  })) out.push(chunk);
  const final = out.find((c) => c.done);
  assert.ok(final && final.text === "Hello there", "a client that always sends tools still gets an answer");
  assert.equal(final.toolsStripped, true, "the answer records that tools were dropped");

  const strict = bridge.chat({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function" }], toolChoice: "required" });
  await assert.rejects(async () => {
    for await (const x of strict) void x;
  }, (err) => err instanceof GatewayError && err.kind === "policy" && /tool/i.test(err.message));
  bridge.close();
});

test("B7 aborting stops polling and cancels the turn", async () => {
  const turn = scriptedTurn({ snapshots: ["Once upon"], readyAt: 99 });
  const { bridge } = makeBridge({ turn, turnBudgetMs: 4000, quietMs: 100000 });
  const controller = new AbortController();
  const collected = [];
  const running = (async () => {
    for await (const chunk of bridge.chat({ messages: [{ role: "user", content: "story" }], signal: controller.signal })) {
      collected.push(chunk);
      controller.abort();
    }
  })();
  await assert.rejects(running, (err) => err.name === "AbortError");
  assert.equal(collected.length, 1, "the stream stopped at the abort");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(turn.state.cancel, "/chat/cancel reached the VM");
  assert.equal(turn.state.cancel.reason, "client aborted");
  bridge.close();
});

test("B8 a canned turn costs no fixed sleep", async () => {
  const { bridge } = makeBridge({ turn: scriptedTurn({ snapshots: ["a", "ab", "abc"] }) });
  const started = Date.now();
  const { final } = await collect(bridge.chat({ messages: [{ role: "user", content: "hi" }] }));
  const elapsed = Date.now() - started;
  assert.equal(final.text, "abc");
  assert.ok(elapsed < 1200, `canned turn took ${elapsed}ms`);
  bridge.close();
});

test("B9 session ids are stable, distinct and uuid-shaped", () => {
  const a = deterministicSessionId("first prompt");
  const b = deterministicSessionId("first prompt");
  const c = deterministicSessionId("other prompt");
  assert.equal(a, b, "the same conversation reuses one Muse thread");
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("B10 message flattening keeps instructions and detects images", () => {
  const { prompt, imageParts } = flattenMessages([
    { role: "system", content: "Be terse." },
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:..." } }] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "and now?" },
  ]);
  assert.equal(prompt, "Instructions: Be terse.\n\nUser: look\n\nAssistant: ok\n\nUser: and now?");
  assert.equal(imageParts, 1, "images are counted even though the tunnel is not sent one");
  assert.deepEqual(flattenMessages([{ role: "user", content: "solo" }]).prompt, "User: solo");
});

test("B11 /model becomes an OpenAI list with the alias", async () => {
  const { bridge } = makeBridge();
  const list = await bridge.models();
  assert.equal(list.object, "list");
  const ids = list.data.map((m) => m.id);
  assert.ok(ids.includes("auto/auto"), ids.join(","));
  assert.ok(ids.includes("muse-chat"), "the alias 9router can pin to");
  assert.ok(ids.includes("muse-auto"), "a flat id, because auto/auto is awkward to address");
  assert.equal(list.data.find((m) => m.id === "auto/auto").context_window, 350000);
  bridge.close();
});

test("B12 testConnection names the account it reached", async () => {
  const { bridge } = makeBridge();
  const report = await bridge.testConnection();
  assert.equal(report.ok, true);
  assert.equal(report.account, "acct-a");
  assert.equal(report.ping, 200);
  assert.equal(report.model, "auto/auto");
  assert.equal(report.vmType, "hatch_vm");
  bridge.close();
});

test("B13 pickAssistant ignores stale and user events", () => {
  const now = Date.now();
  const events = [
    { event_name: "message.user", role: "user", display_text: "question", occurred_at_ms: now, reply_to_message_id: null },
    { event_name: "message.assistant", role: "assistant", display_text: "answer", occurred_at_ms: now, reply_to_message_id: "u1" },
    { event_name: "message.assistant", role: "assistant", display_text: "older", occurred_at_ms: now - 10, reply_to_message_id: "u1" },
  ];
  const picked = pickAssistant(events, { afterMs: now - 1, replyTo: "u1" });
  assert.equal(picked.event.display_text, "answer", "the freshest matching assistant event wins");
  assert.equal(picked.done, false, "display_text_ready is absent, so the turn is not finished");
  assert.equal(pickAssistant([events[0]], { afterMs: 0 }), null, "a user echo alone is not an answer");
});

test("B14 a pending approval is answered instead of hanging the turn", async () => {
  const seen = { approvals: 0, decisions: [], service: null, scope: null };
  let unlocked = false;
  const turn = scriptedTurn({
    snapshots: ["Done after approval"],
    script: (record, tunnel, state) => {
      if (record.path === "/approvals") {
        seen.approvals += 1;
        seen.service = record.service;
        tunnel.reply(record.streamId, {
          status: 200,
          body: JSON.stringify({ ok: true, result: { pending_approvals: [{ approval_id: "ap-1", status: "pending", thread_id: record.threadProbe }] } }),
          endBody: true,
        });
        return false;
      }
      if (record.path.startsWith("/approvals/") && record.path.endsWith("/decide")) {
        seen.decisions.push(JSON.parse(record.body));
        unlocked = true;
        tunnel.reply(record.streamId, { status: 200, body: "{\"ok\":true}", endBody: true });
        return false;
      }
      if (record.path.startsWith("/chat/history")) {
        state.historyCalls += 1;
        const done = unlocked;
        tunnel.reply(record.streamId, {
          status: 200,
          body: JSON.stringify({
            ok: true,
            result: {
              chat_events: done
                ? [{ event_name: "message.assistant", role: "assistant", display_text: "Done after approval", display_text_ready: true, occurred_at_ms: Date.now(), message_id: "a1" }]
                : [],
            },
          }),
          endBody: true,
        });
        return false;
      }
      return true;
    },
  });
  const { bridge } = makeBridge({ turn, turnBudgetMs: 6000, approvalAfterMs: 60, approvalSweepMs: 40 });
  const iterator = bridge.chat({ messages: [{ role: "user", content: "go" }] });
  const collected = [];
  for await (const chunk of iterator) collected.push(chunk);
  const final = collected.find((c) => c.done);
  assert.ok(final, "the turn completed once the approval was answered");
  assert.equal(final.text, "Done after approval");
  assert.ok(seen.decisions.length >= 1, "POST /approvals/ap-1/decide was called");
  assert.equal(seen.decisions[0].decision, "deny", "default policy is deny");
  assert.equal(seen.decisions[0].approval_id, "ap-1", "the id is duplicated in the body like the web client");
  assert.equal(seen.service, 1, "approvals live on the sentinel service, not daemon");
  bridge.close();
});

test("B15 the policy is honoured and foreign sessions are left alone", async () => {
  const decisions = [];
  const build = (approvals) => {
    let unlocked = false;
    return {
      turn: scriptedTurn({
        snapshots: ["x"],
        script: (record, tunnel, state) => {
          if (record.path === "/approvals") {
            tunnel.reply(record.streamId, { status: 200, body: JSON.stringify({ ok: true, result: { pending_approvals: approvals(record.streamId) } }), endBody: true });
            return false;
          }
          if (record.path.endsWith("/decide")) {
            decisions.push(JSON.parse(record.body));
            unlocked = true;
            tunnel.reply(record.streamId, { status: 200, body: "{}", endBody: true });
            return false;
          }
          if (record.path.startsWith("/chat/history")) {
            state.historyCalls += 1;
            tunnel.reply(record.streamId, {
              status: 200,
              body: JSON.stringify({ ok: true, result: { chat_events: unlocked ? [{ event_name: "message.assistant", role: "assistant", display_text: "x", display_text_ready: true, occurred_at_ms: Date.now() }] : [] } }),
              endBody: true,
            });
            return false;
          }
          return true;
        },
      }),
    };
  };
  const allowOnce = build(() => [{ id: "ap-9", status: "pending" }]);
  const b1 = makeBridge({ turn: allowOnce.turn, turnBudgetMs: 4000, approvalAfterMs: 50, approvalSweepMs: 30, approvals: "allow_once" });
  for await (const c of b1.bridge.chat({ messages: [{ role: "user", content: "go" }] })) void c;
  assert.equal(decisions[0].decision, "allow_once", "policy override reaches the wire");
  assert.ok(!("always_scope" in decisions[0]), "no scope keys unless allow_always");
  b1.bridge.close();

  decisions.length = 0;
  const foreign = build((sid) => [{ approval_id: "ap-other", status: "pending", thread_id: "not-this-session-" + sid }]);
  const b2 = makeBridge({ turn: foreign.turn, turnBudgetMs: 900, approvalAfterMs: 40, approvalSweepMs: 20 });
  await assert.rejects(async () => {
    for await (const c of b2.bridge.chat({ messages: [{ role: "user", content: "go" }] })) void c;
  }, (err) => err.kind === "timeout");
  assert.equal(decisions.length, 0, "an approval scoped to another thread is never touched");
  b2.bridge.close();
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
      if (process.env.BRIDGE_STACK) console.log(err && err.stack);
    }
  }
  try {
    fs.unlinkSync(tmpPoolFile);
  } catch {
    /* never created */
  }
  console.log(failed ? `${failed}/${cases.length} FAILED` : `all ${cases.length} bridge cases passed`);
  process.exit(failed ? 1 : 0);
})();
