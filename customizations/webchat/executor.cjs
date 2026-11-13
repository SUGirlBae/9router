/**
 * WebChat Executor Factory - creates provider-specific executors from Base class
 * Supports Full AI-Agent capabilities for qwen-web:
 * - Real-time CDP SSE streaming (`delta.reasoning_content`, `delta.content`, `delta.tool_calls`)
 * - Hybrid _nonce-bound Tool Calling & Multi-turn Agent Trajectory
 * - Native Web Search (`-search` model suffix & `web_search` flag + Markdown citations)
 * - Pre/Post Hooks (RTK large tool result compression, loose JSON repair, upstream error mapping)
 */
"use strict";

const path = require("node:path");

function loadQwenAgentModules(homeDir) {
  const candidates = [
    homeDir,
    path.join(__dirname, "qwen-web"),
    __dirname,
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      const tools = require(path.join(dir, "qwen-tools.cjs"));
      const sse = require(path.join(dir, "sse.cjs"));
      return { tools, sse };
    } catch {}
  }
  return null;
}

// Normalize SSE responses from any webchat provider into OpenAI-style event stream.
// Preserves incremental `reasoning_content`, `content`, `tool_calls`, and citations for Qwen,
// while keeping Kimi and generic OpenAI SSE compatibility.
function normalizeSSE(body, providerId = "webchat", options = {}) {
  const mod = loadQwenAgentModules(options.home);
  if (mod && providerId !== "kimi-web") {
    const parser = mod.sse.createQwenSSEParser({
      model: options.model || "qwen3.7-plus",
      nonce: options.nonce || "",
      requestedTools: options.requestedTools || [],
    });
    const outEvents = [...parser.pushChunk(String(body || "")), ...parser.flush()];
    return new Response(outEvents.join(""), {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  let delta = "";
  let reasoning = "";
  for (const block of String(body).split(/\r?\n\r?\n/)) {
    let dataLine = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLine = line.slice(5).trim();
    }
    if (dataLine === null || dataLine === "[DONE]") continue;
    let j;
    try {
      j = JSON.parse(dataLine);
    } catch {
      continue;
    }
    if (j.event === "cmpl" || j.event === "cmp") {
      delta += j.text || j.content || "";
      continue;
    }
    const d = j.choices && j.choices[0] && j.choices[0].delta;
    if (d) {
      if (d.phase === "thinking_summary") {
        const t =
          d.extra && d.extra.summary_thought && Array.isArray(d.extra.summary_thought.content)
            ? d.extra.summary_thought.content.join("\n")
            : "";
        if (t) reasoning = t;
      } else if (typeof d.content === "string" && d.content) {
        delta += d.content;
      }
    }
  }
  const outEvents = [];
  const makeChunk = (deltaObj, finish = null) =>
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: deltaObj, finish_reason: finish }],
      created: Math.floor(Date.now() / 1e3),
      id: `chatcmpl-${Date.now()}`,
      model: options.model || "",
      object: "chat.completion.chunk",
    })}\n\n`;
  if (reasoning) outEvents.push(makeChunk({ role: "assistant", reasoning_content: reasoning }));
  if (delta) outEvents.push(makeChunk({ role: "assistant", content: delta }));
  outEvents.push(makeChunk({}, "stop"));
  outEvents.push("data: [DONE]\n\n");
  return new Response(outEvents.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function buildNonStreamingOpenAIResponse(collected, model) {
  const hasCalls = Array.isArray(collected.toolCalls) && collected.toolCalls.length > 0;
  const message = {
    role: "assistant",
    content: collected.content || (hasCalls ? null : ""),
  };
  if (collected.reasoningContent) {
    message.reasoning_content = collected.reasoningContent;
  }
  if (hasCalls) {
    message.tool_calls = collected.toolCalls;
  }
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model || "qwen3.7-plus",
      choices: [
        {
          index: 0,
          message,
          finish_reason: hasCalls ? "tool_calls" : "stop",
        },
      ],
      usage: collected.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function createWebchatExecutor(Base, cfg) {
  const { id, baseUrl } = cfg;
  const Parent =
    Base ||
    class {
      constructor(n, o) {
        this.provider = n;
        this.options = o || {};
      }
    };

  return class extends Parent {
    constructor() {
      super(id, { baseUrl });
      this.provider = id;
      this.baseUrl = baseUrl;
      this.transport = cfg.transport || "direct";
      this.home = cfg.home || null;
      this.hooks = cfg.hooks || {};
    }

    async testConnection(token) {
      try {
        if (!token || token.trim().length < 10) return false;
        const resp = await fetch(`${this.baseUrl}/api/health`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        return resp.ok;
      } catch {
        return false;
      }
    }

    async refreshCredentials(credentials, log) {
      if (this.transport === "browser" && this.home) {
        try {
          const browserMod = require(path.join(this.home, "browser-client.cjs"));
          if (typeof browserMod.refreshTokenViaPool === "function") {
            return await browserMod.refreshTokenViaPool();
          }
        } catch (e) {
          log?.warn?.("QWEN_AUTH", `refreshCredentials failed: ${e.message}`);
        }
      }
      return null;
    }

    async execute({ model, body, stream, credentials, signal }) {
      const bodyObj = body || {};
      const token =
        typeof credentials === "string"
          ? credentials
          : credentials?.accessToken || credentials?.token || credentials?.cookie;
      if (this.transport !== "browser" && !token) {
        throw new Error("Missing auth token in credentials");
      }

      const agentMods = loadQwenAgentModules(this.home);
      const requestedTools = Array.isArray(bodyObj.tools) ? bodyObj.tools : [];
      const { systemPrompt: toolSystemPrompt, nonce } =
        agentMods && requestedTools.length > 0
          ? agentMods.tools.serializeQwenToolPrompt(requestedTools)
          : { systemPrompt: "", nonce: "" };

      const agentOpts = agentMods
        ? agentMods.tools.resolveQwenAgentOptions(model, bodyObj)
        : {
            upstreamModel: model || "qwen3.7-plus",
            thinkingEnabled: false,
            searchEnabled: false,
            chatMode: "normal",
          };

      const normalizedMessages = agentMods
        ? agentMods.tools.buildQwenAgentMessages(bodyObj.messages, toolSystemPrompt, this.hooks)
        : Array.isArray(bodyObj.messages)
          ? bodyObj.messages.map((m) => ({
              role: m.role,
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            }))
          : [];

      const wantStream = stream !== false;
      const requestBody = {
        model: agentOpts.upstreamModel,
        messages: normalizedMessages,
        stream: true,
        incremental_output: true,
        chat_mode: agentOpts.chatMode,
      };
      const warnSink = (code, detail) => {
        try {
          console.warn(`[qwen-web] ${code}: ${detail}`);
        } catch {}
      };
      const parserOptions = {
        model: model || requestBody.model,
        nonce,
        requestedTools,
        onWarn: warnSink,
      };

      // Browser transport: execute via CDP Network Stream Interceptor + Warm Browser Pool
      if (this.transport === "browser" && this.home) {
        const browserMod = require(path.join(this.home, "browser-client.cjs"));
        if (typeof browserMod.chatViaBrowserStream === "function" && agentMods) {
          const r = await browserMod.chatViaBrowserStream({
            model: model || requestBody.model,
            messages: normalizedMessages,
            stream: true,
            searchEnabled: agentOpts.searchEnabled,
            thinkingEnabled: agentOpts.thinkingEnabled,
            signal,
          });

          if (r.text === "NO_TOKEN" || r.status >= 400 || (r.contentType && r.contentType.includes("application/json"))) {
            const mapped = agentMods.tools.mapQwenUpstreamError(r.status, r.text);
            return {
              response: new Response(
                JSON.stringify({ error: { message: mapped.message, code: mapped.code, type: "upstream_error" } }),
                { status: mapped.status, headers: { "Content-Type": "application/json" } }
              ),
              url: this.baseUrl,
              headers: {},
              transformedBody: JSON.stringify(requestBody),
            };
          }

          if (r.stream && wantStream) {
            const readable = agentMods.sse.createOpenAIStreamFromChunks(r.stream, parserOptions);
            return {
              response: new Response(readable, {
                status: 200,
                headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
              }),
              url: this.baseUrl,
              headers: { "content-type": "text/event-stream" },
              transformedBody: JSON.stringify(requestBody),
            };
          }

          // Non-streaming or fallback text response
          const parser = agentMods.sse.createQwenSSEParser(parserOptions);
          if (r.stream) {
            for await (const ch of r.stream) parser.pushChunk(ch);
          } else if (r.text) {
            parser.pushChunk(r.text);
          }
          parser.flush();
          const collected = parser.getCollected();
          if (collected.incomplete) {
            return {
              response: new Response(
                JSON.stringify({
                  error: {
                    message: "Qwen Web stream ended before completion (no finished signal received). Retry the request.",
                    type: "upstream_error",
                    code: "QWEN_STREAM_INCOMPLETE",
                  },
                }),
                { status: 502, headers: { "Content-Type": "application/json" } }
              ),
              url: this.baseUrl,
              headers: {},
              transformedBody: JSON.stringify(requestBody),
            };
          }
          return {
            response: buildNonStreamingOpenAIResponse(collected, model || requestBody.model),
            url: this.baseUrl,
            headers: { "content-type": "application/json" },
            transformedBody: JSON.stringify(requestBody),
          };
        }

        // Legacy fallback if chatViaBrowserStream is unavailable
        const r = await browserMod.chatViaBrowser({
          model: requestBody.model,
          messages: normalizedMessages,
          stream: wantStream,
        });
        if (r.contentType && r.contentType.includes("application/json")) {
          return {
            response: new Response(r.text, { status: r.status || 502, headers: { "Content-Type": "application/json" } }),
            url: this.baseUrl,
            headers: {},
            transformedBody: r.text,
          };
        }
        const normalized = normalizeSSE(r.text, id, {
          home: this.home,
          model: model || requestBody.model,
          nonce,
          requestedTools,
        });
        return {
          response: normalized,
          url: this.baseUrl,
          headers: { "content-type": "text/event-stream" },
          transformedBody: r.text,
        };
      }

      // Direct HTTP transport (used in offline tests and mock servers)
      let upstreamUrl = `${this.baseUrl}/api/v2/chat/completions`;
      if (id === "kimi-web") upstreamUrl = `${this.baseUrl}/api/chat/new/completion/stream`;

      const res = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Referer: this.baseUrl,
        },
        body: JSON.stringify(requestBody),
        signal,
      });

      if (res.headers.get("content-type")?.includes("application/json")) {
        const j = await res.json();
        return {
          response: new Response(JSON.stringify(j), {
            status: res.status,
            headers: { "Content-Type": "application/json" },
          }),
        };
      }

      const text = await res.text();
      if (!wantStream && agentMods && id !== "kimi-web") {
        const parser = agentMods.sse.createQwenSSEParser(parserOptions);
        parser.pushChunk(text);
        parser.flush();
        const collected = parser.getCollected();
        if (collected.incomplete) {
          return {
            response: new Response(
              JSON.stringify({
                error: {
                  message: "Qwen Web stream ended before completion (no finished signal received). Retry the request.",
                  type: "upstream_error",
                  code: "QWEN_STREAM_INCOMPLETE",
                },
              }),
              { status: 502, headers: { "Content-Type": "application/json" } }
            ),
            url: res.url,
            headers: {},
            transformedBody: text,
          };
        }
        return {
          response: buildNonStreamingOpenAIResponse(collected, model || requestBody.model),
          url: res.url,
          headers: { "content-type": "application/json" },
          transformedBody: text,
        };
      }

      const normalized = normalizeSSE(text, id, {
        home: this.home,
        model: model || requestBody.model,
        nonce,
        requestedTools,
      });
      return {
        response: normalized,
        url: res.url,
        headers: Object.fromEntries(res.headers),
        transformedBody: text,
      };
    }
  };
}

module.exports = { createWebchatExecutor, normalizeSSE };