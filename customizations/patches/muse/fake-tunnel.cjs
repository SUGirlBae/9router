// An in-process stand-in for the muse.ai agent VM: it speaks the same Noise
// profile and the same protobuf framing as the real tunnel, so the connection
// layer can be tested with no socket and no credentials.
//
// Server-side behaviour mirrors what the reference clients document:
// responder-side XX (so Split() reverses the key order), one binary frame per
// Noise message, NDJSON bodies, BodyChunk continuation and Reset.

"use strict";

const noise = require("./lib/noise.cjs");
const wire = require("./lib/wire.cjs");

class FakeTunnel {
  constructor(opts = {}) {
    this.profile = opts.profile || "muse";
    this.server = new noise.HandshakeXX({ profile: this.profile, role: "responder" });
    this.cipher = null;
    this.reassembler = new wire.NoiseReassembler();
    this.onRequest = opts.onRequest || defaultRequest;
    this.msg2Payload = Buffer.from(opts.msg2Payload || "");
    this.sentMsg2 = false;
    this.clientNonce = null;
    this.toClient = null;
    this.closed = false;
    this.requests = [];
    this.chunkSize = opts.chunkSize || null;
    this.rejectHandshake = opts.rejectHandshake || false;
  }

  // The object HatchConnection uses as its transport.
  clientTransport() {
    const tunnel = this;
    return {
      opened: Promise.resolve(),
      send(bytes) {
        tunnel._fromClient(Buffer.from(bytes));
      },
      close() {
        tunnel._shutdown(1000, "client closed");
      },
      onMessage(cb) {
        tunnel.toClient = cb;
      },
      onClose(cb) {
        tunnel.clientCloseHandler = cb;
      },
    };
  }

  _push(frame) {
    if (this.toClient) this.toClient(Buffer.from(frame));
  }

  _shutdown(code, reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.clientCloseHandler) this.clientCloseHandler(code, reason);
  }

  sendClose(code = 1000, reason = "") {
    this._shutdown(code, reason);
  }

  _fromClient(frame) {
    if (!this.cipher) {
      if (!this.sentMsg2) {
        const clientPayload = this.server.read(frame); // msg1: cleartext client nonce blob
        this._push(this.server.write(this.msg2Payload));
        this.sentMsg2 = true;
        this.clientNonce = clientPayload;
        if (this.rejectHandshake) this._shutdown(1008, "rejected");
        return;
      }
      this.server.read(frame); // msg3
      this.cipher = this.server.split();
      return;
    }
    const plaintext = this.cipher.decrypt(frame);
    const envelope = this.reassembler.feed(plaintext);
    if (!envelope) return;
    const serviceRequest = wire.decodeServiceRequest(envelope);
    const serviceFrame = wire.decodeServiceFrame(serviceRequest.payload);
    if (serviceFrame.kind !== "request") {
      if (serviceFrame.kind === "reset") {
        this.requests.push({ kind: "reset", streamId: serviceFrame.streamId, reset: wire.decodeReset(serviceFrame.payload) });
      }
      return;
    }
    const app = wire.decodeApplicationRequest(serviceFrame.payload);
    const record = {
      streamId: serviceFrame.streamId,
      service: serviceRequest.service,
      method: app.verb,
      path: app.path,
      headers: app.headers,
      body: app.body.toString("utf8"),
    };
    this.requests.push(record);
    this.onRequest(record, this);
  }

  // Helpers the route table uses to answer a request.
  reply(streamId, { status = 200, body = "", headers = [], endBody = true } = {}) {
    const payload = wire.encodeApplicationResponse({
      status,
      headers,
      body: Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8"),
      endBody,
    });
    this._sendFrame(wire.encodeServiceResponse(wire.encodeServiceFrame(streamId, "response", payload)));
  }

  chunk(streamId, data, endBody = false) {
    this._sendFrame(
      wire.encodeServiceResponse(
        wire.encodeServiceFrame(streamId, "body_chunk", wire.encodeBodyChunk(Buffer.from(data), endBody))
      )
    );
  }

  reset(streamId, code = 1, reason = "server reset") {
    this._sendFrame(
      wire.encodeServiceResponse(wire.encodeServiceFrame(streamId, "reset", wire.encodeReset(code, reason)))
    );
  }

  _sendFrame(envelope) {
    for (const chunk of wire.splitNoisePayload(envelope, { chunkSize: this.chunkSize || undefined })) {
      this._push(this.cipher.encrypt(chunk));
    }
  }
}

function defaultRequest(record, tunnel) {
  tunnel.reply(record.streamId, { status: 200, body: '{"ok":true}\n', headers: [["content-type", "application/json"]] });
}

module.exports = { FakeTunnel };
