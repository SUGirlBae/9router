import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { ZeroDowntimeGateway } from "../../customizations/gateway/9r-zero-downtime-gateway.js";

describe("Zero-Downtime Rolling Upgrade End-to-End Simulation", () => {
  let gateway;
  let workerA;
  let workerB;
  const PORT_GW = 29228;
  const PORT_A = 29231;
  const PORT_B = 29232;

  let workerAHealthy = true;
  let workerBHealthy = false;
  let streamCompletedOnA = false;

  beforeAll(async () => {
    workerA = http.createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(workerAHealthy ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: workerAHealthy, version: "v1" }));
        return;
      }
      if (req.url === "/long-stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: start-on-A\n\n");
        setTimeout(() => {
          res.write("data: middle-on-A\n\n");
        }, 250);
        setTimeout(() => {
          streamCompletedOnA = true;
          res.end("data: finish-on-A\n\n");
        }, 550);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ worker: "A" }));
    });
    await new Promise(r => workerA.listen(PORT_A, "127.0.0.1", r));

    workerB = http.createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(workerBHealthy ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: workerBHealthy, version: "v2" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ worker: "B" }));
    });
    await new Promise(r => workerB.listen(PORT_B, "127.0.0.1", r));

    gateway = new ZeroDowntimeGateway({
      port: PORT_GW,
      slotAPort: PORT_A,
      slotBPort: PORT_B,
      initialSlot: "A",
      drainTimeoutMs: 5000,
      healthTimeoutMs: 5000
    });
    await gateway.listen();
  });

  afterAll(async () => {
    await gateway.close();
    await new Promise(r => workerA.close(r));
    await new Promise(r => workerB.close(r));
  });

  it("achieves 0% dropped requests and completes in-flight streams during live upgrade from A to B", async () => {
    // 1. Start a long-running SSE stream on Worker A
    const longStreamPromise = fetch(`http://127.0.0.1:${PORT_GW}/long-stream`).then(async (res) => {
      expect(res.status).toBe(200);
      return await res.text();
    });

    // Wait 100ms so stream is actively running inside Worker A
    await new Promise(r => setTimeout(r, 100));
    expect(gateway.getStatus().inFlightA).toBe(1);

    // 2. Start continuous high-frequency client polling while rolling upgrade happens
    let running = true;
    const pollResults = [];
    const poller = (async () => {
      while (running) {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT_GW}/v1/chat`);
          const json = await r.json();
          pollResults.push({ status: r.status, worker: json.worker });
        } catch (err) {
          pollResults.push({ status: 0, error: err.message });
        }
        await new Promise(r => setTimeout(r, 25));
      }
    })();

    // 3. Trigger rolling upgrade (simulate Worker B taking 200ms to become healthy)
    const reloadPromise = gateway.triggerRollingReload(async () => {
      setTimeout(() => {
        workerBHealthy = true;
      }, 200);
      return null; // mock worker process managed by test
    });

    const reloadResult = await reloadPromise;
    expect(reloadResult.status).toBe("success");
    expect(reloadResult.switchedTo).toBe("B");

    // Let polling continue against Worker B for a moment
    await new Promise(r => setTimeout(r, 150));
    running = false;
    await poller;

    // 4. Verify the long stream that started on A finished completely without interruption
    const streamOutput = await longStreamPromise;
    expect(streamOutput).toContain("start-on-A");
    expect(streamOutput).toContain("middle-on-A");
    expect(streamOutput).toContain("finish-on-A");
    expect(streamCompletedOnA).toBe(true);

    // 5. Verify 0% failures across ALL continuous requests before, during, and after upgrade
    expect(pollResults.length).toBeGreaterThan(10);
    const failures = pollResults.filter(p => p.status !== 200);
    expect(failures).toEqual([]);

    const servedByA = pollResults.filter(p => p.worker === "A").length;
    const servedByB = pollResults.filter(p => p.worker === "B").length;
    expect(servedByA).toBeGreaterThan(0);
    expect(servedByB).toBeGreaterThan(0);
  });
});
