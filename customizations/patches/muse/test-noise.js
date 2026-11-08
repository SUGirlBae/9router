// Noise layer tests. Offline: no network, no credentials.
//
//   N1  the flynn profile reproduces the public XX_25519_AESGCM_SHA256 vectors
//   N2  transport frames match byte-for-byte in BOTH directions (this is what
//       proves Split() hands the initiator T1 and the responder T2)
//   N3  the muse profile and the flynn profile cannot be confused for each other
//   N4  muse profile: message sizes, shared handshake cipher, big-endian nonce
//   N5  tampered / truncated frames throw NoiseError instead of returning garbage
//   N6  message ordering is enforced and the raw X25519 plumbing round-trips
//
// Known open item: the vectors' third handshake message (the initiator's static
// key) does not reproduce under either cipher-sharing convention, while every
// other message in the same block does — including both transport frames.
// protocol-notes.md §A records the hatch client's own rule (one shared handshake
// CipherState, so msg3 encrypts at nonce 1), which is what profile "muse"
// implements. The live handshake is the tie-breaker.
//
// Run: node muse/test-noise.js
"use strict";

const assert = require("node:assert/strict");
const noise = require("./lib/noise.cjs");

const V = require("./fixtures/noise-vectors.json");
const hx = (hexString) => Buffer.from(hexString, "hex");
const hex = (buf) => Buffer.from(buf).toString("hex");
const len2 = (n) => {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(n, 0);
  return head;
};

const XX_KEYS = [
  "Noise_XX_25519_AESGCM_SHA256",
  "Noise_XX_25519_AESGCM_SHA256#1",
  "Noise_XX_25519_AESGCM_SHA256#2",
  "Noise_XX_25519_AESGCM_SHA256#3",
];

// The vector file concatenates tokens without the 2-byte length prefixes that a
// prefixed profile writes: msg1 = e ‖ cleartext payload, msg2 = e ‖ s ‖ payload,
// msg3 = s ‖ payload.
function toWire(strippedHex, messageIndex) {
  const buf = hx(strippedHex);
  if (messageIndex === 0) return buf;
  if (messageIndex === 1) {
    return Buffer.concat([
      buf.subarray(0, 32),
      len2(48),
      buf.subarray(32, 80),
      len2(buf.length - 80),
      buf.subarray(80),
    ]);
  }
  return Buffer.concat([len2(48), buf.subarray(0, 48), len2(buf.length - 48), buf.subarray(48)]);
}

function hsPayloads(vec) {
  return vec.messages.slice(0, 3).map((m) => (m.payload ? hx(m.payload) : Buffer.alloc(0)));
}

function runHandshake(vec, profile) {
  const mk = (role) =>
    new noise.HandshakeXX({
      profile,
      role,
      staticKey: role === "initiator" ? vec.initStatic : vec.respStatic,
      ephemeralKey: role === "initiator" ? vec.initEphemeral : vec.respEphemeral,
      prologue: vec.prologue ? hx(vec.prologue) : undefined,
    });
  const init = mk("initiator");
  const resp = mk("responder");
  const payloads = hsPayloads(vec);
  const wire = [];
  wire.push(init.write(payloads[0]));
  resp.read(wire[0]);
  wire.push(resp.write(payloads[1]));
  const read2 = init.read(wire[1]);
  wire.push(init.write(payloads[2]));
  const read3 = resp.read(wire[2]);
  return { init, resp, wire, payloads, read2, read3 };
}

const describe = (vec, block) =>
  `block ${block} (${vec.prologue ? "prologue " + vec.prologue : "no prologue"}, ` +
  `${hsPayloads(vec).some((p) => p.length) ? "with" : "empty"} payloads)`;

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("N1 flynn profile reproduces the public XX vectors", () => {
  XX_KEYS.forEach((key, block) => {
    const vec = V[key];
    assert.ok(vec && vec.messages.length >= 5, `fixture lost XX block ${block}`);
    const { wire, payloads, read2, read3, init, resp } = runHandshake(vec, "flynn");
    const where = describe(vec, block);
    assert.equal(wire[0].length, 32 + payloads[0].length, `${where}: msg1 size`);
    assert.equal(hex(wire[0]), hex(toWire(vec.messages[0].ciphertext, 0)), `${where}: msg1 bytes`);
    assert.equal(hex(wire[1]), hex(toWire(vec.messages[1].ciphertext, 1)), `${where}: msg2 bytes`);
    assert.equal(hex(init.remoteStatic), hex(resp.localStatic.publicRaw), `${where}: initiator learns resp_static's public key`);
    assert.equal(hex(resp.remoteStatic), hex(init.localStatic.publicRaw), `${where}: responder learns init_static's public key`);
    if (payloads[1].length) assert.equal(hex(read2), hex(payloads[1]), `${where}: msg2 payload`);
    else assert.equal(read2.length, 0, `${where}: msg2 payload stays empty`);
    if (payloads[2].length) assert.equal(hex(read3), hex(payloads[2]), `${where}: msg3 payload`);
    else assert.equal(read3.length, 0, `${where}: msg3 payload stays empty`);
  });
});

