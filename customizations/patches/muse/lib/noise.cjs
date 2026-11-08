// Noise_XX_25519_AESGCM_SHA256 with node:crypto only, in two profiles.
//
//   flynn — the shape validated byte-for-byte against the public
//           flynn/noise XX_25519_AESGCM_SHA256 vectors (see test-noise.js).
//           2-byte handshake length prefixes, little-endian transport nonce.
//   muse  — what the muse.ai ("hatch") gateway speaks, copied from the two
//           independent browserless clients in protocol-notes.md §A:
//             · handshake tokens and payloads carry NO 2-byte length prefix
//             · transport nonce = 4 zero bytes || u64 BIG-endian
//           Everything else is shared with `flynn`, and that shared core is what
//           the vectors prove: MixHash touches h only, an empty payload is still
//           hashed, one CipherState serves both directions during the handshake
//           (so msg3 encrypts at nonce 1, not 0), and Split() is
//           HKDF(ck, "", 2) with tx = T1, rx = T2.
//           Transport frames add no prefix either: one WebSocket binary frame is
//           one Noise message, AAD is empty, the tag is appended.
//
// XX pattern:  -> e   /   <- e, ee, s, es   /   -> s, se
// muse msg sizes: 66 (e + cleartext 0a20<nonce32>) / 96 + payload / 64.

"use strict";

const crypto = require("node:crypto");

const DH_LEN = 32;
const TAG_LEN = 16;
const HASH_LEN = 32;
const MAX_PLAINTEXT = 65535 - TAG_LEN;
const PROTOCOL_NAME = "Noise_XX_25519_AESGCM_SHA256";

const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

const PROFILES = {
  // flynn/noise keeps a separate CipherState per direction through the
  // handshake, so its msg3 encrypts at nonce 0. Reproduced here because those
  // vectors are the only byte-exact external check available offline.
  flynn: { handshakeLengthPrefix: true, transportNonceEndianness: "le", sharedHandshakeCipher: false },
  // The hatch client shares one CipherState, which is what the spec text says:
  // reading msg2 advances the counter, so msg3 encrypts at nonce 1.
  muse: { handshakeLengthPrefix: false, transportNonceEndianness: "be", sharedHandshakeCipher: true },
};

class NoiseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "NoiseError";
    if (cause) this.cause = cause;
  }
}

function toRaw(value, what) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") {
    if (/^[0-9a-fA-F]+$/.test(value) && value.length === DH_LEN * 2) return Buffer.from(value, "hex");
    return Buffer.from(value, "utf8");
  }
  if (value && typeof value === "object") {
    if (Buffer.isBuffer(value.publicRaw)) return value.publicRaw;
    if (Buffer.isBuffer(value.raw)) return value.raw;
  }
  throw new NoiseError(`cannot read a 32-byte key from ${what}`);
}

function pubFromRaw(raw) {
  const buf = toRaw(raw, "public key");
  if (buf.length !== DH_LEN) throw new NoiseError(`bad X25519 public key length ${buf.length}`);
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_X25519, buf]),
    format: "der",
    type: "spki",
  });
}

function privFromRaw(raw) {
  const buf = toRaw(raw, "private key");
  if (buf.length !== DH_LEN) throw new NoiseError(`bad X25519 private key length ${buf.length}`);
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, buf]),
    format: "der",
    type: "pkcs8",
  });
}

function rawFromPublic(keyObject) {
  const der = keyObject.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - DH_LEN));
}

function generateKeyPair() {
  const pair = crypto.generateKeyPairSync("x25519");
  return { private: pair.privateKey, publicRaw: rawFromPublic(pair.publicKey) };
}

function pairFromPrivate(privateKey) {
  return { private: privateKey, publicRaw: rawFromPublic(crypto.createPublicKey(privateKey)) };
}

function dh(privateKey, peerPublicRaw) {
  const publicRaw = toRaw(peerPublicRaw, "peer public key");
  try {
    return crypto.diffieHellman({ privateKey, publicKey: pubFromRaw(publicRaw) });
  } catch (err) {
    // A low-order or otherwise invalid peer point is a protocol failure, not a
    // crash: the gateway would never send one, so receiving it means tampering.
    throw new NoiseError(`X25519 DH failed: ${err.message}`, err);
  }
}

// Noise HKDF: salt = ck, info = empty, T1||T2(||T3).
function hkdf(chainingKey, inputKeyMaterial, outputs) {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      toRaw(inputKeyMaterial, "IKM"),
      Buffer.from(chainingKey),
      Buffer.alloc(0),
      HASH_LEN * outputs
    )
  );
}

