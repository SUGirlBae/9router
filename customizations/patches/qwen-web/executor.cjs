/**
 * WebChat Executor Factory - creates provider-specific executors from Base class
 * Usage: const {createWebchatExecutor} = require('./executor');
 *        new createWebchatExecutor(Base, config).execute({...})
 * Config: {id: string, baseUrl: string, authTokenFromCredentials(credentials), upstreamResponseParser(response)}
 */
"use strict";

// Normalize SSE responses from any webchat provider into OpenAI-style event stream
function normalizeSSE(body, providerId = "webchat") {
  const events = [];
  let delta = "";
  let done = false;
  const decoder = new TextDecoder();
  // For kimi: event:cmpl → delta; all_done → done
  // For qwen: delta content in choices[0].delta.content (OpenAI-style already)
  if (body.includes('event:')) {
    for (const line of body.split("\n\n")) {
      const m = line.match(/data:\s*"event":"(cmpl|all_done)"[,}]/);
      if (!m) continue;
      if (m[1] === "cmpl") {
        const t = line.match(/"text":"([^"]*)"/);
        if (t) delta += decodeURIComponent(t[1]);
      } else done = true;
    }
  } else {
    try {
      const j = JSON.parse(body);
      if (j.choices && j.choices[0]?.delta?.content) {
        delta += j.choices[0].delta.content;
      }
      if (j.choices && j.choices[0]?.finish_reason) done = true;
    } catch { /* assume raw text */ delta = body; done = body.endsWith("[DONE]"); }
  }
  // Build OpenAI-like SSE stream
  const outEvents = [];
  if (delta) outEvents.push(`data: ${JSON.stringify({choices: [{delta: {role: "assistant", content: delta}}], created: Date.now()/1e3, id: `chatcmpl-${Date.now()}`, model: "", object: "chat.completion.chunk"})}\n\n`);
  if (done) outEvents.push(`data: [DONE]\n\n`);
  return new Response(outEvents.join(""), {
    status: 200, headers: {"Content-Type": "text/event-stream"}
  });
}

function createWebchatExecutor(Base, cfg) {
  const {id, baseUrl, authTokenFromCredentials, upstreamResponseParser} = cfg;
  // Fallback parent when Base class is not in scope at the registry patch site:
  // a plain class exposing the fields the router reads (provider/options).
  const Parent = Base || class { constructor(n, o) { this.provider = n; this.options = o || {}; } };

  return class extends Parent {
    constructor() {
      super(id, {baseUrl});
      // Set explicitly: the real Base may store these differently; fallback Parent stores options only.
      this.provider = id;
      this.baseUrl = baseUrl;
    }
    
    async testConnection(token) {
      try {
        if (!token || token.trim().length < 10) return false;
        // Minimal ping request to validate token works
        const resp = await fetch(`${this.baseUrl}/api/health`, {headers: {"Authorization": `Bearer ${token}`}, signal: AbortSignal.timeout(5000)});
        return resp.ok;
      } catch { return false; }
    }
    
    async execute({model, body, stream, credentials, signal, log}) {
      const token = typeof credentials === "string" ? credentials : credentials?.accessToken || credentials?.token || credentials?.cookie;
      if (!token) throw new Error("Missing auth token in credentials");
      
      // Normalize messages (Qwen/Kimi expect [{"role": "user|assistant", "content": "..."}])
      const normalizedMessages = Array.isArray(body.messages) 
        ? body.messages.map(m => ({role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)}))
        : [];
      
      const requestBody = {
        model: model || "qwen3.7-plus",
        messages: normalizedMessages,
        stream: stream !== false,
      };
      
      // Upstream request builder based on provider id
      let upstreamUrl = `${this.baseUrl}/api/v2/chat/completions`;
      if (id === "kimi-web") upstreamUrl = `${this.baseUrl}/api/chat/new/completion/stream`;
      
      const res = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
          UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Referer: this.baseUrl,
        },
        body: JSON.stringify(requestBody),
        signal,
      });
      
      // Parse upstream response
      let responseBody;
      if (res.headers.get("content-type")?.includes("application/json")) {
        const j = await res.json();
        responseBody = {response: new Response(JSON.stringify(j), {status: res.status, headers: Object.fromEntries(res.headers)})};
      } else {
        const text = await res.text();
        const normalized = normalizeSSE(text, id);
        responseBody = {response: normalized, url: res.url, headers: Object.fromEntries(res.headers), transformedBody: text};
      }
      
      return responseBody;
    }
  };
}

module.exports = {createWebchatExecutor};