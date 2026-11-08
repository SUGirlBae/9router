#!/usr/bin/env node
"use strict";
// Hedge gateway for 9router web providers (qoder / deepseek-web / ...).
//
// Measured behaviour of 9router 0.5.x on qoder, which this works around:
//   - requests are NOT serialised: 3-4 concurrent calls each finish in ~1s, so parallel
//     sub-agents are fine in principle
//   - ~30% of upstream attempts die with transport-level "fetch failed" (seen once as
//     ENOTFOUND api3.qoder.sh); the router keeps its own HTTP response closed until an
//     attempt produces bytes, so the caller sees a silent stall of 45-450s, not an error
//   - the router's only guard is transport stallTimeoutMs=120000, a single idle timer that
//     also protects legitimately long generations, so shortening it inside the router would
//     truncate real answers
//
// Policy here: two different clocks.
//   firstByteMs (default 6000) - no real output yet  -> abandon this attempt and start the
//                                                      next one; 9router round-robins to a
//                                                      different connection each time, so a
//                                                      hedge lands on a healthy account
//   idleMs      (default 90000) - output already flowing -> stay generous, agent answers
//                                                      legitimately pause between chunks
// A response is only handed to the client once it contains real output (content /
// reasoning_content / tool_calls), so an empty upstream turn can never be delivered as a
// successful-but-blank reply. Exactly one attempt wins; losers are aborted, so a turn costs
// at most 1 + a small number of wasted upstream calls.
//
// Client config: point the CLI at http://127.0.0.1:20129 instead of :20128.
// Start with the dns keeper preloaded to also survive resolver blips locally:
//   node --require ./9r-net-keeper.js 9r-hedge-gateway.js

const http = require("http");
const fs = require("fs");
const path = require("path");

const LISTEN_PORT = Number(process.env.PORT || 20129);
const UP_HOST = process.env.UPSTREAM_HOST || "127.0.0.1";
const UP_PORT = Number(process.env.UPSTREAM_PORT || 20128);
const FIRST_BYTE_MS = Number(process.env.HEDGE_FIRST_BYTE_MS || 6000);
const IDLE_MS = Number(process.env.HEDGE_IDLE_MS || 90000);
const MAX_ATTEMPTS = Number(process.env.HEDGE_MAX_ATTEMPTS || 3);
const TOTAL_BUDGET_MS = Number(process.env.HEDGE_TOTAL_BUDGET_MS || 180000);
const LOG_FILE = path.join(__dirname, "hedge-gateway.log");
const CHAT_RE = /^\/v1\/(chat\/completions|messages|responses)(\?|$)/;

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

const stats = { req: 0, hedged: 0, ok: 0, failed: 0, attempts: 0, transient: 0, byModel: {}, startedAt: new Date().toISOString() };
function tally(model, ok) {
  const b = (stats.byModel[model] = stats.byModel[model] || { ok: 0, fail: 0 });
  ok ? b.ok++ : b.fail++;
}

// A model the accounts are not provisioned for (403 code 112, catalog miss) does not just
// fail — 9router keeps rotating accounts behind a held response, and that stalls healthy
// requests sharing the same pool. So after two consecutive duds the model is short-circuited
// for a cooldown and the caller gets an instant, specific answer instead of a hung turn.
const breaker = new Map();
const BREAK_FAILS = Number(process.env.HEDGE_BREAK_TRIPS || 2);
const BREAK_MS = Number(process.env.HEDGE_BREAK_MS || 120000);
// Only a model-specific rejection belongs in the breaker. A resolver/transport blip
// (ENOTFOUND, "fetch failed", 502/503) hits every model at once, and locking healthy models
// out for minutes would turn a 20-second network glitch into an outage.
const MODEL_SPECIFIC = /not yet known|model_config|pricingUrl|"code":"?112|does not exist|unsupported model|invalid model|No credentials for provider/i;
const EXHAUST_TRIPS = Number(process.env.HEDGE_EXHAUST_TRIPS || 2);
const EXHAUST_MS = Number(process.env.HEDGE_EXHAUST_MS || 30000);
function trip(model, why, kind) {
  const specific = MODEL_SPECIFIC.test(why || "");
  if (!specific && kind !== "exhausted") { stats.transient++; return; }
  const b = breaker.get(model) || { fails: 0, openUntil: 0, why: "" };
  b.fails++; b.why = why;
  const cap = specific ? BREAK_FAILS : EXHAUST_TRIPS;
  b.kind = specific ? "not-provisioned" : "no-output";
  if (b.fails >= cap) {
    const ms = specific ? BREAK_MS : EXHAUST_MS;
    b.openUntil = Date.now() + ms;
    log(`BREAK open ${model} for ${ms / 1000}s (${b.kind}) :: ${String(why).slice(0, 150)}`);
  }
  breaker.set(model, b);
}
function reset(model) { const b = breaker.get(model); if (b && b.fails) { b.fails = 0; b.openUntil = 0; } }
function blocked(model) {
  const b = breaker.get(model);
  if (!b || !b.openUntil) return null;
  if (Date.now() >= b.openUntil) { breaker.set(model, { fails: 0, openUntil: 0, why: b.why }); return null; }
  return b;
}

