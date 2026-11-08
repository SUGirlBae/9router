// Framing tests for the tunnel's protobuf layer. Offline, deterministic.
//
//   W1  POST /api/ping reproduces the reference client's bytes exactly, layer
//       by layer (ApplicationRequest -> ServiceFrame -> ServiceRequest ->
//       NoiseTransportFrame) — the worked example in protocol-notes.md §C1
//   W2  every message decodes back to what it encoded
//   W3  multi-chunk split + reassemble, including interleaved and unordered
//   W4  a large inbound single chunk is accepted (rejecting it stalls turns)
//   W5  assembly and pending-map caps
//   W6  varint and signed64 edge cases
//
// Run: node muse/test-wire.js
"use strict";

const assert = require("node:assert/strict");
const pb = require("./lib/pb.cjs");
const wire = require("./lib/wire.cjs");

const hex = (buf) => Buffer.from(buf).toString("hex");
const hx = (s) => Buffer.from(s, "hex");

const PING_HEADERS = [
  ["Content-Type", "application/json"],
  ["x-request-id", "00000000-0000-4000-8000-000000000001"],
  ["x-app-id", "hatch-web"],
  ["Accept-Language", "en-US"],
];
const PING_REQUEST_HEX =
  "0a04504f5354" +
  "12092f6170692f70696e67" +
  "1a200a0c436f6e74656e742d5479706512106170706c69636174696f6e2f6a736f6e" +
  "1a340a0c782d726571756573742d6964122430303030303030302d303030302d343030302d383030302d303030303030303030303031" +
  "1a150a08782d6170702d6964120968617463682d776562" +
  "1a180a0f4163636570742d4c616e67756167651205656e2d5553" +
  "22027b7d2801";

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("W1 /api/ping reproduces the reference bytes layer by layer", () => {
  const appRequest = wire.encodeApplicationRequest({
    verb: "POST",
    path: "/api/ping",
    headers: PING_HEADERS,
    body: Buffer.from("{}"),
    endBody: true,
  });
  assert.equal(hex(appRequest), PING_REQUEST_HEX, "ApplicationRequest");

  const serviceFrame = wire.encodeServiceFrame(1, "request", appRequest);
  assert.equal(hex(serviceFrame), "0801" + "12a001" + PING_REQUEST_HEX, "ServiceFrame");

  const serviceRequest = wire.encodeServiceRequest(wire.SERVICES.daemon, serviceFrame);
  assert.equal(hex(serviceRequest), "0800" + "12a501" + hex(serviceFrame), "ServiceRequest");
  assert.equal(serviceRequest.length, 170, "ServiceRequest is 170 bytes total");

  const chunks = wire.splitNoisePayload(serviceRequest, { chunkId: 5 });
  assert.equal(chunks.length, 1, "a 170-byte envelope is one chunk");
  assert.equal(
    hex(chunks[0]),
    "080510001801" + "22aa01" + hex(serviceRequest),
    "NoiseTransportFrame: chunk_id 5, index 0, total 1, then the payload"
  );

  const parsed = pb.decode(chunks[0]);
  assert.equal(Number(pb.one(parsed, 1)), 5, "chunk_id");
  assert.equal(pb.asNum(pb.one(parsed, 3)), 1, "total_chunks");
  assert.equal(hex(pb.one(parsed, 4)), hex(serviceRequest), "payload survives the chunk");
});

