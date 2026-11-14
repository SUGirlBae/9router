/**
 * Qwen Web Client Module — HTTP request builder matching qwen-chat-fe 0.3.42
 * Endpoint: https://chat.qwen.ai/api/v2/chat/completions?chat_id=<uuid>
 *
 * Wire contract captured live 2026-11-15 from the installed Qwen.exe identity
 * (CDP response-stage interception; see desktop-identity.cjs for the full header set):
 *
 *   POST body keys: stream, version("2.1"), incremental_output(true), chatId, parentId(""),
 *     chat_id, chat_mode("normal"), model, parent_id(null), messages[], timestamp(unix seconds)
 *   user message: { id:null, fid:<uuid>, parentId:null, childrenIds:[<assistant uuid>], role:"user",
 *     content, user_action:"chat", files:[], timestamp, models:[model], model:"",
 *     chat_type:"t2t", feature_config:{thinking_enabled, output_schema:"phase",
 *     research_mode, auto_thinking, thinking_mode, thinking_format:"summary", auto_search},
 *     extra:{meta:{subChatType:"t2t"}}, sub_chat_type:"t2t", parent_id:null }
 *
 * NOTE: direct HTTP cannot reproduce Baxia's bx-ua/bx-umidtoken signature; the production
 * transport for this provider is the UI-driven browser path in browser-client.cjs. This
 * module remains for offline tests and for replaying with externally supplied bx values.
 */
"use strict";
const { getToken } = require("./session");
const crypto = require("crypto");
const { qwenRequestHeaders, BAXIA_VERSION, WEB_APP_VERSION } = require("./desktop-identity.cjs");

// Deterministic anti-bot headers for offline use; live values come from Baxia in-page.
function generateAntiBotHeaders(userAgent = null) {
  const headers = qwenRequestHeaders({});
  if (userAgent) headers["User-Agent"] = userAgent;
  headers["bx-v"] = BAXIA_VERSION;
  headers["bx-ua"] = process.env.QWEN_BX_UA || "stub-bx-ua-for-offline";
  headers["bx-umidtoken"] = process.env.QWEN_BX_UMIDTOKEN || "stub-umidtoken-for-offline";
  return headers;
}

function normalizeFeatureConfig({ thinkingEnabled = false, searchEnabled = false, thinkingMode = null } = {}) {
  const mode = thinkingMode || (thinkingEnabled ? "Thinking" : "Fast");
  return {
    thinking_enabled: Boolean(thinkingEnabled),
    output_schema: "phase",
    research_mode: "normal",
    auto_thinking: mode === "Auto",
    thinking_mode: mode,
    thinking_format: "summary",
    auto_search: Boolean(searchEnabled),
  };
}

function buildMessageEnvelope({
  model,
  message,
  timestamp,
  thinkingEnabled = false,
  searchEnabled = false,
  chatMode = "normal",
  assistantChildId = null,
}) {
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  const fid = message.fid || message.id || crypto.randomUUID();
  return {
    id: message.id || null,
    fid,
    parentId: message.parentId ?? null,
    childrenIds: message.childrenIds || (assistantChildId ? [assistantChildId] : []),
    role: message.role,
    content,
    user_action: message.user_action || "chat",
    files: message.files || [],
    timestamp,
    models: message.role === "user" ? [model] : undefined,
    model: message.model || "",
    chat_type: message.chat_type || "t2t",
    feature_config: message.feature_config || normalizeFeatureConfig({ thinkingEnabled, searchEnabled }),
    extra: message.extra || { meta: { subChatType: message.sub_chat_type || "t2t" } },
    sub_chat_type: message.sub_chat_type || "t2t",
    parent_id: message.parent_id ?? null,
  };
}

function buildRequestBody({
  model,
  messages,
  stream = true,
  chatId = null,
  parentId = null,
  thinkingEnabled = false,
  searchEnabled = false,
  chatMode = "normal",
  now = Math.floor(Date.now() / 1000),
}) {
  const normalizedModel = model.replace(/\(.*?\)|\[.*?\]$/g, ""); // strip suffixes like (high), [1m]
  const id = chatId || crypto.randomUUID();
  const assistantChildId = crypto.randomUUID();
  const envelope = (messages || []).map((m) =>
    buildMessageEnvelope({
      model: normalizedModel,
      message: m,
      timestamp: m.timestamp || now,
      thinkingEnabled,
      searchEnabled,
      chatMode,
      assistantChildId: m.role === "user" && !m.childrenIds ? assistantChildId : null,
    })
  );
  return {
    stream,
    version: "2.1",
    incremental_output: true,
    chatId: id,
    parentId: parentId || "",
    chat_id: id,
    chat_mode: chatMode,
    model: normalizedModel,
    parent_id: parentId || null,
    messages: envelope,
    timestamp: now,
  };
}

async function chatCompletion({
  model,
  messages,
  stream = true,
  chatId = null,
  parentId = null,
  thinkingEnabled = false,
  searchEnabled = false,
  chatMode = "normal",
  timeoutMs = 30000,
  token = null,
}) {
  const tok = token || (await getToken());
  const headers = qwenRequestHeaders({ token: tok, chatId });
  headers["bx-v"] = BAXIA_VERSION;
  if (process.env.QWEN_BX_UA) headers["bx-ua"] = process.env.QWEN_BX_UA;
  if (process.env.QWEN_BX_UMIDTOKEN) headers["bx-umidtoken"] = process.env.QWEN_BX_UMIDTOKEN;
  const body = buildRequestBody({
    model,
    messages,
    stream,
    chatId,
    parentId,
    thinkingEnabled,
    searchEnabled,
    chatMode,
  });
  const base = process.env.QWEN_BASE_URL || "https://chat.qwen.ai";
  const url = body.chat_id
    ? `${base}/api/v2/chat/completions?chat_id=${body.chat_id}`
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

module.exports = {
  chatCompletion,
  buildRequestBody,
  buildMessageEnvelope,
  normalizeFeatureConfig,
  generateAntiBotHeaders,
  WEB_APP_VERSION,
};
