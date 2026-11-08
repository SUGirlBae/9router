// Concurrency proof for the parts WE control: many turns at once over the
// direct driver without head-of-line blocking.
//
//   node muse/parallel-muse.js            # offline: 8 turns against the fake tunnel
//   MUSE_LIVE=1 node muse/parallel-muse.js 6   # real account, SPENDS 6 messages
//
// The live ceiling is Muse's single agent VM (measured in master-plan.md:
// 1 turn ~5 s, 3 turns ~20 s each), which this script cannot fix — it only
// proves our layer does not add serialisation on top of it.
"use strict";

const os = require("node:os");
const path = require("node:path");

const { MuseBridge } = require("./muse-bridge.cjs");
const { AccountPool } = require("./lib/pool.cjs");
const { FakeTunnel } = require("./fake-tunnel.cjs");

const LIVE = process.env.MUSE_LIVE === "1";
const N = Number(process.argv[2] || (LIVE ? 6 : 8));

function fakeBridge() {
  const pool = new AccountPool({
    file: path.join(os.tmpdir(), `muse-parallel-${process.pid}.json`),
    accounts: [{ label: "acct-a", cookies: "hatch_sess=1", state: "active", cooldownUntil: 0 }, { label: "acct-b", cookies: "hatch_sess=2", state: "active", cooldownUntil: 0 }],
  });
  let active = 0;
  let peak = 0;
  const bridge = new MuseBridge({
    pool,
    pollIntervalMs: 15,
    quietMs: 25,
    turnBudgetMs: 4000,
    log: () => {},
    sessionFactory: (opts) => ({
      missingRequired: () => null,
      ensureRunning: async () => ({ session: { vmId: "vm", endpointUrl: "h", vmState: "RUNNING", vmType: "hatch_vm" } }),
      tokens: async () => ({ authToken: "t", notaryToken: null }),
      wsUrl: () => "wss://example.invalid/v1/noise",
      label: opts.label,
    }),
    transportFactory: () => {
      active += 1;
      peak = Math.max(peak, active);
      const tunnel = new FakeTunnel({
        onRequest: (record, t) => {
          if (record.path === "/chat/stream") {
            t.reply(record.streamId, { status: 200, body: '{"message_id":"u"}', endBody: true });
            return;
          }
          if (record.path.startsWith("/chat/history")) {
            const done = {
              event_name: "message.assistant",
              role: "assistant",
              display_text: "ok",
              display_text_ready: true,
              occurred_at_ms: Date.now(),
              reply_to_message_id: "u",
              payload: {},
            };
            setTimeout(() => {
              t.reply(record.streamId, { status: 200, body: JSON.stringify({ ok: true, result: { chat_events: [done] } }), endBody: true });
            }, 60);
            return;
          }
          t.reply(record.streamId, { status: 404, body: "{}", endBody: true });
        },
      });
      const client = tunnel.clientTransport();
      const close = client.close;
      client.close = () => {
        active = Math.max(0, active - 1);
        return close.call(client);
      };
      return client;
    },
  });
  return { bridge, peakOf: () => peak };
}

function liveBridge() {
  const pool = new AccountPool({});
  return { bridge: new MuseBridge({ pool }), peakOf: () => 1 };
}

const one = async (bridge, index) => {
  const started = Date.now();
  let text = "";
  try {
    for await (const piece of bridge.chat({ messages: [{ role: "user", content: `parallel probe ${index}` }] })) {
      if (piece.delta) text += piece.delta;
    }
    return { index, ok: true, ms: Date.now() - started, chars: text.length };
  } catch (err) {
    return { index, ok: false, ms: Date.now() - started, error: `${err.kind || err.name}: ${String(err.message).slice(0, 80)}` };
  }
};

(async () => {
  const { bridge, peakOf } = LIVE ? liveBridge() : fakeBridge();
  const wall0 = Date.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => one(bridge, i + 1)));
  const wall = Date.now() - wall0;
  const ok = results.filter((r) => r.ok);
  console.log(`${LIVE ? "LIVE" : "OFFLINE"} ${N} turns: ${ok.length}/${N} succeeded in ${wall} ms (peak concurrent tunnels ${peakOf()})`);
  for (const r of results) console.log(`  turn ${String(r.index).padStart(2)} ${r.ok ? `ok   ${r.ms} ms ${r.chars} chars` : `FAIL ${r.ms} ms ${r.error}`}`);
  const serial = ok.reduce((sum, r) => sum + r.ms, 0);
  if (ok.length > 1) {
    const speedup = serial / wall;
    console.log(`  serial would be ${serial} ms vs wall ${wall} ms -> speedup ${speedup.toFixed(2)}x of ${N} (no head-of-line blocking in our layer if it approaches ${N})`);
    if (!LIVE && speedup < N / 2) {
      console.log("FAIL: offline run should be nearly fully parallel");
      process.exit(1);
    }
  }
  bridge.close();
  if (!LIVE && ok.length !== N) {
    console.log("FAIL: offline run must be fully green");
    process.exit(1);
  }
})();
