import { describe, expect, it, vi } from "vitest";
vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

describe("Image Generation & Search Param Empowerment", () => {
  const exec = new AntigravityExecutor();

  it("passes client sampling and seed to image generation request", () => {
    const out = exec.transformRequest("gemini-3.1-flash-image", {
      contents: [{ role: "user", parts: [{ text: "draw cat" }] }],
      temperature: 0.5,
      top_p: 0.8,
      seed: 12345,
      max_tokens: 16384,
    }, false, { projectId: "proj" });

    expect(out.request.generationConfig.temperature).toBe(0.5);
    expect(out.request.generationConfig.topP).toBe(0.8);
    expect(out.request.generationConfig.seed).toBe(12345);
    expect(out.request.generationConfig.maxOutputTokens).toBe(16384);
  });
});