function initHash(protocolName) {
  if (Buffer.byteLength(protocolName, "utf8") > HASH_LEN) {
    return crypto.createHash("sha256").update(protocolName).digest();
  }
  const buf = Buffer.alloc(HASH_LEN);
  Buffer.from(protocolName, "utf8").copy(buf);
  return buf;
}

function nonceBytes(counter, endianness) {
  const bytes = Buffer.alloc(12);
  const lo = counter >>> 0;
  const hi = Math.floor(counter / 0x100000000) >>> 0;
  if (endianness === "be") {
    bytes.writeUInt32BE(hi, 4);
    bytes.writeUInt32BE(lo, 8);
  } else {
    bytes.writeUInt32LE(lo, 4);
    bytes.writeUInt32LE(hi, 8);
  }
  return bytes;
}

class CipherState {
  constructor(key, endianness) {
    this.key = key ? Buffer.from(key) : null;
    this.n = 0;
    this.endianness = endianness;
  }

  hasKey() {
    return this.key !== null;
  }

  encryptWithAd(ad, plaintext) {
    if (!this.hasKey()) return Buffer.from(plaintext);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonceBytes(this.n, this.endianness), {
      authTagLength: TAG_LEN,
    });
    cipher.setAAD(ad);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    this.n += 1;
    return Buffer.concat([ct, cipher.getAuthTag()]);
  }

  decryptWithAd(ad, ciphertext) {
    if (!this.hasKey()) return Buffer.from(ciphertext);
    if (ciphertext.length < TAG_LEN) {
      throw new NoiseError(`frame is ${ciphertext.length} bytes, shorter than a GCM tag`);
    }
    const bodyEnd = ciphertext.length - TAG_LEN;
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, nonceBytes(this.n, this.endianness), {
      authTagLength: TAG_LEN,
    });
    decipher.setAAD(ad);
    decipher.setAuthTag(ciphertext.subarray(bodyEnd));
    const at = this.n;
    try {
      const pt = Buffer.concat([decipher.update(ciphertext.subarray(0, bodyEnd)), decipher.final()]);
      this.n += 1;
      return pt;
    } catch (err) {
      throw new NoiseError(`AEAD open failed at nonce ${at}: frame reordered, truncated, or wrong key`, err);
    }
  }
}

const XX_MESSAGES = [
  { tokens: ["e"], from: "initiator" },
  { tokens: ["e", "ee", "s", "es"], from: "responder" },
  { tokens: ["s", "se"], from: "initiator" },
];

function asKeyPair(material) {
  if (!material) return generateKeyPair();
  if (material.private && material.publicRaw) return material;
  if (typeof material === "string" || Buffer.isBuffer(material)) return pairFromPrivate(privFromRaw(material));
  if (material.private) return pairFromPrivate(material.private);
  throw new NoiseError("unsupported key material");
}

class HandshakeXX {
  constructor(opts = {}) {
    const profile = typeof opts.profile === "string" ? PROFILES[opts.profile] : opts.profile;
    if (opts.profile && !profile) throw new NoiseError(`unknown Noise profile "${opts.profile}"`);
    const p = { ...PROFILES.muse, ...profile };
    this.profile = p;
    this.role = opts.role || "initiator";
    if (this.role !== "initiator" && this.role !== "responder") {
      throw new NoiseError(`unknown role "${this.role}"`);
    }
    this.h = initHash(opts.protocolName || PROTOCOL_NAME);
    this.ck = Buffer.from(this.h);
    this.cs = new CipherState(null, p.transportNonceEndianness);
    this.rs = p.sharedHandshakeCipher ? this.cs : new CipherState(null, p.transportNonceEndianness);
    this.localStatic = asKeyPair(opts.staticKey);
    this.forcedEphemeral = opts.ephemeralKey ? asKeyPair(opts.ephemeralKey) : null;
    this.localEphemeral = null;
    this.remoteStatic = opts.remoteStatic ? toRaw(opts.remoteStatic, "remote static") : null;
    this.remoteEphemeral = null;
    this.index = 0;
    // The prologue is always mixed in, empty included: that is what both the
    // vector generator and the hatch client do.
    this.mixHash(opts.prologue ? Buffer.from(opts.prologue) : Buffer.alloc(0));
  }

  mixHash(data) {
    const buf = Buffer.from(data);
    this.h = crypto.createHash("sha256").update(this.h).update(buf).digest();
  }

