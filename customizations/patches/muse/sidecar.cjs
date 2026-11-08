// Muse sidecar: an OpenAI-compatible HTTP front for MuseBridge, bound to
// loopback only. 9router reaches it as a custom "openai-compatible" provider,
// so a client can call Muse with 9router's own API key.
//
//   node muse/sidecar.cjs                     # listens on 127.0.0.1:20141
//   MUSE_SIDECAR_PORT=20141 MUSE_POOL=... node muse/sidecar.cjs
//
// Its own bearer key is separate from the 9router key on purpose: this service
// never reuses another system's credential material as a server secret.

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { MuseBridge, MODEL_ALIAS } = require("./muse-bridge.cjs");
const { GatewayError } = require("./lib/gateway.cjs");

const HOST = "127.0.0.1"; // never 0.0.0.0: 9router may be tunnel-exposed
const PORT = Number(process.env.MUSE_SIDECAR_PORT || 20141);
const KEY_FILE = path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "9router", "muse", "sidecar.key");

function loadKey() {
  if (process.env.MUSE_SIDECAR_KEY) return process.env.MUSE_SIDECAR_KEY.trim();
  try {
    const existing = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const generated = "muse-" + crypto.randomBytes(24).toString("base64url");
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, generated + "\n", { mode: 0o600 });
  return generated;
}

const KEY = loadKey();
const bridge = new MuseBridge({ log: (message, detail) => console.log(new Date().toISOString(), message, detail === undefined ? "" : JSON.stringify(detail)) });

const STATUS_FOR_KIND = {
  auth: 401,
  access: 403,
  policy: 400,
  quota: 429,
  timeout: 504,
  region: 503,
  upstream: 502,
  exhausted: 503,
};

