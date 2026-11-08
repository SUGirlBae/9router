// HatchConnection: one Noise-protected WebSocket to a muse.ai agent VM, speaking
// the HTTP-over-Noise RPC layer of protocol-notes.md §B/§C.
//
// The transport is injectable so the handshake, framing and stream handling run
// in-process against a fake peer (muse/fake-tunnel.cjs) with no socket; the real
// path uses the global WebSocket that Node 24 provides.

"use strict";

const crypto = require("node:crypto");
const noise = require("./noise.cjs");
const wire = require("./wire.cjs");

const EMPTY = Buffer.alloc(0);

class GatewayError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "GatewayError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

function kindForStatus(status, bodyText) {
  const text = bodyText || "";
  if (status === 401) return "auth";
  if (status === 403) return /not.*allow|entitle|permission/i.test(text) ? "policy" : "access";
  if (status === 429) return "quota";
  if (status === 503) return "region";
  if (status >= 500) return "upstream";
  return "policy";
}

// A single inbound frame queue per stream, with a bounded wait.
class FrameQueue {
  constructor() {
    this.items = [];
    this.waiting = null;
  }

  push(item) {
    if (this.waiting) {
      const take = this.waiting;
      this.waiting = null;
      take(item);
      return;
    }
    this.items.push(item);
  }

  next(timeoutMs, onTimeoutMessage) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new GatewayError("timeout", onTimeoutMessage));
      }, timeoutMs);
      this.waiting = (item) => {
        clearTimeout(timer);
        resolve(item);
      };
    });
  }

  fail(err) {
    this.push({ kind: "closed", error: err });
  }
}

// Node 24 ships a global WebSocket (undici). Every frame is binary.
function websocketTransport(url, { signal } = {}) {
  const WS = globalThis.WebSocket;
  if (typeof WS !== "function") throw new GatewayError("upstream", "this Node has no global WebSocket");
  const socket = new WS(url);
  socket.binaryType = "arraybuffer";
  const handlers = { message: null, close: null };
  const opened = new Promise((resolve, reject) => {
    const bail = (why) => reject(new GatewayError("upstream", why));
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => bail("error while opening the tunnel"), { once: true });
    socket.addEventListener("close", (ev) => bail(`websocket closed before it opened (code ${ev.code})`), { once: true });
    if (signal) {
      if (signal.aborted) socket.close();
      else signal.addEventListener("abort", () => socket.close(), { once: true });
    }
  });
  return {
    opened,
    send(bytes) {
      socket.send(bytes);
    },
    close() {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    },
    onMessage(cb) {
      handlers.message = cb;
      socket.addEventListener("message", (ev) => handlers.message(Buffer.from(ev.data)));
    },
    onClose(cb) {
      handlers.close = cb;
      socket.addEventListener("close", (ev) => handlers.close(ev.code, ev.reason));
    },
  };
}

class HatchConnection {
  constructor(opts = {}) {
    this.url = opts.url;
    this.profile = opts.profile || "muse";
    this.log = opts.log || (() => {});
    this.signal = opts.signal || null;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 25000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60000;
    this.locale = opts.locale || "en-US";
    this.transport = opts.transport || null;
    this.handshake = new noise.HandshakeXX({ profile: this.profile, role: "initiator" });
    this.cipher = null;
    this.reassembler = new wire.NoiseReassembler();
    this.nextStreamId = 1;
    this.pending = new Map();
    this.closeError = null;
    this.onEvent = opts.onEvent || null;
    this.clientNonce = crypto.randomBytes(32);
    this.frames = new FrameQueue();
  }

  get connected() {
    return Boolean(this.cipher) && !this.closeError;
  }

