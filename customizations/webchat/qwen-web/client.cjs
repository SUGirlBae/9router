/**
 * Qwen Web Client Module - HTTP request builder + anti-bot header generation
 * Endpoint: https://chat.qwen.ai/api/v2/chat/completions
 * Model IDs: qwen3.7-plus (verified); normalize suffixes via regex if needed.
 */
"use strict";
const { getToken } = require("./session");
const crypto = require("crypto");

// Generate deterministic anti-bot headers (bx-v, bx-umidtoken) from browser profile
// In production these come from browser fingerprint; offline test uses stub values.
function generateAntiBotHeaders(userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0") {
  const requestId = crypto.randomUUID();
  // Stub values for offline testing; live driver reads from browser profile
  return {
    "x-request-id": requestId,
    "bx-v": "2.5.3", // version string observed in captures
    "bx-ua": process.env.QWEN_BX_UA || "stub-bx-ua-for-offline",
    "bx-umidtoken": process.env.QWEN_BX_UMIDTOKEN || "stub-umidtoken-for-offline",
    "user-agent": userAgent,
    "referer": "https://chat.qwen.ai/",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "accept": "text/event-stream",
    "content-type": "application/json",
  };
}

function buildRequestBody({ model, messages, stream = true, chatId = null }) {
  const normalizedModel = model.replace(/\(.*?\)|\[.*?\]$/g, ""); // strip suffixes like (high), [1m]
  const body = {
    model: normalizedModel,
    messages: messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
    stream,
  };
  if (chatId) {
    body.chat_id = chatId;
    body.incremental_output = true;
    body.chat_mode = "normal";
  }
  return body;
}

async function chatCompletion({ model, messages, stream = true, chatId = null, timeoutMs = 30000, token = null }) {
  const tok = token || (await getToken());
  const headers = {
    ...generateAntiBotHeaders(),
    authorization: `Bearer ${tok}`,
  };
  const body = buildRequestBody({ model, messages, stream, chatId });
  const base = process.env.QWEN_BASE_URL || "https://chat.qwen.ai";
  const url = chatId
    ? `${base}/api/v2/chat/completions?chat_id=${chatId}`
    : `${base}/api/v2/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text();
      throw { status: res.status, body: text, headers: Object.fromEntries(res.headers) };
    }
    return res; // caller parses SSE or JSON
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

module.exports = { chatCompletion, buildRequestBody, generateAntiBotHeaders };