function errorBody(err, message) {
  const kind = err && err.kind ? err.kind : "upstream";
  return {
    error: {
      message: String(message || (err && err.message) || "error").replace(/[A-Za-z0-9_+/=.-]{24,}/g, "<redacted>"),
      type: kind === "quota" ? "rate_limit_error" : kind === "auth" ? "authentication_error" : "server_error",
      code: kind,
      param: null,
    },
  };
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (piece) => {
      size += piece.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(piece);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const presented = Buffer.from(match[1].trim(), "utf8");
  const expected = Buffer.from(KEY, "utf8");
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

// OpenAI-shaped completion objects, streaming and not.
function chunkObject(id, model, created, delta, finishReason, usage) {
  const object = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }],
  };
  if (usage) object.usage = usage;
  return object;
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, errorBody(null, "body is not valid JSON"));
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return send(res, 400, errorBody(null, "messages is required"));
  const model = body.model || MODEL_ALIAS;
  const wantsStream = body.stream === true;
  const id = "chatcmpl-" + crypto.randomBytes(10).toString("hex");
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  req.on("close", abortRequest);

  const iterator = bridge.chat({
    model,
    messages,
    signal: controller.signal,
    sessionId: looksLikeUuid(body.user) ? body.user : undefined,
    tools: body.tools,
    functions: body.functions,
    toolChoice: body.tool_choice,
    budgetMs: Number(body.max_tokens ? Math.min(240000, 60000 + body.max_tokens * 2) : 180000),
  });

  try {
    if (wantsStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, must-revalidate",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify(chunkObject(id, model, created, { role: "assistant" }))}\n\n`);
      let finalUsage = null;
      for await (const piece of iterator) {
        if (piece.replace) {
          res.write(`data: ${JSON.stringify(chunkObject(id, model, created, { content: piece.replace }))}\n\n`);
          continue;
        }
        if (piece.delta) res.write(`data: ${JSON.stringify(chunkObject(id, model, created, { content: piece.delta }))}\n\n`);
        if (piece.done) finalUsage = piece.usage;
      }
      res.write(`data: ${JSON.stringify(chunkObject(id, model, created, {}, "stop", finalUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }))}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    let text = "";
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for await (const piece of iterator) {
      if (piece.replace) text = piece.replace;
      else if (piece.delta) text += piece.delta;
      if (piece.done) usage = piece.usage || usage;
    }
    send(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop", logprobs: null }],
      usage,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      if (wantsStream && !res.writableEnded) res.end();
      else send(res, 499, errorBody(null, "client aborted the request"));
      return;
    }
    const status = err instanceof GatewayError ? STATUS_FOR_KIND[err.kind] || 502 : 502;
    bridge.log("sidecar request failed", { kind: err && err.kind, status, message: String(err && err.message).slice(0, 200) });
    if (wantsStream && !res.headersSent) send(res, status, errorBody(err), { "Content-Type": "application/json" });
    else if (wantsStream) {
      res.write(`data: ${JSON.stringify(errorBody(err))}\n\n`);
      res.end();
    } else send(res, status, errorBody(err));
  } finally {
    req.off("close", abortRequest);
  }
}

function looksLikeUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// Image and video generation: the agent thread is the job, so this blocks until
// the artifact set settles and then answers with the bytes inline.
async function handleMedia(req, res, kind) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, errorBody(null, "body is not valid JSON"));
  }
  const prompt = String(body.prompt || (kind === "image" ? body.input : body.prompt) || "").trim();
  if (!prompt) return send(res, 400, errorBody(null, "prompt is required"));
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on("close", abort);
  try {
    const result = await bridge.generate({
      kind,
      prompt,
      n: body.n,
      size: body.size,
      duration: body.duration,
      resolution: body.resolution,
      signal: controller.signal,
    });
    const created = Math.floor(Date.now() / 1000);
    if (kind === "video") {
      return send(res, 200, {
        id: "videogen-" + crypto.randomBytes(8).toString("hex"),
        object: "video",
        model: body.model || "muse-video",
        status: "completed",
        created,
        mime: result.artifacts[0] ? result.artifacts[0].mime : "video/mp4",
        data: result.artifacts.map((a) => ({ b64_json: a.b64, mime: a.mime, path: a.path })),
      });
    }
    return send(res, 200, {
      created,
      data: result.artifacts.map((a) => ({ b64_json: a.b64, mime: a.mime, revised_prompt: a.label || null })),
    });
  } catch (err) {
    if (err && err.name === "AbortError") return send(res, 499, errorBody(null, "client aborted the generation"));
    const status = err instanceof GatewayError ? STATUS_FOR_KIND[err.kind] || 502 : 502;
    return send(res, status, errorBody(err));
  } finally {
    req.off("close", abort);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/healthz") {
    return send(res, 200, { ok: true, service: "muse-sidecar", accounts: bridge.accounts(), port: PORT });
  }
  if (!authorized(req)) return send(res, 401, errorBody(null, "missing or wrong bearer key"));

  try {
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const models = await bridge.models();
      return send(res, 200, { object: "list", data: models.data });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await handleChat(req, res);
    if (req.method === "POST" && url.pathname === "/v1/images/generations") return await handleMedia(req, res, "image");
    if (req.method === "POST" && url.pathname === "/v1/videos") return await handleMedia(req, res, "video");
    return send(res, 404, errorBody(null, `no route ${req.method} ${url.pathname}`));
  } catch (err) {
    const status = err instanceof GatewayError ? STATUS_FOR_KIND[err.kind] || 502 : 502;
    return send(res, status, errorBody(err));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`muse sidecar on http://${HOST}:${PORT}/v1 (key file ${KEY_FILE}, key ${KEY.slice(0, 9)}…)`);
  console.log(`accounts: ${bridge.accounts().map((a) => `${a.label}[${a.state}]`).join(", ") || "none"}`);
});

process.on("SIGINT", () => {
  bridge.close();
  server.close(() => process.exit(0));
});

module.exports = { server, KEY, KEY_FILE };