  async connect() {
    const transport = this.transport || websocketTransport(this.url, { signal: this.signal });
    this.transport = transport;
    transport.onMessage((frame) => this._onFrame(frame));
    transport.onClose((code, reason) => this._onClose(code, reason));
    if (this.signal) {
      const abort = () => this.close(new GatewayError("timeout", "aborted by caller"));
      if (this.signal.aborted) abort();
      else this.signal.addEventListener("abort", abort, { once: true });
    }
    await withTimeout(transport.opened, this.connectTimeoutMs, "websocket open");

    // -> e, cleartext protobuf field 1 = 32 random bytes
    transport.send(this.handshake.write(Buffer.concat([Buffer.from("0a20", "hex"), this.clientNonce])));
    const msg2 = await this.frames.next(this.connectTimeoutMs, "timed out waiting for Noise handshake message 2");
    const attestation = this.handshake.read(msg2);
    transport.send(this.handshake.write(EMPTY));
    this.cipher = this.handshake.split();
    this.log("noise connected", {
      serverStatic: hex(this.cipher.remoteStatic).slice(0, 16),
      attestationBytes: attestation.length,
    });
    return { remoteStatic: this.cipher.remoteStatic, attestation };
  }

  _onFrame(frame) {
    if (!this.cipher) return this.frames.push(frame);
    let plaintext;
    try {
      plaintext = this.cipher.decrypt(frame);
    } catch (err) {
      this.log("noise frame rejected", err.message);
      return;
    }
    let envelope;
    try {
      envelope = this.reassembler.feed(plaintext);
    } catch (err) {
      this.log("chunk assembly failed", err.message);
      return;
    }
    if (!envelope) return;
    let dispatched;
    try {
      dispatched = this._decodeServiceFrame(wire.decodeServiceFrame(wire.decodeServiceResponse(envelope)));
    } catch (err) {
      this.log("inbound frame undecodable", err.message);
      return;
    }
    const waiter = this.pending.get(dispatched.streamId);
    if (waiter) waiter.push(dispatched);
    else if (this.onEvent) this.onEvent(dispatched);
  }

  _decodeServiceFrame(serviceFrame) {
    const { streamId, kind } = serviceFrame;
    if (kind === "response") return { streamId, kind, ...wire.decodeApplicationResponse(serviceFrame.payload) };
    if (kind === "body_chunk") {
      const chunk = wire.decodeBodyChunk(serviceFrame.payload);
      return { streamId, kind, data: chunk.data, endBody: chunk.endBody, status: 200, headers: [] };
    }
    if (kind === "reset") return { streamId, kind, ...wire.decodeReset(serviceFrame.payload) };
    return { streamId, kind, body: serviceFrame.payload };
  }

  _onClose(code, reason) {
    const err = new GatewayError(
      "upstream",
      `tunnel closed (code ${code}${reason ? ": " + reason : ""})`,
      { tunnelCode: code, tunnelReason: reason }
    );
    this.close(err);
  }

  _checkOpen() {
    if (this.closeError) throw this.closeError;
    if (!this.cipher) throw new GatewayError("upstream", "connection is not open");
  }

  _sendRequest({ method, path, body, service, headers, streamId, endBody }) {
    const request = wire.encodeApplicationRequest({
      verb: method,
      path,
      headers: headers || wire.requestHeaders({ requestId: crypto.randomUUID(), locale: this.locale, method }),
      body,
      endBody,
    });
    const serviceId = typeof service === "number" ? service : wire.SERVICES[service] ?? wire.SERVICES.daemon;
    const envelope = wire.encodeServiceRequest(serviceId, wire.encodeServiceFrame(streamId, "request", request));
    for (const chunk of wire.splitNoisePayload(envelope)) this.transport.send(this.cipher.encrypt(chunk));
  }