// ---- per-model account lanes ----------------------------------------------------------
// Qoder entitlements are per account: qfmodel serves on all four, while auto/ultimate/
// gfmodel/cmodel only work on one and answer 403 {"code":"112",...} on the rest. 9router
// rotates connections blindly, so those models succeed only when the rotation happens to
// land right. Since the patched chat dispatch honours x-connection-id, this gateway pins
// deliberately: it probes untested connections once per model, remembers which ones answer,
// and afterwards round-robins only across the healthy subset.
const DB_PATH = process.env.NINE_R_DB || "C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite";
const DB_MODULE = process.env.NINE_R_SQLITE || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3";
const LANES_FILE = process.env.HEDGE_LANES_FILE || path.join(__dirname, "hedge-lanes.json");
// Pinning is off by default. qd/qfmodel is free and served by every account, so the router's
// own round-robin is the better policy: it spreads parallel load instead of concentrating it
// on one account. HEDGE_PIN=1 re-enables the per-model lanes for credit-billed models.
const PIN = process.env.HEDGE_PIN === "1";
const ALIAS = Object.assign({ qd: "qoder", qdcn: "qoder-cn", dsw: "deepseek-web" },
  JSON.parse(process.env.HEDGE_ALIAS || "{}"));

let inventory = {};
function loadInventory() {
  if (!PIN) return;
  try {
    const D = require(DB_MODULE);
    const db = new D(DB_PATH, { readonly: true });
    const rows = db.prepare("select id,provider,name,email from providerConnections where isActive=1 order by provider,priority").all();
    db.close();
    const next = {};
    for (const r of rows) (next[r.provider] = next[r.provider] || []).push({ id: r.id, label: (r.email || r.name || r.id.slice(0, 8)).split("@")[0] });
    inventory = next;
  } catch (e) { log(`inventory unavailable, pinning off: ${e.message}`); }
}
loadInventory();
setInterval(loadInventory, 60000).unref?.();

const LANE_TTL_MS = Number(process.env.HEDGE_LANE_TTL_MS || 900000);       // re-check a pinned lane after 15m
const LANE_PROBE_AFTER = Number(process.env.HEDGE_LANE_PROBE_AFTER || 2);  // rotated duds before probing accounts
const LANE_BLOCK_MS = Number(process.env.HEDGE_LANE_BLOCK_MS || 300000);   // "nothing serves this model" cooldown