test("W2 every message round-trips through its decoder", () => {
  const request = wire.encodeApplicationRequest({
    verb: "get",
    path: "/chat/history?session_id=abc",
    headers: [["x-app-id", "hatch-web"]],
    body: Buffer.alloc(0),
    endBody: true,
  });
  const decodedRequest = wire.decodeApplicationRequest(request);
  assert.equal(decodedRequest.verb, "GET", "the verb is upper-cased on the wire");
  assert.equal(decodedRequest.path, "/chat/history?session_id=abc", "GET folds its query into the path");
  assert.equal(decodedRequest.body.length, 0, "an empty body is omitted entirely");
  assert.deepEqual(decodedRequest.headers, [{ key: "x-app-id", value: "hatch-web" }]);

  const response = wire.encodeApplicationResponse({
    status: 200,
    headers: [["content-type", "application/json"]],
    body: Buffer.from('{"ok":true}\n'),
    endBody: false,
  });
  const frame = wire.encodeServiceFrame(7, "response", response);
  const decodedFrame = wire.decodeServiceFrame(frame);
  assert.equal(decodedFrame.streamId, 7);
  assert.equal(decodedFrame.kind, "response");
  const decodedResponse = wire.decodeApplicationResponse(decodedFrame.payload);
  assert.equal(decodedResponse.status, 200);
  assert.equal(decodedResponse.endBody, false);
  assert.equal(decodedResponse.body.toString(), '{"ok":true}\n');
  assert.deepEqual(decodedResponse.headers, [{ key: "content-type", value: "application/json" }]);

  const chunkFrame = wire.encodeServiceFrame(9, "body_chunk", wire.encodeBodyChunk(Buffer.from("delta"), true));
  const decodedChunk = wire.decodeServiceFrame(chunkFrame);
  assert.equal(decodedChunk.kind, "body_chunk");
  assert.deepEqual(wire.decodeBodyChunk(decodedChunk.payload), { data: Buffer.from("delta"), endBody: true });

  const resetFrame = wire.encodeServiceFrame(9, "reset", wire.encodeReset(1, "client done"));
  const decodedReset = wire.decodeServiceFrame(resetFrame);
  assert.equal(decodedReset.kind, "reset");
  assert.deepEqual(wire.decodeReset(decodedReset.payload), { code: 1, reason: "client done" });

  const inbound = wire.encodeServiceRequest(wire.SERVICES.sentinel, wire.encodeServiceFrame(3, "request", request));
  const decodedInbound = wire.decodeServiceRequest(inbound);
  assert.equal(decodedInbound.service, wire.SERVICES.sentinel);
  assert.equal(wire.decodeServiceFrame(decodedInbound.payload).streamId, 3);

  const asResponse = wire.encodeServiceResponse(chunkFrame);
  assert.equal(hex(wire.decodeServiceResponse(asResponse)), hex(chunkFrame));
  assert.throws(() => wire.decodeServiceResponse(Buffer.alloc(3)), pb.PbError, "a ServiceResponse needs field 1");
});

test("W3 split and reassemble across unordered, interleaved chunks", () => {
  const envelope = Buffer.from("a".repeat(2000), "utf8");
  const frames = wire.splitNoisePayload(envelope, { chunkSize: 700, chunkId: 42n });
  assert.equal(frames.length, 3, "2000 bytes at 700 per chunk");

  const reassembler = new wire.NoiseReassembler();
  assert.equal(reassembler.feed(frames[2]), null, "an incomplete assembly returns nothing");
  assert.equal(reassembler.feed(frames[0]), null);
  assert.equal(reassembler.pendingCount, 1);
  const done = reassembler.feed(frames[1]);
  assert.equal(done && done.toString("utf8"), envelope.toString("utf8"), "unordered arrival still assembles");
  assert.equal(reassembler.pendingCount, 0, "a finished assembly is dropped");

  // Two messages in flight at once, fully interleaved.
  const a = wire.splitNoisePayload(Buffer.from("AAAA"), { chunkSize: 2, chunkId: 100n });
  const b = wire.splitNoisePayload(Buffer.from("BBBBBB"), { chunkSize: 2, chunkId: 200n });
  const mixed = new wire.NoiseReassembler();
  const results = [];
  for (const frame of [...a, ...b].sort(() => Math.random() - 0.5)) {
    const out = mixed.feed(frame);
    if (out) results.push(out.toString());
  }
  assert.deepEqual(results.sort(), ["AAAA", "BBBBBB"], "interleaved assemblies stay separate");

  assert.equal(hex(wire.splitNoisePayload(Buffer.alloc(0))[0]).includes("2200"), true, "an empty envelope still emits one chunk");
  assert.equal(wire.splitNoisePayload(Buffer.alloc(0)).length, 1);
});

