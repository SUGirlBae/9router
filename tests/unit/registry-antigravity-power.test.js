import { describe, expect, it } from "vitest";
import ag from "../../open-sse/providers/registry/antigravity.js";
import codex from "../../open-sse/providers/registry/codex.js";

describe("Registry models parity", () => {
  it("antigravity gemini-3.1-pro-high targets gemini-pro-agent(high)", () => {
    const m = ag.models.find(x => x.id === "gemini-3.1-pro-high");
    expect(m?.upstreamModelId).toBe("gemini-pro-agent(high)");
  });

  it("antigravity searchViaChat uses gemini-3.8-flash default model", () => {
    expect(ag.searchViaChat?.defaultModel).toBe("gemini-3.8-flash");
  });

  it("codex contains gpt-6.1-sol[1m] and gpt-6.1-terra[1m]", () => {
    const sol1m = codex.models.find(x => x.id === "gpt-6.1-sol[1m]");
    expect(sol1m).toBeTruthy();
    expect(sol1m.upstreamModelId).toBe("gpt-6.1-sol");
    const terra1m = codex.models.find(x => x.id === "gpt-6.1-terra[1m]");
    expect(terra1m).toBeTruthy();
    expect(terra1m.upstreamModelId).toBe("gpt-6.1-terra");
  });
});
