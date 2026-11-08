// In-bundle muse-web executor: wraps 9router's shipped Playwright executor and
// answers first with the direct Noise tunnel, falling back to the browser path
// on ANY problem. Installed at %APPDATA%/9router/runtime/ by
// muse/patch-9r-muse-executor.js; 9r-net-keeper.js publishes it as
// globalThis.__9rMuseWrap, and the patched registry calls it.
//
// The credential comes from 9router itself: `credentials.apiKey` holds the whole
// stored cookie blob, so a key registered in the 9router dashboard is exactly
// what this path authenticates with.

"use strict";

const path = require("node:path");
const fs = require("node:fs");

// Installed layout: %APPDATA%/9router/runtime/muse-web-http-executor.cjs plus
// %APPDATA%/9router/runtime/muse/**, with MUSE_HOME/MUSE_RUNTIME set by the
// keeper. From the workspace both default to this folder's own tree.
const MUSE_HOME = process.env.MUSE_HOME || __dirname;
const RUNTIME = process.env.MUSE_RUNTIME || path.dirname(MUSE_HOME);

function loadBridge() {
  const bridgePath = path.join(MUSE_HOME, "muse-bridge.cjs");
  if (!fs.existsSync(bridgePath)) throw new Error(`muse driver missing at ${bridgePath}`);
  return require(bridgePath);
}

// A per-credential bridge so accounts do not share tunnels.
const bridges = new Map();
function bridgeFor(credential) {
  const key = String(credential || "").slice(0, 64) + ":" + String(credential || "").length;
  if (bridges.has(key)) return bridges.get(key);
  const { MuseBridge } = loadBridge();
  const { AccountPool } = require(path.join(MUSE_HOME, "lib", "pool.cjs"));
  const pool = new AccountPool({
    file: path.join(RUNTIME, "muse-executor-pool.json"),
    accounts: [{ label: "9router-credential", cookies: String(credential || ""), state: "active", cooldownUntil: 0 }],
  });
  const bridge = new MuseBridge({ pool, log: () => {} });
  bridges.set(key, bridge);
  return bridge;
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return typeof body === "object" ? body : {};
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunkObject(id, model, created, delta, finishReason) {
  return { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }] };
}

function jsonReplacers(key, value) {
  if (typeof value !== "string") return value;
  if (key === "b64_json" || key === "b64") return `<base64 ${value.length} bytes>`;
  return value.length > 400 && /^[A-Za-z0-9_+/=.\-]{400,}$/.test(value) ? `<blob ${value.length}>` : value;
}

// Turn the bridge's delta stream into whatever the OpenAI client expects.
async function respond({ bridge, parsed, model, stream, signal, id, created }) {
  const iterator = bridge.chat({
    model,
    messages: parsed.messages || [],
    tools: parsed.tools,
    functions: parsed.functions,
    toolChoice: parsed.tool_choice,
    signal,
    sessionId: typeof parsed.user === "string" && parsed.user.length ? parsed.user : undefined,
  });

  if (!stream) {
    let text = "";
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for await (const piece of iterator) {
      if (piece.replace) text = piece.replace;
      else if (piece.delta) text += piece.delta;
      if (piece.done) usage = piece.usage || usage;
    }
    return {
      status: 200,
      payload: {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop", logprobs: null }],
        usage,
      },
    };
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(sseFrame(chunkObject(id, model, created, { role: "assistant" }))));
        for await (const piece of iterator) {
          if (piece.replace) controller.enqueue(encoder.encode(sseFrame(chunkObject(id, model, created, { content: piece.replace }))));
          else if (piece.delta) controller.enqueue(encoder.encode(sseFrame(chunkObject(id, model, created, { content: piece.delta }))));
        }
        controller.enqueue(encoder.encode(sseFrame(chunkObject(id, model, created, {}, "stop"))));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return { status: 200, streamBody: body };
}

const STATUS_BY_KIND = { auth: 401, access: 403, policy: 400, quota: 429, timeout: 504, region: 503, upstream: 502, exhausted: 503 };

function errorResponse(kind, message, model) {
  return {
    status: STATUS_BY_KIND[kind] || 502,
    payload: { error: { message: String(message).slice(0, 300), type: kind === "quota" ? "rate_limit_error" : "server_error", code: kind, param: null } },
  };
}

function asLogger(candidate) {
  // 9router hands the executor a logger whose exact shape has moved between
  // versions; anything that is not callable must degrade to a no-op rather than
  // throw, or the fallback path dies with the same error it is meant to survive.
  return typeof candidate === "function" ? candidate : () => {};
}

