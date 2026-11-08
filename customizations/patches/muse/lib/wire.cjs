// The muse.ai tunnel's RPC layer, above Noise: protobuf envelopes, chunk
// reassembly, and the HTTP-over-Noise request/response shapes.
// Schema, field numbers and emit-ordering rules: protocol-notes.md §B.

"use strict";

const crypto = require("node:crypto");
const pb = require("./pb.cjs");

const SERVICES = { daemon: 0, sentinel: 1, vault: 2, authd: 3 };
const APP_ID = "hatch-web";

// Outbound fragments: 65536 - 47, the value the browser uses. Inbound single
// chunks may be much larger (the gateway sends approval snapshots whole), so the
// inbound cap is deliberately looser than the outbound split.
const MAX_CHUNK_PAYLOAD = 65489;
const MAX_INBOUND_CHUNK = 4 * 1024 * 1024;
const MAX_CHUNKS = 256;
const MAX_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_ASSEMBLIES = 32;

const concat = (parts) => Buffer.concat(parts.filter((p) => p && p.length));

function encodeHeader(key, value) {
  return concat([pb.fieldString(1, key), pb.fieldString(2, value)]);
}

function decodeHeaders(fields) {
  return pb.many(fields, 3).map((bytes) => {
    const inner = pb.decode(bytes);
    return { key: pb.asText(pb.one(inner, 1)), value: pb.asText(pb.one(inner, 2)) };
  });
}

// ApplicationRequest: body is omitted when empty, end_body is ALWAYS emitted
// (even false) because the reference client emits it and the gateway's parser
// reads ordering-tolerant protobuf anyway — keep byte-compatibility.
function encodeApplicationRequest({ verb, path, headers = [], body, endBody = true }) {
  const parts = [pb.fieldString(1, verb.toUpperCase()), pb.fieldString(2, path)];
  for (const [key, value] of headers) parts.push(pb.fieldBytes(3, encodeHeader(key, value)));
  if (body && body.length) parts.push(pb.fieldBytes(4, body));
  parts.push(pb.fieldBool(5, endBody));
  return concat(parts);
}

function decodeApplicationRequest(bytes) {
  const fields = pb.decode(bytes);
  const body = pb.one(fields, 4);
  return {
    verb: pb.asText(pb.one(fields, 1)),
    path: pb.asText(pb.one(fields, 2)),
    headers: decodeHeaders(fields),
    body: body ? Buffer.from(body) : Buffer.alloc(0),
    endBody: pb.asBool(pb.one(fields, 5)),
  };
}

function encodeApplicationResponse({ status, headers = [], body, endBody = true }) {
  const parts = [pb.fieldVarint(1, status)];
  for (const [key, value] of headers) parts.push(pb.fieldBytes(2, encodeHeader(key, value)));
  if (body && body.length) parts.push(pb.fieldBytes(3, body));
  parts.push(pb.fieldBool(4, endBody));
  return concat(parts);
}

function decodeApplicationResponse(bytes) {
  const fields = pb.decode(bytes);
  const body = pb.one(fields, 3);
  return {
    status: pb.asNum(pb.one(fields, 1)) ?? 0,
    headers: pb.many(fields, 2).map((inner) => {
      const f = pb.decode(inner);
      return { key: pb.asText(pb.one(f, 1)), value: pb.asText(pb.one(f, 2)) };
    }),
    body: body ? Buffer.from(body) : Buffer.alloc(0),
    endBody: pb.asBool(pb.one(fields, 4)),
  };
}

const encodeBodyChunk = (data, endBody) =>
  concat([pb.fieldBytes(1, data || Buffer.alloc(0)), pb.fieldBool(2, endBody)]);

function decodeBodyChunk(bytes) {
  const fields = pb.decode(bytes);
  const data = pb.one(fields, 1);
  return { data: data ? Buffer.from(data) : Buffer.alloc(0), endBody: pb.asBool(pb.one(fields, 2)) };
}

const encodeReset = (code = 1, reason = "") =>
  concat([pb.fieldVarint(1, code), reason ? pb.fieldString(2, reason) : Buffer.alloc(0)]);

function decodeReset(bytes) {
  const fields = pb.decode(bytes);
  return { code: pb.asNum(pb.one(fields, 1)) ?? 0, reason: pb.asText(pb.one(fields, 2)) };
}

// ServiceFrame: stream_id plus exactly one of request/response/body_chunk/reset.
function encodeServiceFrame(streamId, kind, payload) {
  const field = { request: 2, response: 3, body_chunk: 4, reset: 5 }[kind];
  if (!field) throw new Error(`unknown ServiceFrame kind "${kind}"`);
  return concat([pb.fieldVarint(1, streamId), pb.fieldBytes(field, payload)]);
}

function decodeServiceFrame(bytes) {
  const fields = pb.decode(bytes);
  const streamId = pb.asNum(pb.one(fields, 1)) ?? 0;
  if (fields.has(2)) return { streamId, kind: "request", payload: Buffer.from(pb.one(fields, 2)) };
  if (fields.has(3)) return { streamId, kind: "response", payload: Buffer.from(pb.one(fields, 3)) };
  if (fields.has(4)) return { streamId, kind: "body_chunk", payload: Buffer.from(pb.one(fields, 4)) };
  if (fields.has(5)) return { streamId, kind: "reset", payload: Buffer.from(pb.one(fields, 5)) };
  return { streamId, kind: "unknown", payload: Buffer.alloc(0) };
}

// ServiceRequest always emits field 1, even for service 0 (daemon).
const encodeServiceRequest = (service, frameBytes) =>
  concat([pb.fieldVarint(1, service), pb.fieldBytes(2, frameBytes)]);

