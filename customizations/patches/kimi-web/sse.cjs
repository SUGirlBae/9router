/**
 * Kimi Web SSE Parser - kimi event-stream format:
 *   data: {"event":"cmpl","text":"...","chat_id":...}
 *   data: {"event":"all_done"}
 * Also tolerates OpenAI-style delta chunks for forward-compat.
 */
"use strict";

function parseSSEChunk(chunk) {
  const events = [];
  for (const block of chunk.split("\n\n")) {
    let dataLine = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) dataLine = line.slice(5).trim();
    }
    if (dataLine === null) continue;
    if (dataLine === "[DONE]") { events.push({ type: "done" }); continue; }
    try {
      const j = JSON.parse(dataLine);
      if (j.event === "cmpl" || j.event === "cmp") {
        events.push({ type: "delta", content: j.text || j.content || "" });
      } else if (j.event === "all_done" || j.event === "done") {
        events.push({ type: "done" });
      } else if (j.event === "error" || j.type === "error") {
        events.push({ type: "hint", data: j });
      } else if (j.choices && j.choices[0] && j.choices[0].delta) {
        events.push({ type: "delta", content: j.choices[0].delta.content || "" });
      } else {
        events.push({ type: "other", data: j });
      }
    } catch {
      events.push({ type: "raw", data: dataLine });
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
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const p of parts) for (const ev of parseSSEChunk(p)) yield ev;
    }
    if (buffer.trim()) for (const ev of parseSSEChunk(buffer)) yield ev;
  } finally {
    reader.releaseLock();
  }
}

module.exports = { parseSSEChunk, streamCompletion };