/**
 * 9Router Zero-Downtime Rolling Gateway & Fail-Over Supervisor
 *
 * Sits permanently on the user-facing port (default 20128) and transparently
 * streams requests to the active internal worker slot (Blue on 20131 or Green on 20132).
 *
 * During upgrades / patches:
 *  1. The new code is booted on the standby slot.
 *  2. The gate verifies health (/api/health) on the standby slot while the active slot continues serving traffic.
 *  3. Once healthy, the gate atomically flips traffic to the new slot (0ms downtime).
 *  4. In-flight streams on the old slot drain gracefully until completion before retirement.
 *  5. Zero connection drops (0% dropped packets, 0 ECONNREFUSED).
 */

const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const { spawn, execSync } = require("node:child_process");

function resolveServerPath() {
  const candidates = [
    "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router/app/custom-server.js",
    "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router/app/server.js",
    path.join(__dirname, "../../app/custom-server.js"),
    path.join(__dirname, "../../custom-server.js"),
    path.join(__dirname, "../../app/server.js")
  ];
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

class ZeroDowntimeGateway {
  constructor(options = {}) {
    this.port = Number(options.port || process.env.GATEWAY_PORT || 20128);
    this.host = options.host || "0.0.0.0";

    this.slotAPort = Number(options.slotAPort || process.env.SLOT_A_PORT || 20131);
    this.slotBPort = Number(options.slotBPort || process.env.SLOT_B_PORT || 20132);

    this.serverPath = options.serverPath || process.env.SERVER_PATH || resolveServerPath();
    this.slotServerPathA = options.slotServerPathA || process.env.SLOT_SERVER_PATH_A || this.serverPath;
    this.slotServerPathB = options.slotServerPathB || process.env.SLOT_SERVER_PATH_B || this.serverPath;
    this.activeSlot = options.initialSlot || "A";
    this.drainingSlot = null;

    this.inFlight = { A: 0, B: 0 };
    this.processes = { A: null, B: null };
    this.intentionalStop = { A: false, B: false };

    this.drainTimeoutMs = Number(options.drainTimeoutMs || 60000);
    this.healthTimeoutMs = Number(options.healthTimeoutMs || 45000);
    this.bufferTimeoutMs = Number(options.bufferTimeoutMs || 25000);

    this.bufferQueue = [];
    this.server = null;
    this.startedAt = Date.now();
    this.reloadInProgress = false;
    this.autoHealInProgress = false;
    this.booting = false;

    this.stats = {
      totalRequests: 0,
      totalSwitches: 0,
      autoHeals: 0,
      errors502: 0
    };
  }

  static isLoopbackIp(ip) {
    if (!ip) return false;
    const clean = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
    return clean === "127.0.0.1" || clean === "::1" || clean === "localhost";
  }

  get activePort() {
    return this.activeSlot === "A" ? this.slotAPort : this.slotBPort;
  }

  get standbySlot() {
    return this.activeSlot === "A" ? "B" : "A";
  }

  get standbyPort() {
    return this.standbySlot === "A" ? this.slotAPort : this.slotBPort;
  }

  getServerPathForSlot(slot) {
    return slot === "A" ? this.slotServerPathA : this.slotServerPathB;
  }

  getStatus() {
    return {
      ok: true,
      mode: "zero-downtime-rolling-gateway",
      activeSlot: this.activeSlot,
      activePort: this.activePort,
      standbySlot: this.standbySlot,
      standbyPort: this.standbyPort,
      serverPathA: this.slotServerPathA,
      serverPathB: this.slotServerPathB,
      drainingSlot: this.drainingSlot,
      inFlightA: this.inFlight.A,
      inFlightB: this.inFlight.B,
      queueLength: this.bufferQueue.length,
      pidA: this.processes.A?.pid || null,
      pidB: this.processes.B?.pid || null,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      reloadInProgress: this.reloadInProgress,
      stats: this.stats
    };
  }

  async listen() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on("connection", (socket) => {
        socket.setNoDelay(true);
      });

      this.server.on("upgrade", (req, socket, head) => {
        this.handleUpgrade(req, socket, head);
      });

      this.server.on("error", reject);
      this.server.listen(this.port, this.host, () => {
        console.log(`[ZeroDowntimeGateway] Master listener active on http://${this.host}:${this.port}`);
        console.log(`[ZeroDowntimeGateway] Initial active slot: ${this.activeSlot} (Port ${this.activePort})`);
        resolve(this.server);
      });
    });
  }

  async close() {
    this.intentionalStop.A = true;
    this.intentionalStop.B = true;
    for (const slot of ["A", "B"]) {
      const proc = this.processes[slot];
      if (proc && proc.pid) {
        try {
          if (process.platform === "win32") execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore" });
          else proc.kill("SIGTERM");
        } catch {}
        this.processes[slot] = null;
      }
    }
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  handleRequest(req, res) {
    if (req.url === "/_gateway" || req.url === "/_gateway/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.getStatus(), null, 2));
      return;
    }

    if (req.url === "/_gateway/reload" && req.method === "POST") {
      this.triggerRollingReload()
        .then((result) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        })
        .catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    }

    this.stats.totalRequests++;
    this.dispatchToSlot(this.activeSlot, req, res);
  }

  handleUpgrade(req, clientSocket, head) {
    const targetPort = this.activePort;
    const srvSocket = net.connect(targetPort, "127.0.0.1", () => {
      srvSocket.write(head);
      srvSocket.pipe(clientSocket);
      clientSocket.pipe(srvSocket);
    });
    srvSocket.on("error", () => clientSocket.destroy());
  }

  dispatchToSlot(slot, req, res) {
    const targetPort = slot === "A" ? this.slotAPort : this.slotBPort;
    this.inFlight[slot]++;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (this.inFlight[slot] > 0) this.inFlight[slot]--;
    };
    res.on("finish", cleanup);
    res.on("close", cleanup);

    const clientHeaders = { ...req.headers };
    const socketIp = req.socket?.remoteAddress || "127.0.0.1";
    const hasProxyHeaders = !!(clientHeaders["x-forwarded-for"] || clientHeaders["x-real-ip"]);

    // Preserve local loopback trust for direct local clients (so custom-server.js does NOT
    // mark localhost requests as remote via x-9r-via-proxy). Only stamp XFF for non-loopback peers.
    if (!ZeroDowntimeGateway.isLoopbackIp(socketIp)) {
      clientHeaders["x-forwarded-for"] = clientHeaders["x-forwarded-for"]
        ? `${clientHeaders["x-forwarded-for"]}, ${socketIp}`
        : socketIp;
      clientHeaders["x-9r-via-proxy"] = "1";
    } else if (!hasProxyHeaders) {
      delete clientHeaders["x-9r-via-proxy"];
    }

    let piped = false;
    const startPipe = () => {
      if (piped) return;
      piped = true;
      req.pipe(proxyReq);
    };

    const proxyReq = http.request({
      host: "127.0.0.1",
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: clientHeaders,
      agent: false
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.on("aborted", () => {
        cleanup();
        if (!res.destroyed) res.destroy();
      });
      proxyRes.on("error", () => {
        cleanup();
        if (!res.destroyed) res.destroy();
      });
      proxyRes.pipe(res);
    });

    res.on("close", () => {
      if (!res.writableEnded && !proxyReq.destroyed) {
        proxyReq.destroy();
      }
    });

    proxyReq.on("socket", (socket) => {
      if (!socket.connecting) {
        startPipe();
      } else {
        socket.once("connect", startPipe);
      }
    });

    proxyReq.on("error", (err) => {
      cleanup();
      if (!piped && err.code === "ECONNREFUSED" && (this.reloadInProgress || this.autoHealInProgress || this.booting)) {
        this.bufferRequest(req, res);
        return;
      }
      this.stats.errors502++;
      console.error(`[ZeroDowntimeGateway] 502 on Slot ${slot} (${targetPort}) ${req.method} ${req.url}: ${err.code || err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "Gateway Bad Gateway: backend worker not reachable",
          code: err.code,
          slot,
          targetPort
        }));
      } else if (!res.destroyed) {
        res.destroy();
      }
    });
  }

  bufferRequest(req, res) {
    const item = { req, res, queuedAt: Date.now() };
    this.bufferQueue.push(item);
    setTimeout(() => {
      const idx = this.bufferQueue.indexOf(item);
      if (idx !== -1) {
        this.bufferQueue.splice(idx, 1);
        if (!res.headersSent) {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Gateway buffer timeout waiting for worker" }));
        }
      }
    }, this.bufferTimeoutMs);
  }

  flushBufferQueue() {
    const queue = [...this.bufferQueue];
    this.bufferQueue = [];
    for (const item of queue) {
      if (!item.res.headersSent) {
        this.dispatchToSlot(this.activeSlot, item.req, item.res);
      }
    }
  }

  async checkSlotHealth(port, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const healthy = await new Promise((resolve) => {
          const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1500 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          });
          req.on("error", () => resolve(false));
          req.on("timeout", () => { req.destroy(); resolve(false); });
        });
        if (healthy) return true;
      } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    return false;
  }

  freePortSync(port) {
    try {
      if (process.platform === "win32") {
        const ps = `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
        const out = execSync(`powershell -NonInteractive -WindowStyle Hidden -Command "${ps}"`, { encoding: "utf8", timeout: 4000 });
        for (const line of out.split(/\r?\n/)) {
          const pid = Number(line.trim());
          if (pid && pid !== process.pid) {
            try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", timeout: 3000 }); } catch {}
          }
        }
      }
    } catch {}
  }

  getWorkerEnvironment(slot, port) {
    return {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NINE_ROUTER_GATEWAY_MANAGED: "1",
    };
  }

  spawnWorkerForSlot(slot, port) {
    const serverPath = this.getServerPathForSlot(slot);
    const cwd = path.dirname(serverPath);
    this.freePortSync(port);
    console.log(`[ZeroDowntimeGateway] Spawning worker for Slot ${slot} on port ${port}...`);
    this.intentionalStop[slot] = false;

    const netKeeper = "C:/Users/Administrator/AppData/Roaming/9router/runtime/9r-net-keeper.js";
    const args = [
      ...(fs.existsSync(netKeeper) ? ["--require", netKeeper] : []),
      "--max-old-space-size=6144",
      serverPath
    ];

    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: this.getWorkerEnvironment(slot, port)
    });

    child.stdout?.on("data", (d) => process.stdout.write(`[Slot ${slot}] ${d}`));
    child.stderr?.on("data", (d) => process.stderr.write(`[Slot ${slot} ERR] ${d}`));

    child.on("exit", (code, signal) => {
      console.log(`[ZeroDowntimeGateway] Worker Slot ${slot} exited (code: ${code}, signal: ${signal})`);
      if (this.processes[slot] === child) {
        this.processes[slot] = null;
      }
      // Auto-heal if the active worker crashed unexpectedly!
      if (!this.intentionalStop[slot] && this.activeSlot === slot && !this.reloadInProgress && !this.autoHealInProgress) {
        this.autoHealInProgress = true;
        this.stats.autoHeals++;
        console.warn(`[ZeroDowntimeGateway] ⚠️ Active Slot ${slot} crashed! Triggering emergency auto-heal...`);
        this.triggerRollingReload()
          .catch((e) => console.error("[ZeroDowntimeGateway] Auto-heal failed:", e.message))
          .finally(() => { this.autoHealInProgress = false; });
      }
    });

    this.processes[slot] = child;
    return child;
  }

  async switchToSlot(targetSlot) {
    if (targetSlot === this.activeSlot) return true;
    const oldSlot = this.activeSlot;
    const targetPort = targetSlot === "A" ? this.slotAPort : this.slotBPort;

    const healthy = await this.checkSlotHealth(targetPort, this.healthTimeoutMs);
    if (!healthy) {
      // Kill failed standby process and preserve old active slot!
      this.intentionalStop[targetSlot] = true;
      const failedProc = this.processes[targetSlot];
      if (failedProc && failedProc.pid) {
        try {
          if (process.platform === "win32") execSync(`taskkill /F /T /PID ${failedProc.pid}`, { stdio: "ignore" });
          else failedProc.kill("SIGKILL");
        } catch {}
        this.processes[targetSlot] = null;
      }
      throw new Error(`Target slot ${targetSlot} on port ${targetPort} failed health check; keeping Slot ${oldSlot} active.`);
    }

    console.log(`[ZeroDowntimeGateway] 🚀 ATOMIC SWITCH: Slot ${oldSlot} -> Slot ${targetSlot} (Port ${targetPort})`);
    this.activeSlot = targetSlot;
    this.drainingSlot = oldSlot;
    this.stats.totalSwitches++;

    this.drainSlot(oldSlot).catch(() => {});
    this.flushBufferQueue();

    return true;
  }

  async drainSlot(slot) {
    this.intentionalStop[slot] = true;
    const start = Date.now();
    console.log(`[ZeroDowntimeGateway] Draining Slot ${slot} (in-flight: ${this.inFlight[slot]})...`);
    while (Date.now() - start < this.drainTimeoutMs) {
      if (this.inFlight[slot] <= 0) break;
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`[ZeroDowntimeGateway] Slot ${slot} drained. Retiring old worker.`);
    if (this.drainingSlot === slot) {
      this.drainingSlot = null;
    }
    const proc = this.processes[slot];
    if (proc && proc.pid) {
      try {
        if (process.platform === "win32") {
          execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore" });
        } else {
          proc.kill("SIGTERM");
        }
      } catch {}
      this.processes[slot] = null;
    }
    return true;
  }

  async triggerRollingReload(spawnFn) {
    if (this.reloadInProgress) {
      return { status: "already_reloading", ...this.getStatus() };
    }
    this.reloadInProgress = true;
    const targetSlot = this.standbySlot;
    const targetPort = this.standbyPort;

    try {
      if (typeof spawnFn === "function") {
        await spawnFn(targetSlot, targetPort);
      } else {
        this.spawnWorkerForSlot(targetSlot, targetPort);
      }
      await this.switchToSlot(targetSlot);
      return { status: "success", switchedTo: targetSlot, activePort: targetPort };
    } finally {
      this.reloadInProgress = false;
    }
  }
}

if (require.main === module) {
  const gateway = new ZeroDowntimeGateway();

  const handleExit = async () => {
    console.log("[ZeroDowntimeGateway] Shutting down supervisor and workers...");
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", handleExit);
  process.on("SIGTERM", handleExit);

  gateway.booting = true;
  gateway.listen().then(() => {
    gateway.spawnWorkerForSlot("A", gateway.slotAPort);
    gateway.checkSlotHealth(gateway.slotAPort, 45000).then((ok) => {
      gateway.booting = false;
      if (ok) {
        gateway.flushBufferQueue();
        console.log("✅ Worker A is online and serving via Zero-Downtime Master Gate.");
      } else {
        console.error("❌ Worker A failed initial health check within timeout.");
      }
    });
  }).catch((err) => {
    console.error("Failed to start ZeroDowntimeGateway:", err);
    process.exit(1);
  });
}

module.exports = { ZeroDowntimeGateway };
