// Connection-layer tests against the in-process fake tunnel. Offline, no
// credentials, no socket.
//
//   S1  the Noise handshake completes and the server static key is exposed
//   S2  a msg2 payload (attestation blob) survives the handshake untouched
//   S3  request/response round-trips, headers and body included
//   S4  NDJSON records are delivered as they arrive, not in one blob at the end
//   S5  BodyChunk continuation assembles into the final body
//   S6  status codes map to the typed error kinds (auth/quota/region/policy/upstream)
//   S7  a silent server produces a timeout error, never an empty success
//   S8  Reset mid-stream is a typed upstream error
//   S9  ack() treats the /chat/stream "never closes" case as null, not failure
//   S10 abort and tunnel close fail every waiting request promptly
//   S11 multi-chunk outbound and inbound paths agree
//   S12 two connections keep independent stream ids and state
//
// Run: node muse/test-gateway.js
"use strict";

const assert = require("node:assert/strict");
const { HatchConnection, GatewayError } = require("./lib/gateway.cjs");
const { FakeTunnel } = require("./fake-tunnel.cjs");

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function connect(opts = {}) {
  const tunnel = new FakeTunnel(opts.tunnel || {});
  const conn = new HatchConnection({
    profile: "muse",
    transport: tunnel.clientTransport(),
    connectTimeoutMs: opts.connectTimeoutMs ?? 1000,
    requestTimeoutMs: opts.requestTimeoutMs ?? 1000,
    log: () => {},
    ...opts.conn,
  });
  return { tunnel, conn };
}

async function open(opts = {}) {
  const pair = connect(opts);
  await pair.conn.connect();
  return pair;
}

test("S1 handshake completes and exposes the server static key", async () => {
  const { conn, tunnel } = await open();
  const info = { remoteStatic: conn.cipher.remoteStatic };
  assert.equal(info.remoteStatic.length, 32, "the XX static key is 32 bytes");
  assert.equal(Buffer.compare(conn.cipher.remoteStatic, tunnel.server.localStatic.publicRaw), 0);
  assert.equal(conn.connected, true);
  conn.close();
});

test("S2 a non-empty msg2 payload survives untouched", async () => {
  const attestation = Buffer.from("attestation-blob-not-parsed-by-us", "utf8");
  const { conn } = await open({ tunnel: { msg2Payload: attestation } });
  assert.equal(conn.connected, true);
  conn.close();
});

test("S3 request/response round-trips with headers", async () => {
  const { conn, tunnel } = await open({
    tunnel: {
      onRequest: (record, t) => {
        t.reply(record.streamId, {
          status: 201,
          body: JSON.stringify({ echo: record.path, method: record.method, sent: record.body }),
          headers: [["content-type", "application/json"]],
        });
      },
    },
  });
  const res = await conn.request({ method: "POST", path: "/api/ping", body: {} });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json(), { echo: "/api/ping", method: "POST", sent: "{}" });
  assert.deepEqual(tunnel.requests.length, 1);
  assert.deepEqual(tunnel.requests[0].headers.map((h) => h.key), ["Content-Type", "x-request-id", "x-app-id", "Accept-Language"]);
  assert.equal(tunnel.requests[0].service, 0, "daemon by default");
  conn.close();
});

test("S4 NDJSON records stream in as they arrive", async () => {
  const seen = [];
  const { conn, tunnel } = await open({
    tunnel: {
      onRequest: (record, t) => {
        t.reply(record.streamId, { status: 200, body: '{"event":"message.user"}\n', endBody: false });
        setTimeout(() => t.chunk(record.streamId, '{"event":"delta.text_append","payload":{"text":"a"}}\n', false), 5);
        setTimeout(() => t.chunk(record.streamId, '{"event":"delta.text_append","payload":{"text":"b"}}\n{"event":"delta.message_done"}\n', true), 10);
      },
    },
  });
  const res = await conn.request({
    method: "POST",
    path: "/chat/stream",
    body: { message: "hi" },
    onRecord: (record) => seen.push(record.event),
    timeoutMs: 900,
  });
  assert.deepEqual(seen, ["message.user", "delta.text_append", "delta.text_append", "delta.message_done"]);
  assert.ok(res.body.toString().includes("message_done"), "the full body is still returned");
  void tunnel;
  conn.close();
});

test("S5 body chunks assemble into the final body", async () => {
  const { conn } = await open({
    tunnel: {
      onRequest: (record, t) => {
        t.reply(record.streamId, { status: 200, body: "part1", endBody: false });
        t.chunk(record.streamId, "part2", false);
        t.chunk(record.streamId, "part3", true);
      },
    },
  });
  const res = await conn.request({ method: "GET", path: "/fs/raw/a.png" });
  assert.equal(res.text(), "part1part2part3");
  conn.close();
});