// Lane modes, in order of preference:
//   auto    no pin at all — 9router rotates accounts, which spreads parallel load best.
//   probe   the model keeps dying under rotation, so pin successive attempts to successive
//           connections to find out whether exactly one of them is entitled to it.
//   pinned  a serving connection is known; use it until the TTL expires, then go auto again.
//   blocked every connection was probed and none serves it — answer instantly instead of
//           spending 36s per request and stalling the shared pool.
const lanes = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(LANES_FILE, "utf8"))))
    lanes.set(k, { mode: v.mode || "auto", ok: v.ok || [], bad: v.bad || {}, tested: v.tested || [], duds: v.duds || 0, until: v.until || 0, rr: 0 });
} catch { /* first run: no lane file yet */ }
function flushLanes() {
  const out = {};
  for (const [m, l] of lanes) out[m] = { mode: l.mode, ok: l.ok, bad: l.bad, tested: l.tested, duds: l.duds, until: l.until };
  try { fs.writeFileSync(LANES_FILE, JSON.stringify(out, null, 1)); } catch {}
}
// Written straight away: a debounced save can be lost, and on Windows a killed process never
// reaches an exit handler. Lane updates are rare (a handful per model), so this stays cheap.
const saveLanes = flushLanes;
process.on("exit", flushLanes);
function laneFor(model) {
  let l = lanes.get(model);
  if (!l) { l = { mode: "auto", ok: [], bad: {}, tested: [], duds: 0, until: 0, rr: 0 }; lanes.set(model, l); }
  if (l.until && l.mode !== "blocked" && Date.now() > l.until) { l.mode = "auto"; l.ok = []; l.tested = []; l.duds = 0; l.until = 0; }
  return l;
}
const providerOf = (model) => {
  const p = String(model).includes("/") ? String(model).split("/")[0] : null;
  return p ? ALIAS[p] || p : null;
};
function connLabel(id) {
  if (!id) return "router-rotates";
  if (id === "BLOCKED") return "no-connection-serves-this-model";
  for (const list of Object.values(inventory)) { const c = list.find((x) => x.id === id); if (c) return c.label; }
  return String(id).slice(0, 8);
}

// Which connection should this attempt use? null means "let 9router rotate".
function pickConnection(model, attemptNo) {
  const prov = providerOf(model);
  const pool = (inventory[prov] || []).map((c) => c.id);
  if (!PIN || pool.length < 2) return { id: null, prov };
  const l = laneFor(model);
  if (l.mode === "blocked") { if (Date.now() >= l.until) { l.mode = "auto"; l.tested = []; l.duds = 0; l.until = 0; saveLanes(); } else return { id: "BLOCKED", prov }; }
  if (l.mode === "pinned") {
    const live = l.ok.filter((id) => pool.includes(id));
    if (live.length) return { id: live[l.rr++ % live.length], prov };
    l.mode = "auto";
  }
  if (l.mode === "probe") {
    // untested[0] advances on its own because every failed probe is appended to l.tested
    const untested = pool.filter((id) => !l.tested.includes(id));
    if (untested.length) return { id: untested[0], prov };
    if (!l.ok.length) { l.mode = "blocked"; l.until = Date.now() + LANE_BLOCK_MS; log(`lane ${model}: probed ${pool.length} connections, none serves it — blocking ${LANE_BLOCK_MS / 1000}s`); saveLanes(); return { id: "BLOCKED", prov }; }
    l.mode = "pinned";
  }
  return { id: null, prov };
}
// While probing, one attempt per connection is needed before the lane can conclude, and each
// probe only has to answer or not — a flat short deadline is enough. Patience (the escalating
// deadline) is reserved for the auto and pinned modes, where a slow first token is legitimate.
function attemptsFor(model) {
  const l = laneFor(model);
  if (l.mode !== "probe") return MAX_ATTEMPTS;
  return Math.max(MAX_ATTEMPTS, (inventory[providerOf(model)] || []).length);
}
function recordResult(model, connId, out) {
  if (!connId || connId === "BLOCKED") return;
  const l = laneFor(model);
  if (!l.tested.includes(connId)) l.tested.push(connId);
  if (out.ok) {
    if (!l.ok.includes(connId)) l.ok.unshift(connId);
    delete l.bad[connId];
    if (l.mode === "probe" && l.ok.length) { l.mode = "pinned"; l.until = Date.now() + LANE_TTL_MS; log(`lane ${model}: pinned to ${connLabel(connId)} for ${LANE_TTL_MS / 60000}m`); }
    l.duds = 0;
  } else if (MODEL_SPECIFIC.test(out.text || "")) {
    l.bad[connId] = { planGated: true, why: summarizeFailure(out.text, out.status).slice(0, 150) };
  }
  saveLanes();
}
// Called when a whole request (all attempts) produced nothing.
function laneExhausted(model) {
  if (!PIN || (inventory[providerOf(model)] || []).length < 2) return;   // no pinning, so lanes have nothing to say
  const l = laneFor(model);
  const pool = (inventory[providerOf(model)] || []).map((c) => c.id);
  if (l.mode === "auto") {
    if (++l.duds >= LANE_PROBE_AFTER) { l.mode = "probe"; l.tested = l.ok.slice(); log(`lane ${model}: ${l.duds} dead turns under rotation -> probing ${pool.length} connections`); }
  } else if (l.mode === "pinned") {
    log(`lane ${model}: pinned connection(s) [${l.ok.map(connLabel).join(", ")}] produced nothing -> back to rotation`);
    l.mode = "auto"; l.ok = []; l.tested = []; l.duds = 1;
  }
  saveLanes();
}

