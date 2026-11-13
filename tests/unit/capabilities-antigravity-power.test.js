import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("Antigravity & Codex Model Capabilities Unleashed", () => {
  it("resolves full specs for claude-opus-4-6-thinking", () => {
    const caps = getCapabilitiesForModel("antigravity", "claude-opus-4-6-thinking");
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(128000);
    expect(caps.thinkingFormat).toBe("claude-adaptive");
    expect(caps.pdf).toBe(true);
  });

  it("enables PDF reading for all Gemini 4 and Gemini 3.8/3.7 models", () => {
    for (const m of ["gemini-4-argon-high", "gemini-3.8-flash-high", "gemini-3.7-flash"]) {
      const caps = getCapabilitiesForModel("antigravity", m);
      expect(caps.pdf, `${m} should support pdf`).toBe(true);
      expect(caps.maxOutput).toBe(65536);
      expect(caps.contextWindow).toBe(1048576);
    }
  });

  it("resolves reasoning and thinking for gemini-pro-agent and suffixed gemini-pro-agent(high)", () => {
    for (const id of ["gemini-pro-agent", "gemini-pro-agent(high)", "ag/gemini-pro-agent(high)"]) {
      const caps = getCapabilitiesForModel("antigravity", id);
      expect(caps.reasoning, `${id} reasoning`).toBe(true);
      expect(caps.thinkingFormat, `${id} format`).toBe("gemini-level");
      expect(caps.pdf, `${id} pdf`).toBe(true);
      expect(caps.maxOutput, `${id} maxOutput`).toBe(65536);
    }
  });

  it("resolves extended 1M context for gpt-6.1-sol[1m] and gpt-6.1-terra[1m]", () => {
    const sol1m = getCapabilitiesForModel("codex", "gpt-6.1-sol[1m]");
    expect(sol1m.contextWindow).toBe(872000);
    const terra1m = getCapabilitiesForModel("codex", "gpt-6.1-terra[1m]");
    expect(terra1m.contextWindow).toBe(872000);
  });

  it("resolves binary specs for gpt-oss-120b", () => {
    const caps = getCapabilitiesForModel("antigravity", "gpt-oss-120b-medium");
    expect(caps.contextWindow).toBe(131072);
    expect(caps.maxOutput).toBe(65536);
  });
});