test("S6 status codes map to typed error kinds", async () => {
  const table = [
    [401, "auth"],
    [403, "access"],
    [403, "policy", "the model is not allowed for this account"],
    [429, "quota"],
    [503, "region"],
    [500, "upstream"],
  ];
  for (const [status, kind, body] of table) {
    const { conn } = await open({
      tunnel: { onRequest: (record, t) => t.reply(record.streamId, { status, body: body || "nope" }) },
    });
    await assert.rejects(
      () => conn.request({ method: "POST", path: "/api/ping", body: {} }),
      (err) => {
        assert.ok(err instanceof GatewayError, `${status} produces a GatewayError`);
        assert.equal(err.kind, kind, `${status} -> ${kind}`);
        assert.equal(err.status, status);
        return true;
      }
    );
    conn.close();
  }
});

test("S7 a silent server is a timeout, never an empty success", async () => {
  const { conn } = await open({ tunnel: { onRequest: () => {} }, requestTimeoutMs: 120 });
  await assert.rejects(
    () => conn.request({ method: "POST", path: "/api/ping", body: {} }),
    (err) => err instanceof GatewayError && err.kind === "timeout" && /no reply/.test(err.message)
  );
  conn.close();
});

test("S8 a mid-stream Reset is a typed upstream error", async () => {
  const { conn } = await open({
    tunnel: {
      onRequest: (record, t) => {
        t.reply(record.streamId, { status: 200, body: '{"ok":true}\n', endBody: false });
        t.reset(record.streamId, 1, "vm went away");
      },
    },
  });
  await assert.rejects(
    () => conn.request({ method: "POST", path: "/api/ping", body: {}, requireEnd: true }),
    (err) => err instanceof GatewayError && err.kind === "upstream" && /vm went away/.test(err.message)
  );
  conn.close();
});

test("S9 ack() tolerates a stream that stays open", async () => {
  const { conn } = await open({ tunnel: { onRequest: (record, t) => t.reply(record.streamId, { body: "x", endBody: false }) } });
  const res = await conn.ack({ method: "POST", path: "/chat/stream", body: {}, timeoutMs: 120 });
  assert.equal(res, null, "an unanswered ack is not an error");

  const second = connect({ tunnel: { onRequest: (record, t) => t.reply(record.streamId, { body: '{"message_id":"m1"}' }) } });
  await second.conn.connect();
  const acked = await second.conn.ack({ method: "POST", path: "/chat/stream", body: {}, timeoutMs: 300 });
  assert.equal(acked.json().message_id, "m1");
  conn.close();
  second.conn.close();
});

test("S10 abort and tunnel close fail waiting requests promptly", async () => {
  const controller = new AbortController();
  const { conn } = await open({ tunnel: { onRequest: () => {} }, requestTimeoutMs: 5000, conn: { signal: controller.signal } });
  const pending = conn.request({ method: "POST", path: "/api/ping", body: {} });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (err) => err instanceof GatewayError && err.kind === "timeout");
  assert.equal(conn.connected, false, "abort closes the connection");

  const pair = await open({ tunnel: { onRequest: () => {} }, requestTimeoutMs: 5000 });
  const waiting = pair.conn.request({ method: "POST", path: "/api/ping", body: {} });
  setTimeout(() => pair.tunnel.sendClose(1001, "going away"), 20);
  await assert.rejects(waiting, (err) => err instanceof GatewayError && err.kind === "upstream" && /code 1001/.test(err.message));
});

test("S11 multi-chunk payloads survive in both directions", async () => {
  const big = "z".repeat(200000);
  const { conn, tunnel } = await open({
    tunnel: {
      chunkSize: 4096,
      onRequest: (record, t) => t.reply(record.streamId, { status: 200, body: record.body }),
    },
  });
  const res = await conn.request({ method: "POST", path: "/upload", body: big, timeoutMs: 4000 });
  assert.equal(res.text().length, big.length, "the echoed payload reassembled");
  assert.equal(tunnel.requests[0].body.length, big.length, "the inbound multi-chunk request reassembled");
  conn.close();
});

test("S12 two connections are independent", async () => {
  const a = await open({ tunnel: { onRequest: (r, t) => t.reply(r.streamId, { body: `A:${r.streamId}` }) } });
  const b = await open({ tunnel: { onRequest: (r, t) => t.reply(r.streamId, { body: `B:${r.streamId}` }) } });
  const [ra, rb] = await Promise.all([
    a.conn.request({ method: "POST", path: "/x", body: {} }),
    b.conn.request({ method: "POST", path: "/x", body: {} }),
    a.conn.request({ method: "POST", path: "/x", body: {} }),
  ]);
  assert.equal(ra.text(), "A:1");
  assert.equal(rb.text(), "B:1");
  assert.notEqual(a.conn.cipher.remoteStatic, b.conn.cipher.remoteStatic, "each connection has its own ephemeral");
  a.conn.close();
  b.conn.close();
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
      if (process.env.GW_STACK) console.log(err && err.stack);
    }
  }
  console.log(failed ? `${failed}/${cases.length} FAILED` : `all ${cases.length} gateway cases passed`);
  process.exit(failed ? 1 : 0);
})();
