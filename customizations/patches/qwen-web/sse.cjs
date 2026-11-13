/**
 * Qwen Web Stateful SSE Parser & OpenAI Stream Transformer
 * Supports:
 * - Real-time incremental diffing for `phase: "thinking_summary"` -> `delta.reasoning_content`
 * - Real-time streaming for `phase: "answer"` -> `delta.content`
 * - Hybrid _nonce-bound `<tool>` parsing -> `delta.tool_calls` (`finish_reason: "tool_calls"`)
 * - Web search citations extraction (`extra.web_search_info`)
 * - Legacy `parseSSEChunk` & `streamCompletion` exports for backward compatibility
 */
"use strict";

const { parseQwenToolCalls } = require("./qwen-tools.cjs");

function parseSSEChunk(chunk) {
  const lines = String(chunk || "").split(/\r?\n/);
  const events = [];
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        events.push({ type: "done" });
      } else {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0] && json.choices[0].delta) {
            events.push({
              type: "delta",
              content: json.choices[0].delta.content || "",
              phase: json.choices[0].delta.phase || "answer",
              extra: json.choices[0].delta.extra || null,
            });
          } else if (json.type === "hint" || json.hint) {
            events.push({ type: "hint", data: json });
          } else {
            events.push({ type: "other", data: json });
          }
        } catch {
          events.push({ type: "raw", data });
        }
      }
    }
  }
  return events;
}