function hasRealOutput(t) {
  return /"content"\s*:\s*"[^"]/.test(t)
    || /"reasoning_content"\s*:\s*"[^"]/.test(t)
    || /"tool_calls"\s*:\s*\[\s*\{/.test(t)
    || /"arguments"\s*:\s*"[^"]{2,}/.test(t);
}
function summarizeFailure(text, status) {
  const raw = String(text || "").replace(/\s+/g, " ");
  try {
    const j = JSON.parse(raw);
    const m = j?.error?.message || j?.message;
    if (m) return `${status || ""} ${String(m).slice(0, 200)}`.trim();
  } catch { /* not a single JSON body — fall through to patterns */ }
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.){0,200})/.exec(raw);
  if (m) return `${status || ""} ${m[1]}`.trim();
  const hint = /backend_busy|no FINISHED signal|not yet known|fetch failed|No active credentials|invalid_api_key|Login expired/i.exec(raw);
  return hint ? `${status || ""} upstream ${hint[0]}`.trim() : `${status || ""} ${raw.slice(0, 160)}`.trim();
}

// One upstream attempt. Resolves {promoted:true} once the client has been answered, or
// {promoted:false, why, text} when this attempt produced nothing usable.
// firstDeadline grows with the attempt number: the fast retries keep a stalled account from
// blocking the turn, while the last attempt is patient enough for models that legitimately
// take 10s+ to emit their first token (qd/gfmodel, qd/cmodel).
function attempt(reqPath, bodyBuf, headers, clientRes, attemptNo, shared, firstDeadline, connId) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let buf = "", promoted = false, settled = false, idleTimer = null, firstTimer = null;
    const clearTimers = () => { if (idleTimer) clearTimeout(idleTimer); if (firstTimer) clearTimeout(firstTimer); };
    const finish = (out) => {
      if (settled) return;
      settled = true; clearTimers();
      if (!out.promoted) { for (const s of shared.sockets) { try { s.destroy(); } catch {} } }
      resolve(out);
    };

    // 9router keeps the response (headers included) closed until an attempt produces bytes,
    // so the "this attempt is dead" clock has to run from send time, not from first byte.
    firstTimer = setTimeout(() => finish({ promoted: false, why: "no-first-output", text: buf }), firstDeadline);
    const releaseFirstClock = () => { if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; } };

    const up = http.request(
      {
        host: UP_HOST, port: UP_PORT, path: reqPath, method: "POST",
        headers: { ...headers, "content-length": bodyBuf.length, ...(connId ? { "x-connection-id": connId } : {}) },
      },
      (res) => {
        res.setEncoding("utf8");

        if ((res.statusCode || 0) >= 400) {
          let err = "";
          res.on("data", (d) => { err += d; if (err.length > 40000) err = err.slice(-40000); });
          res.on("end", () => finish({ promoted: false, why: "http", text: err, status: res.statusCode }));
          res.on("error", () => finish({ promoted: false, why: "stream-err", text: err, status: res.statusCode }));
          return;
        }

        // stage 1: hold the response until real output appears
        const onData = (d) => {
          buf += d;
          if (buf.length > 200000) buf = buf.slice(-160000);
          if (!promoted && !hasRealOutput(buf)) return;
          if (!promoted) {
            promoted = true;
            releaseFirstClock();
            if (shared.winner !== undefined && shared.winner !== attemptNo) return finish({ promoted: false, why: "already-won", text: buf });
            shared.winner = attemptNo;
            clientRes.writeHead(res.statusCode || 200, {
              "content-type": res.headers["content-type"] || "text/event-stream",
              "cache-control": "no-cache",
              "x-hedge-attempts": String(attemptNo + 1),
              connection: "keep-alive",
            });
            clientRes.write(buf);
            shared.result = { ok: true, attempt: attemptNo + 1 };
            stats.ok++; tally(shared.model, true); reset(shared.model);
            recordResult(shared.model, connId, { ok: true });
            log(`A${attemptNo + 1} promote ${((Date.now() - t0) / 1000).toFixed(1)}s model=${shared.model} conn=${connLabel(connId)} bytes=${buf.length}`);
            // stage 2: stream through on one continuous listener, generous idle clock
            idleTimer = setTimeout(() => { try { clientRes.end(); } catch {} finish({ promoted: true, why: "idle-after-start", text: buf.slice(-400) }); }, IDLE_MS);
          } else {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => { try { clientRes.end(); } catch {} finish({ promoted: true, why: "idle-after-start", text: buf.slice(-400) }); }, IDLE_MS);
            clientRes.write(d);
          }
        };
        res.on("data", onData);
        res.on("end", () => {
          if (promoted) { try { clientRes.end(); } catch {} return finish({ promoted: true, why: "upstream-end" }); }
          finish({ promoted: false, why: hasRealOutput(buf) ? "late-real" : "empty", text: buf });
        });
        res.on("error", () => finish({ promoted: promoted, why: "stream-err", text: buf.slice(-400) }));
      }
    );
    up.on("error", (e) => finish({ promoted, why: "up-err", text: (e.cause?.message || e.message || "").slice(0, 300) }));
    up.setTimeout(IDLE_MS, () => { up.destroy(); finish({ promoted, why: "socket-idle-timeout", text: buf.slice(-400) }); });
    shared.sockets.push(up);
    up.end(bodyBuf);
  });
}

