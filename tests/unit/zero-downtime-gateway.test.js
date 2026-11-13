import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { ZeroDowntimeGateway } from "../../customizations/gateway/9r-zero-downtime-gateway.js";

describe("9Router Zero-Downtime Rolling Gateway & Fail-Over", () => {
  let gateway;
  let mockWorkerA;
  let mockWorkerB;
  const PORT_GATEWAY = 29128;
  const PORT_WORKER_A = 29131;
  const PORT_WORKER_B = 29132;

  let workerARequestCount = 0;
  let workerBRequestCount = 0;

  beforeAll(async () => {
    // 1. Create Mock Worker A
    mockWorkerA = http.createServer((req, res) => {
      workerARequestCount++;
      if (req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, worker: "A" }));
        return;
      }
      if (req.url === "/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: chunk-1\n\n");
        setTimeout(() => {
          res.write("data: chunk-2\n\n");
          res.end("data: [DONE]\n\n");
        }, 100);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ msg: "from-worker-A", url: req.url, headers: req.headers }));
    });
    await new Promise((r) => mockWorkerA.listen(PORT_WORKER_A, "127.0.0.1", r));

    // 2. Create Mock Worker B
    mockWorkerB = http.createServer((req, res) => {
      workerBRequestCount++;
      if (req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, worker: "B" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ msg: "from-worker-B", url: req.url }));
    });
    await new Promise((r) => mockWorkerB.listen(PORT_WORKER_B, "127.0.0.1", r));

    // 3. Initialize Gateway pointing initially to Worker A
    gateway = new ZeroDowntimeGateway({
      port: PORT_GATEWAY,
      slotAPort: PORT_WORKER_A,
      slotBPort: PORT_WORKER_B,
      initialSlot: "A",
      drainTimeoutMs: 1000
    });
    await gateway.listen();
  });

  afterAll(async () => {
    await gateway.close();
    await new Promise((r) => mockWorkerA.close(r));
    await new Promise((r) => mockWorkerB.close(r));
  });

  it("transparently proxies requests to the active worker slot A and preserves loopback trust", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_GATEWAY}/v1/models`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.msg).toBe("from-worker-A");
    expect(data.headers["x-9r-via-proxy"]).toBeUndefined();
    expect(data.headers["x-forwarded-for"]).toBeUndefined();
    expect(workerARequestCount).toBe(1);
    expect(workerBRequestCount).toBe(0);
  });

  it("preserves streaming SSE responses without chunk corruption", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_GATEWAY}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: chunk-1");
    expect(text).toContain("data: chunk-2");
    expect(text).toContain("data: [DONE]");
  });

  it("performs atomic rolling switch from slot A to slot B with 0 downtime", async () => {
    // Check initial state
    const statusBefore = gateway.getStatus();
    expect(statusBefore.activeSlot).toBe("A");
    expect(statusBefore.activePort).toBe(PORT_WORKER_A);

    // Trigger atomic switch to B
    const switchSuccess = await gateway.switchToSlot("B");
    expect(switchSuccess).toBe(true);

    const statusAfter = gateway.getStatus();
    expect(statusAfter.activeSlot).toBe("B");
    expect(statusAfter.activePort).toBe(PORT_WORKER_B);

    // New request MUST go to Worker B
    const res = await fetch(`http://127.0.0.1:${PORT_GATEWAY}/v1/chat`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.msg).toBe("from-worker-B");
    expect(workerBRequestCount).toBeGreaterThan(0);
  });

  it("buffers POST requests with full JSON body intact while worker is booting", async () => {
    const PORT_BOOT_GW = 29328;
    const PORT_BOOT_A = 29331;
    const PORT_BOOT_B = 29332;
    let receivedBody = null;

    const bootGw = new ZeroDowntimeGateway({
      port: PORT_BOOT_GW,
      slotAPort: PORT_BOOT_A,
      slotBPort: PORT_BOOT_B,
      initialSlot: "A",
      bufferTimeoutMs: 5000
    });
    bootGw.booting = true;
    await bootGw.listen();

    // Send POST BEFORE worker A is listening!
    const payload = { model: "ag/gemini-3.8-flash", messages: [{ role: "user", content: "preserve-full-body" }] };
    const reqPromise = fetch(`http://127.0.0.1:${PORT_BOOT_GW}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    // Wait 120ms so request enters bufferQueue, then start Worker A
    await new Promise(r => setTimeout(r, 120));
    expect(bootGw.getStatus().queueLength).toBe(1);

    const lateWorker = http.createServer((req, res) => {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, echoed: receivedBody.model }));
      });
    });
    await new Promise(r => lateWorker.listen(PORT_BOOT_A, "127.0.0.1", r));

    bootGw.booting = false;
    bootGw.flushBufferQueue();

    const res = await reqPromise;
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.echoed).toBe("ag/gemini-3.8-flash");
    expect(receivedBody).toEqual(payload);

    await bootGw.close();
    await new Promise(r => lateWorker.close(r));
  });

  it("closes client response and clears in-flight count when backend aborts mid-stream", async () => {
    const PORT_ABORT_GW = 29428;
    const PORT_ABORT_A = 29431;
    const PORT_ABORT_B = 29432;

    const abortWorker = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: partial\n\n");
      setTimeout(() => {
        res.socket.destroy();
      }, 40);
    });
    await new Promise(r => abortWorker.listen(PORT_ABORT_A, "127.0.0.1", r));

    const abortGw = new ZeroDowntimeGateway({
      port: PORT_ABORT_GW,
      slotAPort: PORT_ABORT_A,
      slotBPort: PORT_ABORT_B,
      initialSlot: "A",
      drainTimeoutMs: 1000
    });
    await abortGw.listen();

    try {
      const outcome = await Promise.race([
        fetch(`http://127.0.0.1:${PORT_ABORT_GW}/api/usage/stream`).then(async (r) => {
          try { await r.text(); return "ended"; } catch { return "aborted"; }
        }),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 500))
      ]);

      expect(outcome).not.toBe("hung");
      await new Promise(r => setTimeout(r, 30));
      expect(abortGw.getStatus().inFlightA).toBe(0);
    } finally {
      await abortGw.close();
      await new Promise(r => abortWorker.close(r));
    }
  });
});