test("N2 transport frames match byte-for-byte in both directions", () => {
  XX_KEYS.forEach((key, block) => {
    const vec = V[key];
    const { init, resp } = runHandshake(vec, "flynn");
    const tx = init.split();
    const rx = resp.split();
    const transport = vec.messages.slice(3, 5);
    const where = describe(vec, block);
    assert.equal(hex(tx.encrypt(hx(transport[0].payload))), transport[0].ciphertext, `${where}: initiator frame`);
    assert.equal(hex(rx.encrypt(hx(transport[1].payload))), transport[1].ciphertext, `${where}: responder frame`);
    assert.equal(tx.sendNonce, 1, `${where}: send nonce advanced once`);
    assert.equal(tx.recvNonce, 0, `${where}: receive nonce untouched`);

    // Round-trip on a fresh pair, so the counters start where the vector expects.
    const fresh = runHandshake(vec, "flynn");
    const a = fresh.init.split();
    const b = fresh.resp.split();
    assert.equal(hex(b.decrypt(a.encrypt(Buffer.from("ping")))), hex(Buffer.from("ping")), `${where}: init->resp`);
    assert.equal(hex(a.decrypt(b.encrypt(Buffer.from("pong")))), hex(Buffer.from("pong")), `${where}: resp->init`);
  });
});

test("N3 the muse profile cannot be mistaken for the flynn profile", () => {
  const vec = V[XX_KEYS[0]];
  const flynnSide = runHandshake(vec, "flynn");
  const museSide = runHandshake(vec, "muse");
  assert.notEqual(hex(flynnSide.wire[1]), hex(museSide.wire[1]), "msg2 framing differs by profile");
  const flynnTx = flynnSide.init.split();
  const museTx = museSide.init.split();
  const sample = Buffer.from("7b7d", "hex");
  assert.equal(noise.PROFILES.flynn.transportNonceEndianness, "le");
  assert.equal(noise.PROFILES.muse.transportNonceEndianness, "be");
  assert.notEqual(
    noise.PROFILES.flynn.handshakeLengthPrefix,
    noise.PROFILES.muse.handshakeLengthPrefix,
    "the profiles differ on handshake framing"
  );
  assert.equal(
    hex(flynnTx.encrypt(sample)),
    hex(museTx.encrypt(sample)),
    "framing and nonce endianness never touch the transport keys"
  );
  assert.equal(
    flynnTx.encryptPrefixed(sample).length,
    museTx.encrypt(sample).length + 2,
    "the prefixed frame adds 2 bytes the muse frame omits"
  );
});

