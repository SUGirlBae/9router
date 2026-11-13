import { describe, expect, it, vi } from "vitest";
vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

describe("Antigravity Executor Uncapped Output", () => {
  const exec = new AntigravityExecutor();

  it("allows Claude-Antigravity requests up to 128,000 maxOutputTokens", () => {
    const out = exec.transformRequest("claude-sonnet-5-5", {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 100000 },
      },
    }, true, { projectId: "proj" });
    expect(out.request.generationConfig.maxOutputTokens).toBe(100000);
  });

  it("allows Gemini models up to 65,536 maxOutputTokens without clamp to 64000", () => {
    const out = exec.transformRequest("gemini-3.8-flash", {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 65536 },
      },
    }, true, { projectId: "proj" });
    expect(out.request.generationConfig.maxOutputTokens).toBe(65536);
  });

  it("allows claude-opus-4-6-thinking up to 128,000 maxOutputTokens", () => {
    const out = exec.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 128000 },
      },
    }, true, { projectId: "proj" });
    expect(out.request.generationConfig.maxOutputTokens).toBe(128000);
  });

  it("omits toolConfig when tools contain only googleSearch (no functionDeclarations)", () => {
    const out = exec.transformRequest("gemini-3.8-flash", {
      request: {
        contents: [{ role: "user", parts: [{ text: "search" }] }],
        tools: [{ googleSearch: {} }],
      },
    }, true, { projectId: "proj" });
    expect(out.request.tools).toEqual([{ googleSearch: {} }]);
    expect(out.request.toolConfig).toBeUndefined();
  });
});