function hedgeProxy(clientReq, clientRes, bodyBuf, model) {
  const shared = { winner: undefined, sockets: [], model, result: null };
  const t0 = Date.now();
  const failures = [];
  let blockedByLane = false;
  const headers = { ...clientReq.headers, host: `${UP_HOST}:${UP_PORT}` };
  delete headers["content-length"]; delete headers["connection"]; delete headers["accept-encoding"];
  // a cancelled sub-agent must not leave the upstream stream burning an account slot
  clientRes.on("close", () => { if (!shared.result) for (const s of shared.sockets) { try { s.destroy(); } catch {} } });
  clientRes.on("error", () => {});

  (async () => {
    for (let i = 0; i < attemptsFor(model); i++) {
      if (Date.now() - t0 > TOTAL_BUDGET_MS) break;
      if (shared.winner !== undefined) return;
      const pick = pickConnection(model, i);
      if (pick.id === "BLOCKED") {
        blockedByLane = true;
        failures.push(`no ${pick.prov} connection serves ${model} (all were probed and rejected it)`);
        break;
      }
      stats.attempts++;
      const deadline = laneFor(model).mode === "probe" ? FIRST_BYTE_MS : FIRST_BYTE_MS * (i + 1);
      const out = await attempt(clientReq.url, bodyBuf, headers, clientRes, i, shared, deadline, pick.id);
      if (out.promoted) return;                       // client already answered (or another attempt won)
      recordResult(model, pick.id, { ok: false, text: out.text, status: out.status });
      failures.push(`#${i + 1} ${out.why}@${deadline / 1000}s conn=${connLabel(pick.id)}: ${summarizeFailure(out.text, out.status)}`.slice(0, 220));
      log(`A${i + 1} discard ${((Date.now() - t0) / 1000).toFixed(1)}s model=${model} :: ${failures.at(-1)}`);
      if (i + 1 < MAX_ATTEMPTS) stats.hedged++;
    }
    if (shared.result?.ok) return;
    if (shared.winner !== undefined || clientRes.headersSent) return;
    stats.failed++; tally(model, false);
    if (!blockedByLane) laneExhausted(model);
    trip(model, failures.join(" ").slice(0, 200) || "no output", "exhausted");
    const payload = JSON.stringify({
      error: {
        message: blockedByLane
          ? `hedge gateway: no qoder connection is entitled to ${model} — ${failures.join(" | ")}; use a model the plan includes (e.g. qd/qfmodel)`
          : `hedge gateway: ${failures.length} attempts produced no output for model ${model} within ${((Date.now() - t0) / 1000).toFixed(0)}s — ${failures.join(" | ")}`,
        type: blockedByLane ? "model_unavailable" : "upstream_empty",
        hedge: { attempts: failures.length, firstByteMs: FIRST_BYTE_MS, idleMs: IDLE_MS },
      },
    });
    const code = blockedByLane ? 503 : 502;
    clientRes.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    clientRes.end(payload);
    log(`FAIL all ${failures.length} model=${model} ${((Date.now() - t0) / 1000).toFixed(1)}s http=${code} :: ${failures.join(" | ").slice(0, 300)}`);
  })();
}