function decodeServiceRequest(bytes) {
  const fields = pb.decode(bytes);
  return {
    service: pb.asNum(pb.one(fields, 1)) ?? 0,
    payload: fields.has(2) ? Buffer.from(pb.one(fields, 2)) : Buffer.alloc(0),
  };
}

// Every inbound message arrives inside a ServiceResponse envelope.
const encodeServiceResponse = (frameBytes) => pb.fieldBytes(1, frameBytes);

function decodeServiceResponse(bytes) {
  const fields = pb.decode(bytes);
  const payload = pb.one(fields, 1);
  if (!payload) throw new pb.PbError("ServiceResponse has no payload field");
  return Buffer.from(payload);
}

const randomChunkId = () => crypto.randomBytes(8).readBigInt64LE();

// One logical envelope -> one or more NoiseTransportFrame messages. An empty
// envelope still produces exactly one chunk (total 1, index 0, payload empty).
// chunkId is injectable so a retry can reuse an id and tests stay deterministic.
function splitNoisePayload(envelope, options = {}) {
  const size = Math.max(1, Math.min(options.chunkSize || MAX_CHUNK_PAYLOAD, MAX_CHUNK_PAYLOAD));
  const body = Buffer.from(envelope);
  const total = Math.max(1, Math.ceil(body.length / size));
  if (total > MAX_CHUNKS) {
    throw new Error(`payload needs ${total} chunks, the tunnel allows ${MAX_CHUNKS}`);
  }
  const chunkId = options.chunkId === undefined ? randomChunkId() : options.chunkId;
  const out = [];
  for (let index = 0; index < total; index += 1) {
    const slice = body.subarray(index * size, Math.min(body.length, (index + 1) * size));
    out.push(
      concat([
        pb.fieldVarint(1, chunkId),
        pb.fieldVarint(2, index),
        pb.fieldVarint(3, total),
        pb.fieldBytes(4, slice),
      ])
    );
  }
  return out;
}

function decodeNoiseTransportFrame(bytes) {
  const fields = pb.decode(bytes);
  const payload = pb.one(fields, 4);
  return {
    chunkId: pb.one(fields, 1),
    index: pb.asNum(pb.one(fields, 2)) ?? 0,
    total: pb.asNum(pb.one(fields, 3)) ?? 1,
    payload: payload ? Buffer.from(payload) : Buffer.alloc(0),
  };
}

// Fragments of one logical message are keyed by chunk_id and may interleave with
// other messages' fragments, so keep a map, not a single buffer.
class NoiseReassembler {
  constructor({ maxAssemblyBytes = MAX_ASSEMBLY_BYTES, maxPending = MAX_PENDING_ASSEMBLIES } = {}) {
    this.pending = new Map();
    this.maxAssemblyBytes = maxAssemblyBytes;
    this.maxPending = maxPending;
  }

  feed(frameBytes) {
    const frame = decodeNoiseTransportFrame(frameBytes);
    if (frame.payload.length > MAX_INBOUND_CHUNK) {
      throw new Error(`inbound chunk of ${frame.payload.length} bytes exceeds ${MAX_INBOUND_CHUNK}`);
    }
    const key = String(frame.chunkId);
    let entry = this.pending.get(key);
    if (!entry) {
      if (this.pending.size >= this.maxPending) {
        // Oldest-first eviction: a stalled stream must not wedge the connection.
        const oldest = this.pending.keys().next().value;
        this.pending.delete(oldest);
      }
      entry = { total: frame.total, parts: new Map(), bytes: 0 };
      this.pending.set(key, entry);
    }
    if (frame.index >= MAX_CHUNKS) throw new Error(`chunk index ${frame.index} out of range`);
    if (!entry.parts.has(frame.index)) {
      entry.bytes += frame.payload.length;
      if (entry.bytes > this.maxAssemblyBytes) {
        this.pending.delete(key);
        throw new Error(`assembly for ${key} exceeds ${this.maxAssemblyBytes} bytes`);
      }
      entry.parts.set(frame.index, frame.payload);
    }
    if (entry.parts.size < entry.total) return null;
    const ordered = [];
    for (let i = 0; i < entry.total; i += 1) {
      const part = entry.parts.get(i);
      if (!part) throw new Error(`assembly for ${key} is missing chunk ${i}`);
      ordered.push(part);
    }
    this.pending.delete(key);
    return Buffer.concat(ordered);
  }

  get pendingCount() {
    return this.pending.size;
  }
}

// Default headers on every request, in the reference client's order.
function requestHeaders({ requestId, locale = "en-US", method, extra = [] }) {
  const headers = [];
  if (method !== "GET" && method !== "DELETE") headers.push(["Content-Type", "application/json"]);
  headers.push(["x-request-id", requestId]);
  headers.push(["x-app-id", APP_ID]);
  headers.push(["Accept-Language", locale]);
  for (const pair of extra) headers.push(pair);
  return headers;
}

module.exports = {
  SERVICES,
  APP_ID,
  MAX_CHUNK_PAYLOAD,
  MAX_INBOUND_CHUNK,
  MAX_CHUNKS,
  MAX_ASSEMBLY_BYTES,
  encodeApplicationRequest,
  decodeApplicationRequest,
  encodeApplicationResponse,
  decodeApplicationResponse,
  encodeBodyChunk,
  decodeBodyChunk,
  encodeReset,
  decodeReset,
  encodeServiceFrame,
  decodeServiceFrame,
  encodeServiceRequest,
  decodeServiceRequest,
  encodeServiceResponse,
  decodeServiceResponse,
  splitNoisePayload,
  decodeNoiseTransportFrame,
  NoiseReassembler,
  requestHeaders,
  randomChunkId,
};