test("N4 muse profile: sizes, shared handshake cipher, big-endian nonce", () => {
  assert.equal(hex(noise.nonceBytes(0, "be")), "000000000000000000000000");
  assert.equal(hex(noise.nonceBytes(1, "be")), "000000000000000000000001");
  assert.equal(hex(noise.nonceBytes(256, "be")), "000000000000000000000100");
  assert.equal(hex(noise.nonceBytes(1, "le")), "000000000100000000000000");

  const init = new noise.HandshakeXX({ profile: "muse", role: "initiator" });
  const nonce32 = hx("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
  const msg1 = init.write(Buffer.concat([hx("0a20"), nonce32]));
  assert.equal(msg1.length, 66, "muse msg1 = e(32) + cleartext 0a20<nonce32>");
  assert.equal(hex(msg1.subarray(32)), "0a20" + hex(nonce32), "the client nonce stays in the clear in msg1");

  const resp = new noise.HandshakeXX({ profile: "muse", role: "responder" });
  resp.read(msg1);
  const msg2 = resp.write(hx("deadbeef"));
  assert.equal(msg2.length, 32 + 48 + 4 + 16, "muse msg2 = e + Enc(s) + Enc(payload), no length prefixes");
  assert.equal(hex(init.read(msg2)), "deadbeef", "msg2 payload round-trips without a length prefix");
  assert.equal(init.cs.n, 1, "reading msg2 advanced the shared handshake cipher");
  const msg3 = init.write();
  assert.equal(msg3.length, 48 + 16, "muse msg3 = Enc(s)(48) + Enc(empty)(16)");
  assert.equal(resp.read(msg3).length, 0);

  const client = init.split();
  const server = resp.split();
  assert.equal(hex(server.decrypt(client.encrypt(Buffer.from("hello")))), hex(Buffer.from("hello")));
  assert.equal(hex(client.decrypt(server.encrypt(Buffer.from("world")))), hex(Buffer.from("world")));
  assert.equal(client.encrypt(Buffer.alloc(1, 7)).length, 17, "no length prefix on a muse transport frame");
  assert.equal(hex(client.remoteStatic), hex(resp.localStatic.publicRaw), "client learned the server static key");
});

test("N5 tampered and truncated frames raise instead of returning garbage", () => {
  const { init, resp } = runHandshake(V[XX_KEYS[0]], "muse");
  const tx = init.split();
  const rx = resp.split();
  const good = tx.encrypt(Buffer.from("hello muse"));

  assert.throws(() => rx.decrypt(good.subarray(0, good.length - 1)), noise.NoiseError, "truncated frame");
  const flipped = Buffer.from(good);
  flipped[0] ^= 0x01;
  assert.throws(() => rx.decrypt(flipped), noise.NoiseError, "flipped ciphertext bit");
  const tagFlipped = Buffer.from(good);
  tagFlipped[tagFlipped.length - 1] ^= 0x80;
  assert.throws(() => rx.decrypt(tagFlipped), noise.NoiseError, "flipped tag byte");
  assert.equal(hex(rx.decrypt(good)), hex(Buffer.from("hello muse")), "the good frame still opens after failures");

  const responder = new noise.HandshakeXX({ profile: "muse", role: "responder" });
  assert.throws(() => responder.read(Buffer.alloc(31)), noise.NoiseError, "msg1 shorter than a public key");
  const waiting = new noise.HandshakeXX({ profile: "muse", role: "initiator" });
  waiting.write();
  assert.throws(() => waiting.read(Buffer.alloc(70)), noise.NoiseError, "msg2 shorter than e + Enc(s)");
  assert.throws(() => tx.decrypt(Buffer.alloc(4)), noise.NoiseError, "frame shorter than a tag");
  assert.throws(
    () => new noise.HandshakeXX({ profile: "muse", role: "initiator", staticKey: Buffer.alloc(31) }),
    noise.NoiseError,
    "a 31-byte static key is rejected at construction"
  );
});

test("N6 ordering is enforced and raw X25519 plumbing round-trips", () => {
  const init = new noise.HandshakeXX({ profile: "muse", role: "initiator" });
  const resp = new noise.HandshakeXX({ profile: "muse", role: "responder" });
  assert.throws(() => init.read(Buffer.alloc(96)), noise.NoiseError, "initiator cannot read its own message");
  assert.throws(() => resp.write(), noise.NoiseError, "responder cannot write before msg1 arrives");
  assert.throws(() => init.split(), noise.NoiseError, "split before the handshake is done");
  resp.read(init.write());
  resp.write();
  assert.throws(() => init.split(), noise.NoiseError, "split before msg3 is read");
  const whole = runHandshake(V[XX_KEYS[0]], "muse");
  assert.throws(() => whole.init.write(), noise.NoiseError, "handshake already complete");
  assert.throws(() => whole.resp.read(Buffer.alloc(64)), noise.NoiseError, "no messages left to read");

  const k = noise.generateKeyPair();
  assert.equal(k.publicRaw.length, 32);
  const other = noise.generateKeyPair();
  assert.equal(hex(noise.dh(k.private, other.publicRaw)), hex(noise.dh(other.private, k.publicRaw)), "DH agrees");
  assert.equal(hex(noise.rawFromPublic(noise.pubFromRaw(k.publicRaw))), hex(k.publicRaw), "raw -> DER -> raw");
  assert.throws(() => noise.pubFromRaw(Buffer.alloc(31)), noise.NoiseError, "a 31-byte public key is rejected");
  assert.throws(() => noise.dh(k.private, Buffer.alloc(32)), noise.NoiseError, "a low-order point is a protocol error");
  assert.throws(() => new noise.HandshakeXX({ profile: "nope", role: "initiator" }), noise.NoiseError, "unknown profile");
});

let failed = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`ok   ${c.name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${c.name}\n     ${String(err.message).split("\n").join("\n     ")}`);
    if (process.env.NOISE_STACK) console.log(err.stack);
  }
}
console.log(failed ? `${failed}/${cases.length} FAILED` : `all ${cases.length} noise cases passed`);
process.exit(failed ? 1 : 0);
