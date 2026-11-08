// Minimal proto3 codec for the muse.ai tunnel: varint / length-delimited only,
// no schema, no descriptors, no reflection. Field numbers and wire types come
// from protocol-notes.md §B1 + Appendix 1.
//
// Rules that the gateway's own decoder expects (and that a generic protobuf
// library would happily get wrong):
//   · no zigzag anywhere — negatives are 10-byte two's-complement varints
//   · default-valued scalars are still emitted where the reference client emits
//     them (see wire.cjs), so encoding is decided by the caller, not by proto3
//     "skip defaults" behaviour
//   · length prefixes are varints, so a 170-byte payload starts 0xaa 0x01

"use strict";

class PbError extends Error {
  constructor(message) {
    super(message);
    this.name = "PbError";
  }
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

function writeVarint(out, value) {
  let v = BigInt(value);
  if (v < 0n) v += 1n << 64n; // two's complement, as proto3 int64 does
  if (v >= 1n << 64n) throw new PbError(`varint out of range: ${value}`);
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v === 0n ? byte : byte | 0x80);
    if (v === 0n) return;
  }
}

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let at = offset;
  while (at < buf.length) {
    const byte = buf[at];
    result |= BigInt(byte & 0x7f) << shift;
    at += 1;
    if ((byte & 0x80) === 0) return { value: result, next: at };
    shift += 7n;
    if (shift > 63n) throw new PbError("varint longer than 64 bits");
  }
  throw new PbError("truncated varint");
}

const tag = (fieldNo, wireType) => {
  const out = [];
  writeVarint(out, (fieldNo << 3) | wireType);
  return out;
};

const fieldVarint = (fieldNo, value) => {
  const out = tag(fieldNo, WIRE_VARINT);
  writeVarint(out, value);
  return Buffer.from(out);
};

const fieldBytes = (fieldNo, bytes) => {
  const body = Buffer.from(bytes || []);
  const out = [];
  writeVarint(out, (fieldNo << 3) | WIRE_LEN);
  writeVarint(out, body.length);
  return Buffer.concat([Buffer.from(out), body]);
};

const fieldString = (fieldNo, text) => fieldBytes(fieldNo, Buffer.from(String(text ?? ""), "utf8"));

const fieldBool = (fieldNo, value) => fieldVarint(fieldNo, value ? 1 : 0);

function signed64(value) {
  const v = BigInt(value);
  return v & (1n << 63n) ? v - (1n << 64n) : v;
}

// Decode one message into { fieldNo: [values] }. Unknown fields are kept, because
// the gateway adds fields the reference clients never look at.
function decode(buf) {
  const fields = new Map();
  let at = 0;
  const view = Buffer.from(buf);
  while (at < view.length) {
    const head = readVarint(view, at);
    at = head.next;
    const key = Number(head.value);
    const fieldNo = key >> 3;
    const wireType = key & 0b111;
    let value;
    if (wireType === WIRE_VARINT) {
      const v = readVarint(view, at);
      at = v.next;
      value = v.value;
    } else if (wireType === WIRE_LEN) {
      const l = readVarint(view, at);
      at = l.next;
      const len = Number(l.value);
      if (at + len > view.length) throw new PbError("length-delimited field runs past the message");
      value = view.subarray(at, at + len);
      at += len;
    } else if (wireType === WIRE_FIXED64) {
      if (at + 8 > view.length) throw new PbError("fixed64 field truncated");
      value = view.readBigUInt64LE(at);
      at += 8;
    } else if (wireType === WIRE_FIXED32) {
      if (at + 4 > view.length) throw new PbError("fixed32 field truncated");
      value = view.readUInt32LE(at);
      at += 4;
    } else {
      throw new PbError(`unsupported wire type ${wireType} (field ${fieldNo})`);
    }
    const bucket = fields.get(fieldNo);
    if (bucket) bucket.push({ wireType, value });
    else fields.set(fieldNo, [{ wireType, value }]);
  }
  return fields;
}

const one = (fields, fieldNo) => {
  const list = fields.get(fieldNo);
  return list && list.length ? list[list.length - 1].value : undefined;
};

const many = (fields, fieldNo) => (fields.get(fieldNo) || []).map((entry) => entry.value);

const asText = (value) => (value === undefined ? "" : Buffer.from(value).toString("utf8"));
const asNum = (value) => (value === undefined ? undefined : Number(signed64(value)));
const asBool = (value) => value !== undefined && BigInt(value) !== 0n;

module.exports = {
  PbError,
  WIRE_VARINT,
  WIRE_LEN,
  writeVarint,
  readVarint,
  fieldVarint,
  fieldBytes,
  fieldString,
  fieldBool,
  signed64,
  decode,
  one,
  many,
  asText,
  asNum,
  asBool,
};