// The wrapper 9r-net-keeper.js installs. Only execute() and generateMedia() are
// overridden; everything else (testConnection and the whole browser machinery)
// still belongs to the untouched Playwright executor.
function wrap(base) {
  const driverReady = (() => {
    try {
      loadBridge();
      return true;
    } catch (err) {
      console.log("[muse-web] direct driver unavailable:", err.message);
      return false;
    }
  })();
  const disabled = process.env.NINEROUTER_MUSE_HTTP === "0";

  const skipToBrowser = (reason, log) => {
    if (log) log(`muse-web: using browser executor (${reason})`);
    return { used: false, reason };
  };

  const overrides = {
    async execute(ctx) {
      const log = asLogger(ctx.log);
      if (disabled || !driverReady) return base.execute(ctx);
      let bridge = null;
      try {
        const parsed = parseBody(ctx.body);
        const model = String(ctx.model || parsed.model || "muse-chat");
        bridge = bridgeFor(ctx.credentials && ctx.credentials.apiKey ? ctx.credentials.apiKey : ctx.credentials);
        const id = "chatcmpl-" + Math.random().toString(36).slice(2, 14);
        const created = Math.floor(Date.now() / 1000);
        const outcome = await respond({
          bridge,
          parsed,
          model,
          stream: ctx.stream === true || parsed.stream === true,
          signal: ctx.signal,
          id,
          created,
        });
        const headers = { "content-type": outcome.streamBody ? "text/event-stream" : "application/json" };
        const body = outcome.streamBody || JSON.stringify(outcome.payload);
        log(`muse-web: served ${model} directly (${outcome.streamBody ? "stream" : "json"})`);
        return {
          response: new Response(body, { status: outcome.status, headers }),
          url: "noise://hatch.metaaivm.com/v1/noise",
          headers,
          transformedBody: outcome.streamBody ? undefined : JSON.parse(JSON.stringify(outcome.payload, jsonReplacers)),
        };
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        const kind = err && err.kind ? err.kind : "upstream";
        if (kind === "policy") {
          return {
            response: new Response(JSON.stringify(errorResponse(kind, err.message).payload), { status: 400, headers: { "content-type": "application/json" } }),
            url: "noise://hatch.metaaivm.com/v1/noise",
            headers: { "content-type": "application/json" },
            transformedBody: null,
          };
        }
        log(`muse-web: direct path failed (${kind}: ${String(err.message).slice(0, 120)}), falling back to the browser executor`);
        return base.execute(ctx);
      }
    },

    async generateMedia(opts) {
      const log = asLogger(opts && opts.log);
      if (disabled || !driverReady) return base.generateMedia(opts);
      try {
        const bridge = bridgeFor(opts.credentials && opts.credentials.apiKey ? opts.credentials.apiKey : opts.credentials);
        const result = await bridge.generate({
          kind: opts.kind === "video" ? "video" : "image",
          prompt: opts.prompt,
          n: opts.n,
          size: opts.size,
          duration: opts.duration,
          resolution: opts.resolution,
          signal: opts.signal,
        });
        if (opts.images && opts.images.length) skipToBrowser("image-to-video not sent", log);
        log(`muse-web: ${opts.kind} generated directly (${result.artifacts.length} artifact(s))`);
        return result.artifacts.map((a) => ({ b64: a.b64, mime: a.mime }));
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        if (err && err.kind === "policy") {
          // A refused entitlement (e.g. video gated by region) is a real answer,
          // not a transport failure: the browser path would refuse too.
          throw Object.assign(new Error(String(err.message)), { museKind: err.kind });
        }
        log(`muse-web: direct media failed (${err && err.kind ? err.kind : "error"}: ${String(err.message).slice(0, 120)}), falling back to the browser executor`);
        return base.generateMedia(opts);
      }
    },
  };

  // Everything the driver does not own — testConnection, the browser machinery,
  // provider metadata — keeps going to the untouched Playwright executor.
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property];
      const value = base ? base[property] : undefined;
      return typeof value === "function" ? value.bind(base) : value;
    },
    has(target, property) {
      return property in target || Boolean(base && property in base);
    },
    set(target, property, value) {
      if (property in target) target[property] = value;
      else if (base) base[property] = value;
      return true;
    },
  });
}

module.exports = { wrap, bridgeFor, STATUS_BY_KIND };