test("W4 a large inbound single chunk is accepted", () => {
  const big = Buffer.alloc(wire.MAX_CHUNK_PAYLOAD + 4096, 7);
  // Built by hand: the outbound splitter would fragment this, the gateway may not.
  const frame = Buffer.concat([
    pb.fieldVarint(1, 7n),
    pb.fieldVarint(2, 0),
    pb.fieldVarint(3, 1),
    pb.fieldBytes(4, big),
  ]);
  const reassembler = new wire.NoiseReassembler();
  const out = reassembler.feed(frame);
  assert.equal(out.length, big.length, "the gateway may send one chunk bigger than the outbound split");
  assert.equal(out[0], 7);

  const oversized = Buffer.concat([
    pb.fieldVarint(1, 1n),
    pb.fieldVarint(2, 0),
    pb.fieldVarint(3, 1),
    pb.fieldBytes(4, Buffer.alloc(wire.MAX_INBOUND_CHUNK + 1)),
  ]);
  assert.throws(
    () => new wire.NoiseReassembler().feed(oversized),
    /exceeds/,
    "a chunk above the inbound cap is refused rather than buffered forever"
  );
});

test("W5 assembly and pending-map caps", () => {
  const reassembler = new wire.NoiseReassembler({ maxAssemblyBytes: 5000, maxPending: 3 });
  for (let id = 0; id < 3; id += 1) {
    reassembler.feed(wire.splitNoisePayload(Buffer.alloc(100, id), { chunkSize: 50, chunkId: BigInt(id) })[0]);
  }
  assert.equal(reassembler.pendingCount, 3, "three assemblies are open");
  reassembler.feed(wire.splitNoisePayload(Buffer.alloc(100), { chunkSize: 50, chunkId: 99n })[0]);
  assert.equal(reassembler.pendingCount, 3, "the fourth evicted the oldest instead of growing");

  const huge = new wire.NoiseReassembler({ maxAssemblyBytes: 1000 });
  const frames = wire.splitNoisePayload(Buffer.alloc(3000), { chunkSize: 500, chunkId: 555n });
  assert.throws(() => {
    for (const frame of frames) huge.feed(frame);
  }, /exceeds/, "assembly is capped at maxAssemblyBytes");
});

test("W6 varint and signed64 edge cases", () => {
  assert.equal(hex(pb.fieldBytes(4, Buffer.alloc(200))), "22c801" + "00".repeat(200), "length >= 128 uses a two-byte varint");
  assert.equal(hex(pb.fieldVarint(1, -1)), "08" + "ff".repeat(9) + "01", "int64 -1 is ten bytes two's complement");
  assert.equal(pb.signed64(pb.readVarint(hx("ff".repeat(9) + "01"), 0).value), -1n);
  assert.equal(pb.signed64(5n), 5n);
  assert.throws(() => pb.readVarint(Buffer.from([0x80, 0x80]), 0), pb.PbError, "a truncated varint is an error");
  assert.throws(
    () => pb.decode(Buffer.from([0x0f, 0x01])),
    pb.PbError,
    "wire type 7 is rejected"
  );
  const decoded = pb.decode(Buffer.concat([pb.fieldVarint(1, 5n), pb.fieldBytes(2, Buffer.from("hi")), Buffer.from([0x1d, 1, 0, 0, 0])]));
  assert.equal(pb.asNum(pb.one(decoded, 1)), 5);
  assert.equal(pb.asText(pb.one(decoded, 2)), "hi");
  assert.equal(pb.one(decoded, 3), 1, "fixed32 is readable");
  assert.equal(pb.many(decoded, 1).length, 1);
  assert.equal(hex(pb.fieldBytes(4, Buffer.alloc(0))), "2200", "an empty bytes field keeps its tag");
  assert.equal(wire.requestHeaders({ requestId: "r1", method: "GET" })[0][0], "x-request-id", "GET sends no Content-Type first");
  assert.equal(wire.requestHeaders({ requestId: "r1", method: "POST" })[0][0], "Content-Type");
  assert.equal(wire.requestHeaders({ requestId: "r1", method: "POST" }).length, 4, "the four default headers");
});

let failed = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`ok   ${c.name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${c.name}\n     ${String(err.message).split("\n").join("\n     ")}`);
    if (process.env.WIRE_STACK) console.log(err.stack);
  }
}
console.log(failed ? `${failed}/${cases.length} FAILED` : `all ${cases.length} wire cases passed`);
process.exit(failed ? 1 : 0);
