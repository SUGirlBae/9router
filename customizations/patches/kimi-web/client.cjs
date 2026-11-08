/**
 * Kimi Web Client - endpoint confirmed via unauth probe (401 = exists):
 *   POST https://www.kimi.com/api/chat/{chat_id}/completion/stream
 * "new" = placeholder chat_id for a fresh conversation.
 * Auth: Bearer token from browser session (cookie/localStorage), see auth.js.
 */
"use strict";
const crypto = require("crypto");

const BASE = process.env.KIMI_BASE_URL || "https://www.kimi.com";

function generateHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    origin: BASE,
    referer: `${BASE}/`,
    "x-request-id": crypto.randomUUID(),
  };
}

function buildRequestBody({ messages, chatId = "new", model = null }) {
  // Kimi web completion body: refs + prompt history; keep OpenAI messages mapped to kimi shape
  const body = {
    kimiplus_id: "kimi",
    extend: { sidebar: true },
    refs: { type: "one", id: chatId },
    history: messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) })),
    prompt: messages.length ? (typeof messages[messages.length - 1].content === "string" ? messages[messages.length - 1].content : "") : "",
  };
  if (model) body.model = model;
  return body;
}

async function chatCompletion({ messages, chatId = "new", model = null, token, timeoutMs = 60000 }) {
  const url = `${BASE}/api/chat/${encodeURIComponent(chatId)}/completion/stream`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: generateHeaders(token),
      body: JSON.stringify(buildRequestBody({ messages, chatId, model })),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text();
      throw { status: res.status, body: text, headers: Object.fromEntries(res.headers) };
    }
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

module.exports = { chatCompletion, buildRequestBody, generateHeaders, BASE };