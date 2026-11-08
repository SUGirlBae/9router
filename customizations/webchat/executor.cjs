/**
 * WebChat Executor Factory - creates provider-specific executors from Base class
 * Usage: const {createWebchatExecutor} = require('./executor');
 *        new createWebchatExecutor(Base, config).execute({...})
 * Config: {id: string, baseUrl: string, authTokenFromCredentials(credentials), upstreamResponseParser(response)}
 */
"use strict";

// Normalize SSE responses from any webchat provider into OpenAI-style event stream.
// Qwen real format: data: {"choices":[{"delta":{"content":"...","phase":"answer"|"thinking_summary","status":"typing"|"finished"}}]}
//   - only phase==="answer" carries visible text; thinking_summary is reasoning (skip for content)
//   - stream ends with status:"finished" (no [DONE] line)
// Kimi format: data: {"event":"cmpl","text":"..."} / {"event":"all_done"}
// OpenAI chat format tolerated: choices[0].delta.content + data: [DONE]
function normalizeSSE(body, providerId = "webchat") {
  let delta = "";
  let reasoning = "";
  let done = false;
  for (const block of String(body).split("\n\n")) {
    let dataLine = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) dataLine = line.slice(5).trim();
    }
    if (dataLine === null) continue;
    if (dataLine === "[DONE]") { done = true; continue; }
    let j; try { j = JSON.parse(dataLine); } catch { continue; }
    if (j.event === "cmpl" || j.event === "cmp") { delta += j.text || j.content || ""; continue; }
    if (j.event === "all_done" || j.event === "done") { done = true; continue; }
    const d = j.choices && j.choices[0] && j.choices[0].delta;
    if (d) {
      if (d.phase === "thinking_summary") {
        const t = d.extra && d.extra.summary_thought && Array.isArray(d.extra.summary_thought.content) ? d.extra.summary_thought.content.join("") : "";
        if (t) reasoning = t; // keep latest snapshot, do not append duplicates
      } else if (typeof d.content === "string" && d.content) {
        delta += d.content;
      }
      if (d.status === "finished" && d.phase !== "thinking_summary") done = true;
      if (j.choices[0].finish_reason) done = true;
    }
  }
  const outEvents = [];
  const chunk = (content) => `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content } }], created: Math.floor(Date.now() / 1e3), id: `chatcmpl-${Date.now()}`, model: "", object: "chat.completion.chunk" })}\n\n`;
  if (delta) outEvents.push(chunk(delta));
  outEvents.push("data: [DONE]\n\n");
  return new Response(outEvents.join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
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
      this.transport = cfg.transport || "direct";
      this.home = cfg.home || null;
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
      // Browser transport is self-authenticating (reads the logged-in profile); only direct needs a token.
      if (this.transport !== "browser" && !token) throw new Error("Missing auth token in credentials");
      
      // Normalize messages (Qwen/Kimi expect [{"role": "user|assistant", "content": "..."}])
      const normalizedMessages = Array.isArray(body.messages) 
        ? body.messages.map(m => ({role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)}))
        : [];
      
      const requestBody = {
        model: model || "qwen3.7-plus",
        messages: normalizedMessages,
        stream: stream !== false,
      };

      // Browser transport: run fetch inside the logged-in page (genuine cookies/TLS),
      // required for qwen-web because direct Node fetch hits Alibaba anti-bot.
      if (this.transport === "browser" && this.home) {
        const { chatViaBrowser } = require(require("node:path").join(this.home, "browser-client.cjs"));
        const r = await chatViaBrowser({ model: requestBody.model, messages: normalizedMessages, stream: requestBody.stream });
        if (r.contentType.includes("application/json")) {
          return { response: new Response(r.text, { status: r.status || 502, headers: { "Content-Type": "application/json" } }), url: this.baseUrl, headers: {}, transformedBody: r.text };
        }
        const normalized = normalizeSSE(r.text, id);
        return { response: normalized, url: this.baseUrl, headers: { "content-type": "text/event-stream" }, transformedBody: r.text };
      }
      
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

module.exports = { createWebchatExecutor, normalizeSSE };