  mixKey(ikm) {
    const out = hkdf(this.ck, Buffer.from(ikm), 2);
    this.ck = out.subarray(0, 32);
    const key = out.subarray(32, 64);
    this.cs = new CipherState(key, this.profile.transportNonceEndianness);
    this.rs = this.profile.sharedHandshakeCipher ? this.cs : new CipherState(key, this.profile.transportNonceEndianness);
  }

  encryptAndHash(plaintext) {
    const ct = this.cs.encryptWithAd(this.h, Buffer.from(plaintext));
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext) {
    const pt = this.rs.decryptWithAd(this.h, Buffer.from(ciphertext));
    this.mixHash(ciphertext);
    return pt;
  }

  dhFor(token) {
    const iAmInitiator = this.role === "initiator";
    const e = this.localEphemeral;
    const s = this.localStatic;
    switch (token) {
      case "ee":
        return dh(e.private, this.remoteEphemeral);
      case "es":
        return iAmInitiator ? dh(e.private, this.remoteStatic) : dh(s.private, this.remoteEphemeral);
      case "se":
        return iAmInitiator ? dh(s.private, this.remoteEphemeral) : dh(e.private, this.remoteStatic);
      case "ss":
        return dh(s.private, this.remoteStatic);
      default:
        throw new NoiseError(`unknown handshake token "${token}"`);
    }
  }

  takeToken(message, offset, token) {
    const view = message.subarray(offset);
    if (token === "e") {
      if (view.length < DH_LEN) throw new NoiseError("message is too short for its e token");
      this.remoteEphemeral = Buffer.from(view.subarray(0, DH_LEN));
      this.mixHash(this.remoteEphemeral);
      return DH_LEN;
    }
    if (token === "s") {
      if (!this.rs.hasKey()) {
        if (view.length < DH_LEN) throw new NoiseError("message is too short for its s token");
        this.remoteStatic = Buffer.from(view.subarray(0, DH_LEN));
        this.mixHash(this.remoteStatic);
        return DH_LEN;
      }
      if (this.profile.handshakeLengthPrefix) {
        if (view.length < 2) throw new NoiseError("encrypted s token has no length prefix");
        const len = view.readUInt16BE(0);
        if (view.length < 2 + len) throw new NoiseError("encrypted s token is truncated");
        this.remoteStatic = this.decryptAndHash(view.subarray(2, 2 + len));
        if (this.remoteStatic.length !== DH_LEN) {
          throw new NoiseError(`decrypted static key is ${this.remoteStatic.length} bytes, expected 32`);
        }
        return 2 + len;
      }
      if (view.length < DH_LEN + TAG_LEN) {
        throw new NoiseError("encrypted s token needs 48 bytes, message has fewer");
      }
      this.remoteStatic = this.decryptAndHash(view.subarray(0, DH_LEN + TAG_LEN));
      return DH_LEN + TAG_LEN;
    }
    this.mixKey(this.dhFor(token));
    return 0;
  }

  putToken(out, token) {
    if (token === "e") {
      this.localEphemeral = this.localEphemeral || this.forcedEphemeral || generateKeyPair();
      this.mixHash(this.localEphemeral.publicRaw);
      out.push(this.localEphemeral.publicRaw);
      return;
    }
    if (token === "s") {
      const raw = this.localStatic.publicRaw;
      if (!this.cs.hasKey()) {
        this.mixHash(raw);
        out.push(raw);
        return;
      }
      const ct = this.encryptAndHash(raw);
      if (this.profile.handshakeLengthPrefix) {
        const head = Buffer.alloc(2);
        head.writeUInt16BE(ct.length, 0);
        out.push(head, ct);
      } else {
        out.push(ct);
      }
      return;
    }
    if (token === "ee" && !this.localEphemeral) throw new NoiseError("ee needs an ephemeral key on this side");
    if ((token === "se" || token === "ss") && !this.remoteStatic && !this.remoteEphemeral) {
      throw new NoiseError(`${token} needs the peer's key, which has not arrived yet`);
    }
    this.mixKey(this.dhFor(token));
  }