  // One request, one response. onRecord receives each NDJSON record as it
  // arrives, so a long turn streams instead of resolving at the very end.
  async request(opts) {
    this._checkOpen();
    const method = (opts.method || "POST").toUpperCase();
    const body = normaliseBody(opts.body);
    const streamId = this.nextStreamId++;
    const queue = new FrameQueue();
    this.pending.set(streamId, queue);
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const collected = [];
    let emittedLength = 0;
    let response = null;

    const takeRecord = (bytes) => {
      collected.push(bytes || EMPTY);
      if (!opts.onRecord) return;
      const text = Buffer.concat(collected).toString("utf8");
      const complete = text.slice(0, text.lastIndexOf("\n") + 1);
      if (complete.length <= emittedLength) return;
      const fresh = complete.slice(emittedLength);
      emittedLength = complete.length;
      for (const line of fresh.split("\n")) {
        if (!line.trim()) continue;
        try {
          opts.onRecord(JSON.parse(line));
        } catch {
          this.log("record is not JSON", line.slice(0, 120));
        }
      }
    };

    try {
      this._sendRequest({
        method,
        path: opts.path,
        body,
        service: opts.service,
        headers: opts.headers,
        streamId,
        endBody: opts.endBody ?? true,
      });
      for (;;) {
        const message = await queue.next(Math.max(50, deadline - Date.now()), `no reply to ${method} ${opts.path} within ${timeoutMs}ms`);
        if (message.kind === "closed") throw message.error;
        if (message.kind === "reset") {
          if (response && !opts.requireEnd) break;
          throw new GatewayError("upstream", `stream ${streamId} reset: ${message.reason || "no reason"}`, {
            code: message.code,
            streamId,
          });
        }
        if (message.kind === "response") {
          response = message;
          takeRecord(message.body || EMPTY);
          if (message.endBody) break;
          continue;
        }
        if (message.kind === "body_chunk") {
          takeRecord(message.data || EMPTY);
          if (message.endBody) break;
        }
      }
      // A tail with no trailing newline is still a record.
      if (opts.onRecord) {
        const text = Buffer.concat(collected).toString("utf8");
        const tail = text.slice(emittedLength).trim();
        if (tail) {
          try {
            opts.onRecord(JSON.parse(tail));
          } catch {
            this.log("trailing record is not JSON", tail.slice(0, 120));
          }
        }
      }
      const combined = Buffer.concat(collected.length ? collected : [response && response.body ? response.body : EMPTY]);
      if (response && response.status >= 400) {
        const text = combined.toString("utf8").slice(0, 400);
        throw new GatewayError(kindForStatus(response.status, text), `${method} ${opts.path} -> ${response.status} ${text}`, {
          status: response.status,
          body: text,
          streamId,
        });
      }
      return {
        status: response ? response.status : 200,
        headers: response ? response.headers : [],
        body: combined,
        text: () => combined.toString("utf8"),
        json: () => JSON.parse(combined.toString("utf8") || "null"),
      };
    } finally {
      this.pending.delete(streamId);
    }
  }

  // Send and wait briefly, ignoring the timeout: /chat/stream is an
  // acknowledgement endpoint and some server revisions keep it open past the
  // generation itself (protocol-notes.md §C2).
  async ack(opts) {
    try {
      return await this.request(opts);
    } catch (err) {
      if (err instanceof GatewayError && err.kind === "timeout") return null;
      throw err;
    }
  }

  sendReset(streamId, code = 1, reason = "client aborted") {
    if (!this.connected) return;
    const envelope = wire.encodeServiceRequest(
      wire.SERVICES.daemon,
      wire.encodeServiceFrame(streamId, "reset", wire.encodeReset(code, reason))
    );
    for (const chunk of wire.splitNoisePayload(envelope)) this.transport.send(this.cipher.encrypt(chunk));
  }

  close(err) {
    if (this.closeError) return;
    this.closeError = err || new GatewayError("upstream", "connection closed by caller");
    try {
      this.transport && this.transport.close();
    } catch {
      /* already closed */
    }
    for (const [, queue] of this.pending) queue.fail(this.closeError);
    this.pending.clear();
    this.frames.push({ kind: "closed", error: this.closeError });
  }
}

function normaliseBody(body) {
  if (body === undefined || body === null) return EMPTY;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(JSON.stringify(body), "utf8");
}

function hex(buf) {
  return Buffer.from(buf || EMPTY).toString("hex");
}

function withTimeout(promise, ms, what) {
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new GatewayError("timeout", `timed out during ${what}`)), ms);
    promise.then(resolve, reject);
  }).finally(() => clearTimeout(timer));
}

module.exports = { HatchConnection, GatewayError, FrameQueue, websocketTransport, kindForStatus, withTimeout };
