// muse.ai ("hatch") bootstrap: cookies -> assigned VM -> admission token ->
// WebSocket URL. Everything here is plain HTTPS from Node; no browser, no
// Chromium. Field names and tolerances follow protocol-notes.md §E2/§E3/§E4/§E7.

"use strict";

const crypto = require("node:crypto");
const { GatewayError } = require("./gateway.cjs");

const SITE = "https://muse.ai";
const DEFAULT_LB_HOST = "hatch.metaaivm.com";
const NOISE_PATH = "/v1/noise";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function parseCookieInput(input) {
  const jar = new Map();
  if (!input) return jar;
  const pairs = typeof input === "string" ? input.split(";") : Array.from(input);
  for (const entry of pairs) {
    if (Array.isArray(entry)) {
      if (entry[0] && entry[1]) jar.set(String(entry[0]).trim(), String(entry[1]).trim());
      continue;
    }
    if (entry && typeof entry === "object") {
      if (entry.name && entry.value) jar.set(entry.name, entry.value);
      continue;
    }
    const text = String(entry);
    const i = text.indexOf("=");
    if (i <= 0) continue;
    const name = text.slice(0, i).trim();
    const value = text.slice(i + 1).trim();
    if (name && value) jar.set(name, value);
  }
  return jar;
}

class MuseSession {
  constructor(opts = {}) {
    this.cookies = parseCookieInput(opts.cookies);
    this.label = opts.label || "muse";
    this.log = opts.log || (() => {});
    this.site = opts.site || SITE;
    this.userAgent = opts.userAgent || DEFAULT_UA;
    this.fetch = opts.fetch || globalThis.fetch;
    this.onRotate = opts.onRotate || null; // (jar: Map) => void | Promise<void>
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.missingRequired();
  }

  // hatch_sess is the only cookie that has no substitute (protocol-notes.md §E2).
  missingRequired() {
    return this.cookies.has("hatch_sess") ? null : "hatch_sess";
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  _harvest(res) {
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const rotated = [];
    for (const raw of list) {
      const [pair] = String(raw).split(";");
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || this.cookies.get(name) === value) continue;
      this.cookies.set(name, value);
      rotated.push(name);
    }
    if (rotated.length && this.onRotate) {
      Promise.resolve(this.onRotate(this.cookies)).catch((err) => this.log("cookie persist failed", err.message));
    }
    return rotated;
  }