async function* streamCompletion(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const events = parseSSEChunk(chunk);
        for (const ev of events) yield ev;
      }
    }
    if (buffer.trim()) {
      const events = parseSSEChunk(buffer);
      for (const ev of events) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

function escapeMarkdownLinkText(text) {
  return String(text ?? "").replace(/([[\]])/g, "\\$1");
}

function formatCitationsMarkdown(citations) {
  if (!Array.isArray(citations) || citations.length === 0) return "";
  const seen = new Set();
  const lines = [];
  for (const c of citations) {
    const url = c?.url || c?.link;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = c?.title || c?.site_name || url;
    lines.push(`- [${escapeMarkdownLinkText(title)}](${url})`);
  }
  if (lines.length === 0) return "";
  return `\n\n---\n**Sources:**\n${lines.join("\n")}`;
}

function createQwenSSEParser(options = {}) {
  const model = options.model || "qwen3.7-plus";
  const nonce = options.nonce || "";
  const requestedTools = Array.isArray(options.requestedTools) ? options.requestedTools : [];
  const onWarn = typeof options.onWarn === "function" ? options.onWarn : null;
  const hasTools = requestedTools.length > 0;
  const maxToolBufferChars = options.maxToolBufferChars || 524288; // 512 KB cap
  const streamId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const created = Math.floor(Date.now() / 1000);

  let rawBuffer = "";
  let emittedRole = false;
  let emittedReasoning = "";
  let fullContent = "";
  let toolBuffer = "";
  let toolBufferOverflow = false;
  let bufferingForTools = hasTools;
  let finished = false;
  let sawFinishedSignal = false;
  let incomplete = false;
  let usage = null;
  let parsedToolCalls = null;
  const citations = [];

  function formatOpenAIChunk(delta, finishReason = null, extraTop = {}) {
    return `data: ${JSON.stringify({
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
      ...extraTop,
    })}\n\n`;
  }

  function ensureRole(out) {
    if (!emittedRole) {
      emittedRole = true;
      out.push(formatOpenAIChunk({ role: "assistant", content: "" }));
    }
  }

  function finalizeStream(out) {
    if (finished) return;
    finished = true;
    ensureRole(out);

    // Stream integrity: upstream ended WITHOUT a finished/[DONE] signal (dropped
    // session, anti-bot cut, network interruption). Surface as an error event so
    // the client does not treat partial content as a successful completion.
    if (!sawFinishedSignal) {
      incomplete = true;
      out.push(
        `data: ${JSON.stringify({
          error: {
            message:
              "Qwen Web stream ended before completion (no finished signal received) — likely a dropped session or upstream interruption. Retry the request.",
            type: "upstream_error",
            code: "QWEN_STREAM_INCOMPLETE",
          },
        })}\n\n`
      );
      out.push("data: [DONE]\n\n");
      return;
    }

    let finishReason = "stop";
    if (bufferingForTools && toolBuffer) {
      const parsed = parseQwenToolCalls(toolBuffer, nonce, requestedTools, { onWarn });
      if (parsed.content) {
        fullContent += parsed.content;
        out.push(formatOpenAIChunk({ content: parsed.content }));
      }
      if (Array.isArray(parsed.toolCalls) && parsed.toolCalls.length > 0) {
        parsedToolCalls = parsed.toolCalls;
        out.push(formatOpenAIChunk({ tool_calls: parsed.toolCalls }));
        finishReason = "tool_calls";
      }
    }

    const citationMd = formatCitationsMarkdown(citations);
    if (citationMd && finishReason !== "tool_calls") {
      fullContent += citationMd;
      out.push(formatOpenAIChunk({ content: citationMd }));
    }

    const extraTop = usage ? { usage } : {};
    out.push(formatOpenAIChunk({}, finishReason, extraTop));
    out.push("data: [DONE]\n\n");
  }

  function processEventBlock(block, out) {
    if (finished) return;
    let dataLine = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLine = line.slice(5).trim();
      }
    }
    if (!dataLine) return;
    if (dataLine === "[DONE]") {
      sawFinishedSignal = true;
      finalizeStream(out);
      return;
    }

    let j;
    try {
      j = JSON.parse(dataLine);
    } catch {
      return;
    }

    if (j["response.created"]) {
      ensureRole(out);
      return;
    }

    if (j.usage) {
      usage = j.usage;
    }

    if (j.event === "cmpl" || j.event === "cmp") {
      const txt = j.text || j.content || "";
      if (txt) {
        ensureRole(out);
        if (bufferingForTools) toolBuffer += txt;
        else {
          fullContent += txt;
          out.push(formatOpenAIChunk({ content: txt }));
        }
      }
      return;
    }

    if (j.event === "all_done" || j.event === "done") {
      sawFinishedSignal = true;
      finalizeStream(out);
      return;
    }

    const choice = j.choices && j.choices[0];
    const d = choice && choice.delta;
    if (!d) return;

    if (d.extra && Array.isArray(d.extra.web_search_info)) {
      citations.push(...d.extra.web_search_info);
    }
    if (d.extra && Array.isArray(d.extra.citations)) {
      citations.push(...d.extra.citations);
    }

    if (d.phase === "thinking_summary") {
      const thoughtArr = d.extra?.summary_thought?.content;
      if (Array.isArray(thoughtArr) && thoughtArr.length > 0) {
        const joinedThought = thoughtArr.join("\n");
        if (joinedThought.length > emittedReasoning.length) {
          const diff = joinedThought.slice(emittedReasoning.length);
          emittedReasoning = joinedThought;
          ensureRole(out);
          out.push(formatOpenAIChunk({ reasoning_content: diff }));
        }
      } else if (typeof d.content === "string" && d.content) {
        emittedReasoning += d.content;
        ensureRole(out);
        out.push(formatOpenAIChunk({ reasoning_content: d.content }));
      }
      return;
    }

    if (typeof d.content === "string" && d.content.length > 0) {
      ensureRole(out);
      if (hasTools && !bufferingForTools && (d.content.includes("<tool") || d.content.includes("[[TOOL") || d.content.includes("```"))) {
        bufferingForTools = true;
      }
      if (bufferingForTools) {
        if (!toolBufferOverflow && toolBuffer.length + d.content.length > maxToolBufferChars) {
          // Runaway buffer: flush what was held, stop tool parsing, stream the rest live
          toolBufferOverflow = true;
          if (toolBuffer) {
            fullContent += toolBuffer;
            out.push(formatOpenAIChunk({ content: toolBuffer }));
            toolBuffer = "";
          }
        }
        if (!toolBufferOverflow) {
          toolBuffer += d.content;
        } else {
          fullContent += d.content;
          out.push(formatOpenAIChunk({ content: d.content }));
        }
      } else {
        fullContent += d.content;
        out.push(formatOpenAIChunk({ content: d.content }));
      }
    }

    if ((d.status === "finished" && d.phase !== "thinking_summary") || choice.finish_reason) {
      sawFinishedSignal = true;
      finalizeStream(out);
    }
  }

  function pushChunk(chunkStr) {
    const out = [];
    rawBuffer += String(chunkStr || "");
    const parts = rawBuffer.split(/\r?\n\r?\n/);
    rawBuffer = parts.pop() || "";
    for (const block of parts) {
      if (block.trim()) processEventBlock(block, out);
    }
    return out;
  }

  function flush() {
    const out = [];
    if (rawBuffer.trim()) {
      processEventBlock(rawBuffer, out);
      rawBuffer = "";
    }
    if (!finished) {
      finalizeStream(out);
    }
    return out;
  }

  function getCollected() {
    return {
      content: fullContent,
      reasoningContent: emittedReasoning,
      toolCalls: parsedToolCalls,
      usage,
      citations,
      incomplete,
    };
  }

  return {
    pushChunk,
    flush,
    getCollected,
  };
}

function createOpenAIStreamFromChunks(asyncChunkIterable, parserOptions = {}) {
  const encoder = new TextEncoder();
  const parser = createQwenSSEParser(parserOptions);
  let iterator = null;
  let cancelled = false;

  return new ReadableStream({
    async start(controller) {
      try {
        iterator = asyncChunkIterable[Symbol.asyncIterator]();
        while (true) {
          if (cancelled) break;
          const { done, value } = await (iterator.read ? iterator.read() : iterator.next());
          if (done) break;
          if (cancelled) break;
          const events = parser.pushChunk(value);
          for (const ev of events) {
            if (cancelled) break;
            controller.enqueue(encoder.encode(ev));
          }
        }
        if (!cancelled) {
          const tail = parser.flush();
          for (const ev of tail) {
            if (cancelled) break;
            controller.enqueue(encoder.encode(ev));
          }
          controller.close();
        }
      } catch (err) {
        if (!cancelled) {
          controller.error(err);
        }
      }
    },
    async cancel() {
      cancelled = true;
      if (iterator && typeof iterator.return === "function") {
        try {
          await iterator.return();
        } catch {}
      }
    },
  });
}

module.exports = {
  parseSSEChunk,
  streamCompletion,
  createQwenSSEParser,
  createOpenAIStreamFromChunks,
  formatCitationsMarkdown,
};
