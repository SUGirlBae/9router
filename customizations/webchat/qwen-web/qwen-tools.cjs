/**
 * Qwen-Web Agent Tool Calling, Multi-turn Trajectory, Search Options & Hooks
 * Implements Hybrid _nonce-bound tool translation and pre/post hooks.
 */
"use strict";

const crypto = require("node:crypto");

const UPSTREAM_MODEL_MAP = {
  "qwen3.7-plus": "qwen3.7-plus",
  "qwen-plus": "qwen3.7-plus",
  "qwen-turbo": "qwen3.7-plus",
  "qwen3.7-72b": "qwen3.7-plus",
  "qwen3.7-coder": "qwen3.7-plus",
  "qwen3.7-max": "qwen3.7-plus",
  "qwen3.8-max": "qwen3.7-plus",
  "qwen-max": "qwen3.7-plus",
};

function createToolNonce() {
  return crypto.randomBytes(4).toString("hex");
}

function normalizeToolName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function resolveRequestedToolName(candidateName, requestedTools) {
  if (!candidateName || typeof candidateName !== "string") return null;
  if (!Array.isArray(requestedTools) || requestedTools.length === 0) return null;
  const trimmed = candidateName.trim();
  for (const t of requestedTools) {
    const fnName = t?.function?.name || t?.name;
    if (fnName === trimmed) return fnName;
  }
  const norm = normalizeToolName(trimmed);
  for (const t of requestedTools) {
    const fnName = t?.function?.name || t?.name;
    if (fnName && normalizeToolName(fnName) === norm) return fnName;
  }
  return null;
}

function compactToolParameters(params) {
  if (!params || typeof params !== "object") return {};
  const props = params.properties && typeof params.properties === "object" ? params.properties : {};
  const compactProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (!v || typeof v !== "object") continue;
    const entry = { type: v.type || "string" };
    if (Array.isArray(v.enum)) entry.enum = v.enum.slice(0, 10);
    compactProps[k] = entry;
  }
  const out = { type: "object", properties: compactProps };
  if (Array.isArray(params.required) && params.required.length > 0) {
    out.required = params.required;
  }
  return out;
}

function serializeQwenToolPrompt(tools, existingNonce) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { systemPrompt: "", nonce: "" };
  }
  const nonce = existingNonce || createToolNonce();
  const lines = [];
  for (const t of tools) {
    const fn = t?.function || t;
    if (!fn || typeof fn.name !== "string" || !fn.name.trim()) continue;
    const shortDesc =
      typeof fn.description === "string" && fn.description.trim()
        ? `: ${fn.description.trim().replace(/\s+/g, " ").slice(0, 180)}`
        : "";
    let paramsStr = "{}";
    try {
      if (fn.parameters && typeof fn.parameters === "object") {
        paramsStr = JSON.stringify(compactToolParameters(fn.parameters));
      }
    } catch {}
    lines.push(`- ${fn.name}${shortDesc}\n  parameters: ${paramsStr}`);
  }
  if (lines.length === 0) return { systemPrompt: "", nonce: "" };

  const systemPrompt = [
    "[LOCAL CLIENT TOOLS MANIFEST]",
    "CRITICAL SERVER RESTRICTION: Built-in/native server-side tool execution (<tool_call>) is DISABLED on this web endpoint (emitting native tool calls will fail with 'Tool <name> does not exists.').",
    "NEVER use native/built-in tool calling or <tool_call> tokens! Instead, to invoke any tool below, write a plain-text bracket block in your normal assistant response:",
    `[[TOOL]]{"name": "<tool_name>", "arguments": { ... }, "_nonce": "${nonce}"}[[/TOOL]]`,
    "Rules:",
    `- MANDATORY: When an action or tool is needed, you MUST emit the [[TOOL]]...[[/TOOL]] block in this turn. DO NOT merely describe your plan or say 'Let me check...' without including the [[TOOL]] block in the same message!`,
    `- Every [[TOOL]]...[[/TOOL]] block MUST include the exact security token "_nonce": "${nonce}".`,
    '- "name" must match one of the available tools; "arguments" must be a valid JSON object.',
    "- Emit one [[TOOL]]...[[/TOOL]] block per tool invocation. You may emit multiple blocks sequentially.",
    "- If no tool is needed, reply normally without any [[TOOL]] block.",
    "",
    "Available tools:",
    ...lines,
  ].join("\n");

  return { systemPrompt, nonce };
}

function balanceJsonDelimiters(str) {
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      stack.push("}");
    } else if (ch === "[") {
      stack.push("]");
    } else if ((ch === "}" || ch === "]") && stack.length > 0 && stack[stack.length - 1] === ch) {
      stack.pop();
    }
  }
  let res = str;
  if (inString) res += '"';
  while (stack.length > 0) res += stack.pop();
  return res;
}