function passthrough(clientReq, clientRes, bodyBuf) {
  const headers = { ...clientReq.headers, host: `${UP_HOST}:${UP_PORT}` };
  const up = http.request({ host: UP_HOST, port: UP_PORT, path: clientReq.url, method: clientReq.method, headers }, (res) => {
    clientRes.writeHead(res.statusCode, res.headers);
    res.pipe(clientRes);
  });
  up.on("error", (e) => { if (!clientRes.headersSent) clientRes.writeHead(502, { "content-type": "application/json" }); clientRes.end(JSON.stringify({ error: { message: e.message } })); });
  if (bodyBuf && bodyBuf.length) up.end(bodyBuf); else up.end();
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    const byModel = Object.entries(stats.byModel).map(([m, v]) => ({ model: m, ok: v.ok, fail: v.fail }));
    const circuits = [...breaker].filter(([, b]) => b.openUntil > Date.now()).map(([m, b]) => ({ model: m, openForMs: b.openUntil - Date.now(), why: b.why.slice(0, 140) }));
    const laneMap = Object.fromEntries([...lanes].map(([m, l]) => [m, {
      mode: l.mode, duds: l.duds,
      pinned: l.ok.map(connLabel),
      rejected: Object.entries(l.bad).filter(([, b]) => b.planGated).map(([id, b]) => `${connLabel(id)}: ${b.why.slice(0, 60)}`),
      tested: l.tested.map(connLabel),
      recheckInMs: l.until ? Math.max(0, l.until - Date.now()) : 0,
    }]));
    return res.end(JSON.stringify({
      ok: true, stats: { ...stats, byModel, circuits }, lanes: laneMap, pinning: PIN ? "on" : "off",
      inventory: Object.fromEntries(Object.entries(inventory).map(([p, l]) => [p, l.map((c) => c.label)])),
      upstream: `${UP_HOST}:${UP_PORT}`, policy: { FIRST_BYTE_MS, IDLE_MS, MAX_ATTEMPTS, TOTAL_BUDGET_MS, BREAK_FAILS, BREAK_MS },
    }, null, 2));
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyBuf = Buffer.concat(chunks);
    stats.req++;
    if (req.method === "POST" && CHAT_RE.test(req.url)) {
      let model = "?";
      try { model = JSON.parse(bodyBuf.toString("utf8"))?.model || "?"; } catch {}
      // a lane in probe mode is doing the one useful thing left to do — finding which connection
      // is entitled — so the circuit breaker must not pre-empt it
      const open = laneFor(model).mode === "probe" ? null : blocked(model);
      if (open) {
        stats.failed++; tally(model, false);
        const payload = JSON.stringify({
          error: {
            message: `hedge gateway: model ${model} circuit open for ${Math.ceil((open.openUntil - Date.now()) / 1000)}s [${open.kind || "no-output"}] (last upstream: ${open.why.slice(0, 150)})` +
              (open.kind === "not-provisioned" ? " — your qoder plan does not include this model; use qd/qfmodel" : " — upstream is degraded, retry after the cooldown"),
            type: "circuit_open", retryAfterMs: open.openUntil - Date.now(),
          },
        });
        res.writeHead(503, { "content-type": "application/json", "retry-after": String(Math.ceil((open.openUntil - Date.now()) / 1000)), "content-length": Buffer.byteLength(payload) });
        return res.end(payload);
      }
      return hedgeProxy(req, res, bodyBuf, model);
    }
    passthrough(req, res, bodyBuf);
  });
});
server.listen(LISTEN_PORT, "127.0.0.1", () =>
  log(`hedge gateway :${LISTEN_PORT} -> ${UP_HOST}:${UP_PORT}  firstByte=${FIRST_BYTE_MS}ms idle=${IDLE_MS}ms attempts=${MAX_ATTEMPTS} budget=${TOTAL_BUDGET_MS}ms`));
server.on("error", (e) => { log(`listen failed: ${e.code || e.message}`); process.exit(1); });
