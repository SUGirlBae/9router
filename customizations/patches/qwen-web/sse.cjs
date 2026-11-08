/**
 * Qwen Web SSE Parser - OpenAI-style streaming response parser
 * Handles: data: {"choices":[{"delta":{"content":"..."}}]}\n\n, data: [DONE], hint events
 */
"use strict";

function parseSSEChunk(chunk) {
  const lines = chunk.split("\n");
  const events = [];
  let currentEvent = null;
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        events.push({ type: "done" });
      } else {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0] && json.choices[0].delta) {
            events.push({ type: "delta", content: json.choices[0].delta.content || "" });
          } else if (json.type === "hint" || json.hint) {
            events.push({ type: "hint", data: json });
          } else {
            events.push({ type: "other", data: json });
          }
        } catch {
          events.push({ type: "raw", data });
        }
      }
    } else if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
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
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const events = parseSSEChunk(chunk);
        for (const ev of events) {
          yield ev;
        }
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

module.exports = { parseSSEChunk, streamCompletion };