  async call(method, path, { body, referer = `${this.site}/`, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.site + path, {
        method,
        headers: {
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          Origin: this.site,
          Referer: referer,
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
          Pragma: "no-cache",
          "Cache-Control": "no-cache",
          "User-Agent": this.userAgent,
          Cookie: this.cookieHeader(),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new GatewayError("upstream", `muse.ai ${method} ${path} failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    const rotated = this._harvest(res);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* an HTML error page is not JSON */
    }
    return { status: res.status, json, text, rotated };
  }

  async renew() {
    const res = await this.call("GET", "/api/session?vm_state=live", { referer: `${this.site}/thread/new` });
    if (res.status === 401) throw new GatewayError("auth", `${this.label}: muse.ai rejected the stored session (401)`, { status: 401 });
    if (res.status === 403) throw new GatewayError("access", `${this.label}: muse.ai refused the session (403)`, { status: 403 });
    if (res.status >= 400) throw new GatewayError("upstream", `${this.label}: /api/session -> ${res.status} ${res.text.slice(0, 160)}`, { status: res.status });
    const data = res.json || {};
    if (data.status !== "assigned" || !data.vm_id) {
      throw new GatewayError("upstream", `${this.label}: no VM assigned (status=${data.status} issue=${data.vm_resolution_issue || "none"})`, {
        sessionStatus: data.status,
      });
    }
    return {
      vmId: data.vm_id,
      endpointUrl: data.endpoint_url,
      vmState: data.vm_state,
      vmType: data.vm_type,
      raw: data,
    };
  }

  // A wake for an already-RUNNING VM answers 403; that is success, not failure,
  // so the verdict always comes from the session state (protocol-notes.md §E3).
  async wake(vmId) {
    const res = await this.call("POST", "/api/hatch/vm/wake", {
      body: { vm_id: vmId, retry_count: 0, connect_attempt_id: crypto.randomUUID() },
      referer: `${this.site}/thread/new`,
    });
    if (res.status >= 500) {
      throw new GatewayError("upstream", `${this.label}: /api/hatch/vm/wake -> ${res.status}`, { status: res.status });
    }
    return res.status;
  }

  async ensureRunning({ budgetMs = 45000, pollMs = 2000, settleMs = 1400 } = {}) {
    let session = await this.renew();
    if (session.vmState === "RUNNING") return { session, woke: false, waitedMs: 0 };
    if (session.vmState === "DISABLED") {
      throw new GatewayError("policy", `${this.label}: the account's VM is DISABLED; wake is not possible`, { vmState: session.vmState });
    }
    await this.wake(session.vmId);
    const started = Date.now();
    while (Date.now() - started < budgetMs) {
      await sleep(pollMs);
      session = await this.renew();
      if (session.vmState === "RUNNING") break;
    }
    if (session.vmState !== "RUNNING") {
      throw new GatewayError("timeout", `${this.label}: VM still ${session.vmState} after ${budgetMs}ms`, { vmState: session.vmState });
    }
    // The noise listener binds a moment after the control plane says RUNNING;
    // without this the WS upgrade intermittently fails with 502.
    await sleep(settleMs);
    return { session, woke: true, waitedMs: Date.now() - started };
  }

  async tokens(vm) {
    const res = await this.call("POST", "/api/hatch/token", {
      body: { vmAddress: vm.endpointUrl, vmName: vm.vmId },
      referer: `${this.site}/thread/new`,
    });
    if (res.status === 403) {
      // Stale hatch_vml is the documented cause: renew once, then retry.
      await this.renew();
      return this.tokens(vm);
    }
    if (res.status >= 400 || !res.json || !res.json.token) {
      throw new GatewayError("auth", `${this.label}: /api/hatch/token -> ${res.status} ${res.text.slice(0, 120)}`, { status: res.status });
    }
    const notary = await this.notaryToken(vm).catch(() => null);
    return { authToken: res.json.token, notaryToken: res.json.notary_token || notary };
  }

  async notaryToken(vm) {
    const res = await this.call("POST", "/api/hatch/noise-notary-token", {
      body: { vmName: vm.vmId },
      referer: `${this.site}/thread/new`,
    });
    return res.json ? res.json.notaryToken || null : null;
  }

  // The per-VM host in endpoint_url does NOT accept the upgrade (it is reachable
  // but refuses); the shared load balancer routes by vm_id and answers 101.
  // Measured 2026-11-03: wss://hatch.metaaivm.com/v1/noise -> handshake OK,
  // while wss://<vm_id>.metaaivm.com/v1/noise -> socket error.
  wsUrl(vm, token, { notaryToken, requestId = crypto.randomUUID(), lbHost = process.env.MUSE_LB_HOST || DEFAULT_LB_HOST } = {}) {
    const url = new URL(NOISE_PATH, `wss://${lbHost}`);
    url.searchParams.set("vm_id", vm.vmId);
    url.searchParams.set("auth_token", token);
    url.searchParams.set("app_id", process.env.MUSE_APP_ID || "hatch-web");
    url.searchParams.set("request_id", requestId);
    if (notaryToken) url.searchParams.set("notary_token", notaryToken);
    return url.toString();
  }

  // Never leak a cookie or token: this is what goes into logs.
  safeDescribe() {
    return {
      label: this.label,
      cookieNames: [...this.cookies.keys()].sort(),
      missing: this.missingRequired(),
    };
  }
}

function originOf(endpointUrl) {
  // /api/session hands back a bare host with no scheme, and the tunnel is always
  // TLS, so any scheme that does arrive is dropped rather than trusted.
  const text = String(endpointUrl || "").trim();
  if (!text) return "wss://hatch.metaaivm.com";
  const host = text.split("://").pop().split("/")[0];
  if (!host) return "wss://hatch.metaaivm.com";
  return "wss://" + host;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { MuseSession, parseCookieInput, sleep, originOf, DEFAULT_UA };