function repairLooseJson(raw) {
  if (typeof raw !== "string") return null;
  let cleaned = raw.trim();
  // Strip surrounding markdown code fences if present
  cleaned = cleaned.replace(/^```(?:json|xml|tool)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}

  // 1. Remove trailing commas before } or ]
  let fixed = cleaned.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(fixed);
  } catch {}

  // 2. Fix unescaped Windows backslashes in paths (e.g. D:\9router -> D:\\9router)
  // Match valid JSON escape sequences first so already-escaped `\\` is consumed as a pair.
  fixed = fixed.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m, validEsc) =>
    validEsc ? m : "\\\\"
  );
  try {
    return JSON.parse(fixed);
  } catch {}

  // 3. Auto-close missing } or ] when LLM drops a trailing closing brace
  const balanced = balanceJsonDelimiters(fixed).replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(balanced);
  } catch {}

  return null;
}

function parseQwenToolCalls(rawText, expectedNonce, requestedTools, options = {}) {
  const onWarn = typeof options.onWarn === "function" ? options.onWarn : null;
  if (typeof rawText !== "string" || !rawText.trim()) {
    return { content: rawText || "", toolCalls: null };
  }

  // Unwrap fenced [[TOOL]] or <tool> blocks first (Post-response repair hook)
  const unfenced = rawText.replace(
    /```(?:xml|json|tool|text)?\s*((?:<(?:tool|tool_call)\b[\s\S]*?<\/(?:tool|tool_call)>|\[\[TOOL\]\][\s\S]*?\[\[\/TOOL\]\]))\s*```/gi,
    "$1"
  );

  const tagRegex = /(?:<(tool|tool_call)\b[^>]*>([\s\S]*?)<\/\1>|\[\[TOOL\]\]([\s\S]*?)\[\[\/TOOL\]\])/gi;
  const matches = [];
  let match;
  while ((match = tagRegex.exec(unfenced)) !== null) {
    matches.push({
      fullMatch: match[0],
      inner: match[2] !== undefined ? match[2] : match[3],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  if (matches.length === 0) {
    return { content: rawText, toolCalls: null };
  }

  const validCalls = [];
  const stripRanges = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const obj = repairLooseJson(m.inner);
    if (!obj || typeof obj !== "object") {
      if (onWarn) {
        try {
          onWarn("TOOL_JSON_MALFORMED", `Rejected <tool> block with unparseable JSON body (first 120 chars): ${m.inner.slice(0, 120)}`);
        } catch {}
      }
      continue;
    }

    const rawName = obj.name || obj.tool || obj.type;
    const rawArgs = obj.arguments ?? obj.params ?? obj.parameters ?? {};
    const argsObj = typeof rawArgs === "string" ? repairLooseJson(rawArgs) || {} : { ...(rawArgs || {}) };

    const callNonce = obj._nonce ?? argsObj._nonce;
    const nonceMatches = !expectedNonce || callNonce === expectedNonce;
    // Sequential nonce fallback (a1b2c3, d4e5f6, g7h8i9) is allowed only when explicitly enabled or via QWEN_ALLOW_SEQ_NONCE=1;
    // arbitrary wildcard hex like [a-f0-9]{6} is strictly disallowed to prevent prompt injection bypasses.
    const allowSeq = options.allowSequentialNonce === true || process.env.QWEN_ALLOW_SEQ_NONCE === "1";
    const isModelSequenceNonce =
      allowSeq &&
      !nonceMatches &&
      typeof callNonce === "string" &&
      /^(a1b2c3|d4e5f6|g7h8i9)$/i.test(callNonce.trim());

    if (!nonceMatches && !isModelSequenceNonce) {
      // Security gate: reject tool calls with missing or mismatched _nonce
      if (onWarn) {
        try {
          onWarn("TOOL_NONCE_MISMATCH", `Rejected tool call "${rawName || "unknown"}" with missing/mismatched _nonce (possible hallucination or prompt injection)`);
        } catch {}
      }
      continue;
    }

    delete argsObj._nonce;
    const resolvedName = resolveRequestedToolName(rawName, requestedTools);
    if (!resolvedName) {
      if (onWarn) {
        try {
          onWarn("TOOL_NAME_UNKNOWN", `Rejected tool call "${rawName || "unknown"}" not present in requested tools`);
        } catch {}
      }
      continue;
    }

    validCalls.push({
      index: validCalls.length,
      id: `call_${Date.now()}_${validCalls.length}`,
      type: "function",
      function: {
        name: resolvedName,
        arguments: JSON.stringify(argsObj),
      },
    });
    stripRanges.push([m.start, m.end]);
  }

  if (validCalls.length === 0) {
    return { content: rawText, toolCalls: null };
  }

  let remaining = "";
  let cursor = 0;
  for (const [s, e] of stripRanges) {
    remaining += unfenced.slice(cursor, s);
    cursor = e;
  }
  remaining += unfenced.slice(cursor);

  return {
    content: remaining.trim(),
    toolCalls: validCalls,
  };
}

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return JSON.stringify(part);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function compressToolResultText(text, maxChars = 32000, isError = false) {
  if (isError || typeof text !== "string" || text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const removed = text.length - maxChars;
  return `${text.slice(0, half)}\n\n[...truncated ${removed} chars by pre-hook token saver...]\n\n${text.slice(-half)}`;
}

function buildQwenAgentMessages(messages, toolSystemPrompt = "", options = {}) {
  const maxToolResultChars = options.maxToolResultChars || 32000;
  const src = Array.isArray(messages) ? messages : [];
  const systemParts = [];
  const conversation = [];
  const toolNameByCallId = new Map();

  for (const m of src) {
    if (!m || typeof m !== "object") continue;
    const role = m.role || "user";
    const text = extractTextContent(m.content);

    if (role === "system" || role === "developer") {
      if (text.trim()) systemParts.push(text.trim());
      continue;
    }

    if (role === "assistant") {
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const serializedCalls = [];
      for (const tc of toolCalls) {
        const fnName = tc?.function?.name || tc?.name || "tool";
        if (tc?.id) toolNameByCallId.set(tc.id, fnName);
        let parsedArgs = {};
        try {
          parsedArgs =
            typeof tc?.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc?.function?.arguments || {};
        } catch {}
        serializedCalls.push(`<tool>${JSON.stringify({ name: fnName, arguments: parsedArgs })}</tool>`);
      }
      const combined = [text.trim(), ...serializedCalls].filter(Boolean).join("\n");
      if (combined) {
        conversation.push({ role: "assistant", content: combined });
      }
      continue;
    }

    if (role === "tool" || role === "function") {
      const callId = m.tool_call_id || m.id || "unknown_call";
      const toolName = m.name || toolNameByCallId.get(callId) || "tool";
      const isErr = m.is_error === true || m.status === "error";
      const compressed = compressToolResultText(text, maxToolResultChars, isErr);
      conversation.push({
        role: "user",
        content: `[Tool Result: ${toolName} (${callId})]\n${compressed}`,
      });
      continue;
    }

    conversation.push({
      role: "user",
      content: text,
    });
  }

  if (toolSystemPrompt && toolSystemPrompt.trim()) {
    systemParts.push(toolSystemPrompt.trim());
  }

  const maxHistoryMessages = options.maxHistoryMessages || 30;
  let boundedConversation = conversation;
  if (conversation.length > maxHistoryMessages) {
    const firstUser = conversation.find((m) => m.role === "user");
    const recent = conversation.slice(-maxHistoryMessages);
    if (firstUser && !recent.includes(firstUser)) {
      boundedConversation = [firstUser, ...recent.slice(1)];
    } else {
      boundedConversation = recent;
    }
  }

  const finalMessages = [];
  if (systemParts.length > 0) {
    finalMessages.push({
      role: "system",
      content: systemParts.join("\n\n"),
    });
  }
  finalMessages.push(...boundedConversation);

  if (typeof options.preRequestHook === "function") {
    try {
      const hooked = options.preRequestHook(finalMessages);
      if (Array.isArray(hooked)) return hooked;
    } catch {}
  }

  return finalMessages;
}

function resolveQwenAgentOptions(model, body = {}) {
  const raw = String(model || "qwen3.7-plus")
    .toLowerCase()
    .replace(/^(qwen-web|qw-web)\//, "")
    .trim();

  let thinkingEnabled =
    raw.includes("-think") ||
    raw.includes("-reason") ||
    body?.thinking === true ||
    body?.thinking_enabled === true ||
    !!body?.reasoning_effort;

  let searchEnabled =
    raw.includes("-search") ||
    body?.web_search === true ||
    body?.search === true ||
    body?.enable_search === true;

  const baseModel = raw
    .replace(/-(think|thinking|reason|reasoning|search)/g, "")
    .replace(/\([^()]+\)\s*$/, "")
    .trim();

  const upstreamModel = UPSTREAM_MODEL_MAP[baseModel] || "qwen3.7-plus";
  return {
    upstreamModel,
    thinkingEnabled,
    searchEnabled,
    chatMode: searchEnabled ? "search" : "normal",
  };
}

function mapQwenUpstreamError(status, rawText) {
  const text = String(rawText || "");
  if (text === "NO_TOKEN" || status === 401) {
    return {
      status: 401,
      code: "QWEN_AUTH_EXPIRED",
      message: "Qwen Web session token missing or expired. Re-login via Dashboard -> Qwen Web.",
    };
  }
  if (text.includes("RGV587_ERROR") || text.includes("FAIL_SYS_USER_VALIDATE")) {
    return {
      status: 403,
      code: "QWEN_ANTI_BOT_CHALLENGE",
      message: "Alibaba anti-bot slider triggered (RGV587_ERROR). Use browser transport with a logged-in profile.",
    };
  }
  if (status === 429 || text.includes("rate_limit")) {
    return {
      status: 429,
      code: "QWEN_RATE_LIMIT",
      message: "Qwen Web rate limit reached. Retry after a short cooldown.",
    };
  }
  return {
    status: status && status >= 400 ? status : 502,
    code: `QWEN_UPSTREAM_${status || 502}`,
    message: text.slice(0, 300) || "Qwen Web upstream error",
  };
}

function formatMessagesForUiPrompt(messages, maxChars = 48000) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return "";
  if (list.length === 1 && list[0].role === "user") {
    return String(list[0].content || "").slice(0, maxChars);
  }

  const sys = [];
  const conv = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const content = String(m.content || "").trim();
    if (!content) continue;
    if (m.role === "system" || m.role === "developer") {
      sys.push(content);
    } else if (m.role === "assistant") {
      const safeAssistant = content.replace(/<tool>/g, "[[TOOL]]").replace(/<\/tool>/g, "[[/TOOL]]");
      conv.push(`Assistant:\n${safeAssistant}`);
    } else {
      conv.push(`User:\n${content}`);
    }
  }

  const sysBlock = sys.length > 0 ? `[System Instructions]\n${sys.join("\n\n")}\n\n` : "";
  const nonceMatch = sysBlock.match(/"_nonce":\s*"([a-f0-9]{8})"/i);
  const activeNonce = nonceMatch ? nonceMatch[1] : "";
  const toolFooter = activeNonce
    ? [
        "",
        "[CRITICAL TOOL EXECUTION MANDATE]",
        "- DO NOT merely describe what you are going to do! DO NOT stop after saying 'Let me check...' or 'Let me grab...' without calling the tool in the same response!",
        "- DO NOT use native server <tool_call> tokens (they fail with 'Tool <name> does not exists.').",
        "- When any action is required, output it as plain text using ONLY this exact bracket syntax:",
        `  [[TOOL]]{"name": "<tool_name>", "arguments": { ... }, "_nonce": "${activeNonce}"}[[/TOOL]]`,
      ].join("\n")
    : "";

  if (conv.length === 0) {
    return sysBlock.slice(0, Math.max(1000, maxChars - toolFooter.length)) + toolFooter;
  }
  if (conv.length === 1) {
    const rawLast = String(conv[0] || "").slice(0, Math.max(1000, maxChars - toolFooter.length - 200));
    const boundedSys = sysBlock
      ? sysBlock.slice(0, Math.max(2000, maxChars - rawLast.length - toolFooter.length - 100))
      : "";
    return boundedSys ? `${boundedSys}${rawLast}${toolFooter}` : `${rawLast}${toolFooter}`;
  }

  const lastTurn = conv[conv.length - 1];
  const historyTurns = conv.slice(0, -1);
  const budgetForHistory = Math.max(2000, maxChars - sysBlock.length - lastTurn.length - toolFooter.length - 200);

  const selectedHistory = [];
  let usedChars = 0;
  for (let i = historyTurns.length - 1; i >= 0; i--) {
    const turnStr = historyTurns[i];
    if (usedChars + turnStr.length > budgetForHistory && selectedHistory.length > 0) {
      break;
    }
    selectedHistory.unshift(turnStr);
    usedChars += turnStr.length + 2;
  }

  const parts = [];
  const boundedSys = sysBlock.slice(0, Math.max(4000, maxChars - lastTurn.length - toolFooter.length - 1000));
  if (boundedSys) parts.push(boundedSys.trim());
  if (selectedHistory.length > 0) {
    parts.push(`[Conversation Trajectory]\n${selectedHistory.join("\n\n")}`);
  }
  parts.push(`[Current Turn — Continue from trajectory above]\n${lastTurn}${toolFooter}`);
  return parts.join("\n\n");
}

module.exports = {
  createToolNonce,
  serializeQwenToolPrompt,
  repairLooseJson,
  parseQwenToolCalls,
  buildQwenAgentMessages,
  formatMessagesForUiPrompt,
  resolveQwenAgentOptions,
  mapQwenUpstreamError,
};