  read(message) {
    const spec = this.expectTurn("read");
    const buf = Buffer.from(message);
    let offset = 0;
    for (const token of spec.tokens) offset += this.takeToken(buf, offset, token);
    const rest = buf.subarray(offset);
    let payload;
    if (this.rs.hasKey()) {
      if (this.profile.handshakeLengthPrefix) {
        if (rest.length < 2) throw new NoiseError("encrypted handshake payload has no length prefix");
        const len = rest.readUInt16BE(0);
        if (rest.length < 2 + len) throw new NoiseError("encrypted handshake payload is truncated");
        payload = this.decryptAndHash(rest.subarray(2, 2 + len));
      } else {
        payload = this.decryptAndHash(rest);
      }
    } else {
      // No key yet: the payload is cleartext, but it is still mixed into h.
      payload = Buffer.from(rest);
      this.mixHash(payload);
    }
    this.index += 1;
    return payload;
  }

  write(payload) {
    const spec = this.expectTurn("write");
    const plain = payload ? Buffer.from(payload) : Buffer.alloc(0);
    const out = [];
    for (const token of spec.tokens) this.putToken(out, token);
    if (this.cs.hasKey()) {
      const ct = this.encryptAndHash(plain);
      if (this.profile.handshakeLengthPrefix) {
        const head = Buffer.alloc(2);
        head.writeUInt16BE(ct.length, 0);
        out.push(head, ct);
      } else {
        out.push(ct);
      }
    } else {
      if (plain.length) out.push(plain);
      this.mixHash(plain);
    }
    this.index += 1;
    return Buffer.concat(out);
  }

  expectTurn(direction) {
    if (this.index >= XX_MESSAGES.length) throw new NoiseError("handshake already complete");
    const spec = XX_MESSAGES[this.index];
    const mine = (this.role === "initiator") === (spec.from === "initiator");
    if (direction === "write" && !mine) {
      throw new NoiseError(`message ${this.index} is the peer's to send, not mine`);
    }
    if (direction === "read" && mine) {
      throw new NoiseError(`message ${this.index} is mine to send, not the peer's`);
    }
    return spec;
  }

  split() {
    if (this.index !== XX_MESSAGES.length) throw new NoiseError("cannot split before the handshake is done");
    const out = hkdf(this.ck, Buffer.alloc(0), 2);
    const first = new CipherState(out.subarray(0, 32), this.profile.transportNonceEndianness);
    const second = new CipherState(out.subarray(32, 64), this.profile.transportNonceEndianness);
    // Split() hands out (initiator-sends, responder-sends): the responder side
    // must take them in the opposite order or the two peers swap keys.
    return this.role === "initiator"
      ? makeTransport(first, second, this.remoteStatic)
      : makeTransport(second, first, this.remoteStatic);
  }
}

const EMPTY_AD = Buffer.alloc(0);

function makeTransport(cs, rs, remoteStatic) {
  return {
    remoteStatic,
    get sendNonce() {
      return cs.n;
    },
    get recvNonce() {
      return rs.n;
    },
    // One Noise message == one WebSocket binary frame. muse framing: no prefix.
    encrypt(plaintext) {
      return cs.encryptWithAd(EMPTY_AD, Buffer.from(plaintext));
    },
    decrypt(frame) {
      return rs.decryptWithAd(EMPTY_AD, Buffer.from(frame));
    },
    // Spec framing keeps a 2-byte big-endian length in front of ct||tag. The
    // caller owns the read buffer, so decrypt() hands back what it consumed.
    encryptPrefixed(plaintext) {
      const body = Buffer.from(plaintext);
      if (body.length > MAX_PLAINTEXT) {
        throw new RangeError(`transport payload ${body.length} exceeds ${MAX_PLAINTEXT} bytes`);
      }
      const ct = cs.encryptWithAd(EMPTY_AD, body);
      const head = Buffer.alloc(2);
      head.writeUInt16BE(ct.length, 0);
      return Buffer.concat([head, ct]);
    },
    decryptPrefixed(frame) {
      const buf = Buffer.from(frame);
      if (buf.length < 2) throw new NoiseError("transport frame has no length prefix");
      const len = buf.readUInt16BE(0);
      if (buf.length < 2 + len) {
        throw new NoiseError(`transport frame truncated: need ${2 + len}, have ${buf.length}`);
      }
      return { plaintext: rs.decryptWithAd(EMPTY_AD, buf.subarray(2, 2 + len)), consumed: 2 + len };
    },
  };
}

module.exports = {
  PROTOCOL_NAME,
  PROFILES,
  DH_LEN,
  TAG_LEN,
  MAX_PLAINTEXT,
  NoiseError,
  HandshakeXX,
  CipherState,
  makeTransport,
  generateKeyPair,
  pairFromPrivate,
  privFromRaw,
  pubFromRaw,
  rawFromPublic,
  nonceBytes,
  dh,
  hkdf,
  initHash,
  XX_MESSAGES,
};
