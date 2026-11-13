import { describe, expect, it, vi } from "vitest";
vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";

describe("OpenAI to Antigravity Request Translation", () => {
  it("preserves temperature 0 on Claude-Antigravity models", () => {
    const out = openaiToAntigravityRequest("claude-sonnet-5-5", {
      model: "ag/claude-sonnet-5-5",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      max_tokens: 100000,
    });
    expect(out.request.generationConfig.temperature).toBe(0);
    expect(out.request.generationConfig.maxOutputTokens).toBe(100000);
  });

  it("reads max_completion_tokens and max_output_tokens on Gemini models", () => {
    const out = openaiToAntigravityRequest("gemini-3.8-flash", {
      model: "ag/gemini-3.8-flash",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 50000,
    });
    expect(out.request.generationConfig.maxOutputTokens).toBe(50000);
  });

  it("translates stop sequences into generationConfig.stopSequences", () => {
    const out = openaiToAntigravityRequest("gemini-3.8-flash", {
      model: "ag/gemini-3.8-flash",
      messages: [{ role: "user", content: "hi" }],
      stop: ["<|end|>", "STOP"],
    });
    expect(out.request.generationConfig.stopSequences).toEqual(["<|end|>", "STOP"]);
  });

  it("translates web search tool into native googleSearch tool", () => {
    const out = openaiToAntigravityRequest("gemini-3.8-flash", {
      model: "ag/gemini-3.8-flash",
      messages: [{ role: "user", content: "search this" }],
      tools: [{ type: "web_search" }],
    });
    expect(out.request.tools).toContainEqual({ googleSearch: {} });
  });

  it("preserves >64k max_tokens and sampling params when pivoting from Claude format", () => {
    const out = claudeToOpenAIRequest("claude-opus-4-6-thinking", {
      model: "ag/claude-opus-4-6-thinking",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100000,
      temperature: 0,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ["DONE"],
    });
    expect(out.max_tokens).toBe(100000);
    expect(out.temperature).toBe(0);
    expect(out.top_p).toBe(0.9);
    expect(out.top_k).toBe(40);
    expect(out.stop).toEqual(["DONE"]);
  });
});
