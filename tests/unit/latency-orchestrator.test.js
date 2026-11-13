import { describe, it, expect, beforeEach } from "vitest";
import {
  recordConnectionSuccess,
  recordConnectionFailure,
  getConnectionStats,
  isCircuitOpen,
  selectOptimalConnection,
  resetOrchestrator
} from "open-sse/services/latencyOrchestrator.js";

describe("Dynamic Latency-Aware Orchestrator & Circuit Breaker", () => {
  beforeEach(() => {
    resetOrchestrator();
  });

  it("updates EMA latency on successful requests", () => {
    recordConnectionSuccess("conn-1", 500);
    expect(getConnectionStats("conn-1").emaMs).toBe(500);

    recordConnectionSuccess("conn-1", 1000);
    // 0.7 * 500 + 0.3 * 1000 = 350 + 300 = 650
    expect(getConnectionStats("conn-1").emaMs).toBe(650);
  });

  it("opens circuit breaker after consecutive failures and recovers on success", () => {
    expect(isCircuitOpen("conn-bad")).toBe(false);

    recordConnectionFailure("conn-bad", 502);
    recordConnectionFailure("conn-bad", 502);
    expect(isCircuitOpen("conn-bad")).toBe(false); // threshold = 3

    recordConnectionFailure("conn-bad", 502);
    expect(isCircuitOpen("conn-bad")).toBe(true);

    // A successful probe closes the circuit immediately
    recordConnectionSuccess("conn-bad", 300);
    expect(isCircuitOpen("conn-bad")).toBe(false);
    expect(getConnectionStats("conn-bad").consecutiveFailures).toBe(0);
  });

  it("selects fastest healthy connection and skips open circuits", () => {
    const connections = [
      { id: "slow-acc", priority: 1 },
      { id: "fast-acc", priority: 2 },
      { id: "broken-acc", priority: 3 }
    ];

    recordConnectionSuccess("slow-acc", 4500);
    recordConnectionSuccess("fast-acc", 450);

    recordConnectionFailure("broken-acc", 503);
    recordConnectionFailure("broken-acc", 503);
    recordConnectionFailure("broken-acc", 503);

    const best = selectOptimalConnection(connections);
    expect(best.id).toBe("fast-acc");
  });

  it("fails open and returns best available when ALL circuits are open", () => {
    const connections = [{ id: "acc-1" }, { id: "acc-2" }];
    for (let i = 0; i < 3; i++) {
      recordConnectionFailure("acc-1", 429);
      recordConnectionFailure("acc-2", 429);
    }
    expect(isCircuitOpen("acc-1")).toBe(true);
    expect(isCircuitOpen("acc-2")).toBe(true);

    const selected = selectOptimalConnection(connections);
    expect(selected).toBeDefined();
    expect(["acc-1", "acc-2"]).toContain(selected.id);
  });
});
