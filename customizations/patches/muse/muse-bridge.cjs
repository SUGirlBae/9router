// MuseBridge: the piece 9router talks to. OpenAI-style chat in, Muse's
// Noise/protobuf agent tunnel out, with account rotation, typed errors and a
// streaming answer assembled from the tunnel's history snapshots.
//
// Why history polling instead of the live /chat/stream body: protocol-notes.md
// §C2 — the stream endpoint is an acknowledgement/subscription call that some
// server revisions keep open past the generation itself, so waiting on it is the
// documented way to hang. The turn's text is authoritative in /chat/history.

"use strict";

const crypto = require("node:crypto");
const { MuseSession } = require("./lib/session.cjs");
const { HatchConnection, GatewayError } = require("./lib/gateway.cjs");
const { AccountPool, COOLDOWN_MS } = require("./lib/pool.cjs");
const media = require("./lib/media.cjs");

const CAPABILITIES = ["chat_cancel", "delta_stream", "custom_reactions", "custom_reactions_facebook_thumbs_up_v1"];
const QUOTA_PHRASES = /out of credits|quota|limit reached|too many requests|rate limit/i;
const MODEL_ALIAS = "muse-chat";

const asText = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asText).join("");
  if (typeof value === "object") {
    for (const key of ["text", "display_text", "content", "delta"]) {
      if (value[key] !== undefined && value[key] !== null) return asText(value[key]);
    }
  }
  return "";
};

function textOf(event) {
  if (!event || typeof event !== "object") return "";
  const direct = asText(event.display_text) || asText(event.text);
  if (direct) return direct;
  const payload = event.payload || {};
  return (
    asText(payload.display_text) ||
    asText(payload.text) ||
    asText(payload.content) ||
    asText(payload.delta) ||
    ""
  );
}

// Flatten OpenAI messages into one prompt. Muse has no tool calling and no
// system-role channel of its own, so the system text is prefixed.
function flattenMessages(messages) {
  const system = [];
  const turns = [];
  let imageParts = 0;
  for (const message of messages || []) {
    const content = message && message.content;
    let text = "";
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part) continue;
        if (part.type === "text" || typeof part.text === "string") text += part.text || "";
        else if (part.type === "image_url" || part.type === "image") imageParts += 1;
      }
    } else {
      text = asText(content);
    }
    if (message.role === "system") {
      if (text.trim()) system.push(text.trim());
      continue;
    }
    if (message.role === "assistant" && text.trim()) turns.push(`Assistant: ${text.trim()}`);
    else if (text.trim()) turns.push(`User: ${text.trim()}`);
  }
  const prompt = [...(system.length ? [`Instructions: ${system.join("\n")}`] : []), ...turns].join("\n\n");
  return { prompt, imageParts };
}

class MuseBridge {
  constructor(opts = {}) {
    this.pool = opts.pool || new AccountPool({ log: opts.log || (() => {}) });
    this.log = opts.log || (() => {});
    this.connections = new Map(); // label -> {conn, session, vm, expiresAt}
    this.sessionTtlMs = opts.sessionTtlMs ?? 15 * 60 * 1000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1200;
    this.fastPollMs = opts.fastPollMs ?? 350;
    // deny|allow_once|allow_always|off — an unanswered approval otherwise
    // blocks the turn until the budget expires (§C6).
    this.approvalPolicy = opts.approvals || process.env.MUSE_APPROVALS || "deny";
    this.approvalAfterMs = opts.approvalAfterMs ?? 6000;
    this.approvalSweepMs = opts.approvalSweepMs ?? 4000;
    this.quietMs = opts.quietMs ?? 2000;
    this.turnBudgetMs = opts.turnBudgetMs ?? 180000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30000;
    this.locale = opts.locale || "UTC";
    // Injected in tests so a turn can be driven without a socket or an account.
    this.transportFactory = opts.transportFactory || null;
    this.sessionFactory = opts.sessionFactory || ((sessionOpts) => new MuseSession(sessionOpts));
  }

  accounts() {
    return this.pool.describe();
  }

  async _connectionFor(account) {
    const cached = this.connections.get(account.label);
    if (cached && cached.expiresAt > Date.now() && cached.conn.connected) return cached;
    if (cached) {
      try {
        cached.conn.close();
      } catch {
        /* already gone */
      }
      this.connections.delete(account.label);
    }
    const session = this.sessionFactory({
      cookies: account.cookies,
      label: account.label,
      log: this.log,
      onRotate: (jar) => this.pool.save(account, jar),
    });
    if (session.missingRequired()) throw new GatewayError("auth", `${account.label}: stored cookies have no hatch_sess`);
    const { session: vm } = await session.ensureRunning();
    const tokens = await session.tokens(vm);
    const conn = new HatchConnection({
      url: session.wsUrl(vm, tokens.authToken, { notaryToken: tokens.notaryToken }),
      profile: "muse",
      log: this.log,
      requestTimeoutMs: this.requestTimeoutMs,
      transport: this.transportFactory ? this.transportFactory(account, { vm, tokens, session }) : undefined,
    });
    await conn.connect();
    const record = { conn, session, vm, expiresAt: Date.now() + this.sessionTtlMs };
    this.connections.set(account.label, record);
    this.pool.markUsed(account);
    return record;
  }

  // Try every usable account, one per attempt, rotating on auth and quota.
  async _withAccounts(work) {
    const order = this.pool.available().sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    const tried = [];
    let lastError = null;
    for (const account of order) {
      tried.push(account.label);
      try {
        return await work(account);
      } catch (err) {
        lastError = err;
        const kind = err instanceof GatewayError ? err.kind : "upstream";
        if (kind === "auth") {
          this.pool.mark(account, "invalid");
          this.connections.delete(account.label);
          this.log("account marked invalid", account.label);
        } else if (kind === "quota") {
          this.pool.mark(account, "cooling", COOLDOWN_MS);
          this.log("account cooling", account.label);
        } else if (kind === "upstream" || kind === "timeout") {
          this.connections.delete(account.label); // stale tunnel: reconnect next time
        } else if (order.length === 1) {
          throw err;
        }
      }
    }
    if (lastError && order.length === 1) throw lastError;
    throw new GatewayError("exhausted", `no Muse account could serve this request (tried: ${tried.join(", ") || "none available"})`, { tried });
  }

  async models() {
    return this._withAccounts(async (account) => {
      const { conn } = await this._connectionFor(account);
      const res = await conn.request({ method: "GET", path: "/model", timeoutMs: 20000 });
      const result = (res.json() || {}).result || {};
      const available = Array.isArray(result.available_models) ? result.available_models : [];
      const ids = available.map((m) => ({
        id: m.id || `${m.provider}/${m.model}`,
        name: m.display_name || m.id || "Auto",
        context: m.context_window_tokens || 0,
        provider: m.provider || "auto",
      }));
      const out = ids.length ? ids : [{ id: "auto/auto", name: "Auto", context: 350000, provider: "auto" }];
      // 9router addresses the provider by alias, so keep a stable chat name too.
      return {
        object: "list",
        account: account.label,
        selected: result.selected_model || null,
        data: [
          ...out.map((m) => ({ id: m.id, object: "model", owned_by: "muse-web", name: m.name, context_window: m.context })),
          { id: MODEL_ALIAS, object: "model", owned_by: "muse-web", name: "Muse (auto)" },
          // `auto/auto` is hard to address in a router that splits on "/", so the
          // same model also answers to a flat name.
          { id: "muse-auto", object: "model", owned_by: "muse-web", name: "Muse (auto, flat id)" },
        ],
      };
    });
  }

  // A full turn. Yields {delta} as the answer grows and finishes with {done, text,
  // usage, sessionId, messageIds}. Never yields a partial answer as if complete.
  async *chat(opts) {
    const { prompt, imageParts } = flattenMessages(opts.messages);
    if (!prompt.trim()) throw new GatewayError("policy", "no user content to send");
    // Muse has no function calling on the wire. Most clients send `tools` on every
    // request whether or not they need them, so refusing outright makes Muse
    // unusable from them: strip and answer, but never pretend when a tool call is
    // mandatory for the caller.
    const hasTools = Boolean(opts.tools || opts.functions ||
      (opts.messages || []).some((m) => m && (m.tool_calls || m.role === "tool" || m.function_call)));
    const requiresTool = typeof opts.toolChoice === "string" && opts.toolChoice === "required";
    if (hasTools && requiresTool) {
      throw new GatewayError("policy", "muse-web has no tool calling on the wire and this request requires one; use a tool-capable provider");
    }
    const toolsStripped = hasTools && !requiresTool;
    if (toolsStripped) this.log("muse-web: tools stripped (no tool calling on the wire)");
    if (imageParts) this.log("image parts are not sent to muse-web", { count: imageParts });

    const sessionId = opts.sessionId || deterministicSessionId(prompt);
    const nodeId = opts.nodeId || deterministicNode(sessionId);
    const body = {
      items: [{ type: "text", text: prompt }],
      message: prompt,
      node_id: nodeId,
      capabilities: CAPABILITIES,
      session_id: sessionId,
      timezone: opts.timezone || this.locale,
      metadata: { thread_is_dictation_used: false },
    };

    yield* this._withAccountStream((account) => this._turn(account, { body, sessionId, opts, toolsStripped }));
  }

  async *_turn(account, { body, sessionId, opts, toolsStripped }) {
    const { conn } = await this._connectionFor(account);
    const turnStartedAt = Date.now();
    const startedAtMs = turnStartedAt - 5000;
    const ack = await conn.ack({ method: "POST", path: "/chat/stream", body, timeoutMs: 20000 });
    const ackPayload = ack ? safeJson(ack) : null;
    const ackUserId = ackPayload ? ackPayload.message_id || ackPayload.id || null : null;

    let emitted = "";
    let lastGrowthAt = Date.now();
    let finalText = "";
    let assistantId = null;
    let lastApprovalSweep = 0;
    const deadline = Date.now() + (opts.budgetMs || this.turnBudgetMs);
    const abort = opts.signal || null;

    while (Date.now() < deadline) {
      if (abort && abort.aborted) {
        await this._cancel(conn, sessionId, "client aborted");
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      if (
        Date.now() - lastGrowthAt >= this.approvalAfterMs &&
        Date.now() - lastApprovalSweep >= this.approvalSweepMs
      ) {
        lastApprovalSweep = Date.now();
        await this._sweepApprovals(conn, sessionId).catch((err) => this.log("approval sweep failed", err.message));
      }
      const events = await this._history(conn, sessionId);
      const assistant = pickAssistant(events, { afterMs: startedAtMs, replyTo: ackUserId });
      if (assistant) {
        const text = textOf(assistant.event);
        assistantId = assistant.event.message_id || assistantId;
        let grew = false;
        if (text.length > emitted.length) {
          const fresh = text.slice(emitted.length);
          emitted = text;
          finalText = text;
          grew = true;
          yield { delta: fresh };
        } else if (text && text.length < emitted.length) {
          // The snapshot shrank (an edit or a rewrite): re-emit the whole text
          // rather than letting a stale prefix stand.
          emitted = text;
          finalText = text;
          grew = true;
          yield { delta: "", replace: text };
        }
        if (QUOTA_PHRASES.test(text) && text.length < 300) {
          // The VM answered with a refusal instead of an answer. Checked before
          // the terminal-event break, or the turn would end as a success.
          throw new GatewayError("quota", `Muse refused the turn: ${text.slice(0, 160)}`, { quotaText: true });
        }
        if (assistant.done) break;
        // A thread reply has no completion flag on the wire: it is done when the
        // snapshot stops growing (the reference client's 2 s settle rule). Poll
        // fast while it grows so the caller sees increments, slow once quiet.
        if (grew) lastGrowthAt = Date.now();
        if (emitted && Date.now() - lastGrowthAt >= this.quietMs) break;
        await sleep(grew ? this.fastPollMs : this.pollIntervalMs);
        continue;
      }
      if (emitted && Date.now() - lastGrowthAt >= this.quietMs) break;
      await sleep(this.pollIntervalMs);
    }

    if (!emitted) {
      const waitedS = ((Date.now() - turnStartedAt) / 1000).toFixed(0);
      throw new GatewayError("timeout", `Muse produced no answer for this turn within ${waitedS}s`, { sessionId });
    }
    yield {
      done: true,
      text: finalText,
      sessionId,
      assistantMessageId: assistantId,
      toolsStripped,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  async _history(conn, sessionId) {
    const res = await conn.request({
      method: "GET",
      path: `/chat/history?session_id=${encodeURIComponent(sessionId)}&limit=60`,
      timeoutMs: 25000,
    });
    const json = safeJson(res) || {};
    if (Array.isArray(json.chat_events)) return json.chat_events;
    if (json.result && Array.isArray(json.result.chat_events)) return json.result.chat_events;
    if (Array.isArray(json.events)) return json.events;
    return [];
  }

  async _cancel(conn, sessionId, reason) {
    try {
      await conn.request({
        method: "POST",
        path: "/chat/cancel",
        body: { session_id: sessionId, reason },
        timeoutMs: 5000,
      });
    } catch {
      /* cancellation is best effort */
    }
  }

  // One generation: ask the agent, poll the thread until the artifact set stops
  // changing, then pull the bytes through the tunnel. There is no upstream job
  // API to wait on (§D4), so "done" is defined by a stable signature.
  async generate(opts = {}) {
    const kind = opts.kind === "video" ? "video" : "image";
    const want = Math.max(1, Math.min(4, Number(opts.n || 1)));
    const prompt = String(opts.prompt || "").trim();
    if (!prompt) throw new GatewayError("policy", `${kind} generation needs a prompt`);
    const hint = kind === "video"
      ? `Make a short video: ${prompt}${opts.duration ? ` About ${opts.duration} seconds long.` : ""}${opts.resolution ? ` Resolution ${opts.resolution}.` : ""}`
      : `Make an image: ${prompt}${opts.size ? ` Size ${opts.size}.` : ""} Produce the file, do not just describe it.`;
    const sessionId = opts.sessionId || deterministicSessionId(`${kind}:${prompt}`);
    const body = {
      items: [{ type: "text", text: hint }],
      message: hint,
      node_id: opts.nodeId || deterministicNode(sessionId),
      capabilities: CAPABILITIES,
      session_id: sessionId,
      timezone: opts.timezone || this.locale,
      metadata: { thread_is_dictation_used: false },
    };
    return this._withAccounts(async (account) => {
      const { conn } = await this._connectionFor(account);
      const startedAtMs = Date.now() - 5000;
      await conn.ack({ method: "POST", path: "/chat/stream", body, timeoutMs: 20000 });
      const budgetMs = opts.budgetMs || (kind === "video" ? 600000 : 240000);
      const pollMs = opts.pollMs || 3000;
      const settleMs = opts.settleMs || 5000;
      const deadline = Date.now() + budgetMs;
      let signature = "";
      let stableSince = 0;
      let refs = [];
      let text = "";
      while (Date.now() < deadline) {
        if (opts.signal && opts.signal.aborted) {
          await this._cancel(conn, sessionId, "client aborted");
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        const events = await this._history(conn, sessionId);
        const mine = events.filter((event) => !startedAtMs || !event.occurred_at_ms || event.occurred_at_ms >= startedAtMs);
        refs = mine.flatMap((event) => media.extractRefs(event)).filter((ref) => ref.kind === kind);
        text = mine.map((event) => textOf(event)).filter(Boolean).join("\n");
        const marker = media.refusalIn(text);
        if (marker && !refs.length) {
          const quota = /credit|quota|limit|rate/i.test(marker);
          throw new GatewayError(quota ? "quota" : "policy", `Muse refused the ${kind} request ("${marker}")`, { marker });
        }
        const nextSignature = media.signatureOf(refs);
        if (nextSignature && nextSignature === signature && refs.length >= want) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= settleMs) break;
        } else {
          signature = nextSignature;
          stableSince = 0;
        }
        await sleep(pollMs);
      }
      if (!refs.length) throw new GatewayError("timeout", `no ${kind} artifact appeared within ${Math.round(budgetMs / 1000)}s`, { sessionId });
      const out = [];
      for (const ref of refs.slice(0, want)) {
        const fetched = await media.download(conn, ref, { signal: opts.signal });
        out.push({
          b64: fetched.bytes.toString("base64"),
          mime: fetched.mime || media.mimeFor(ref),
          path: ref.path || null,
          label: ref.label || null,
          bytes: fetched.bytes.length,
        });
      }
      return { kind, sessionId, artifacts: out, note: text.slice(0, 400) };
    });
  }

  image(opts = {}) {
    return this.generate({ ...opts, kind: "image" });
  }

  video(opts = {}) {
    return this.generate({ ...opts, kind: "video" });
  }

  // An unanswered approval blocks the turn silently (protocol-notes.md §C6), so a
  // stalled reply has to be checked for a pending approval rather than left to
  // run out the budget. Only approvals scoped to THIS session are touched.
  async _pendingApprovals(conn, sessionId) {
    const res = await conn.request({ method: "GET", path: "/approvals", service: "sentinel", timeoutMs: 15000 });
    const json = safeJson(res) || {};
    const result = json.result || json;
    const list = Array.isArray(result.pending_approvals) ? result.pending_approvals
      : Array.isArray(result.pending) ? result.pending : [];
    return list.filter((record) => {
      if (record.status && record.status !== "pending") return false;
      const scope = record.scope || {};
      const thread = record.thread_id || scope.thread_id || record.session_scope_id || scope.session_scope_id;
      return !thread || thread === sessionId;
    });
  }

  async _decideApproval(conn, record, decision) {
    const approvalId = record.approval_id || record.id;
    if (!approvalId) return false;
    const body = { approval_id: approvalId, decision };
    if (decision === "allow_always") {
      body.always_scope = record.always_scope || "destination_domain";
      body.allow_always_scope = body.always_scope;
    }
    await conn.request({ method: "POST", path: `/approvals/${encodeURIComponent(approvalId)}/decide`, service: "sentinel", body, timeoutMs: 15000 });
    return true;
  }

  async _sweepApprovals(conn, sessionId) {
    if (this.approvalPolicy === "off") return [];
    const pending = await this._pendingApprovals(conn, sessionId);
    const done = [];
    for (const record of pending) {
      if (await this._decideApproval(conn, record, this.approvalPolicy)) {
        this.log("answered a pending approval so the turn does not hang", {
          approvalId: String(record.approval_id || record.id).slice(0, 12),
          decision: this.approvalPolicy,
        });
        done.push(record);
      }
    }
    return done;
  }

  async testConnection() {
    const report = await this._withAccounts(async (account) => {
      const { conn, vm } = await this._connectionFor(account);
      const ping = await conn.request({ method: "POST", path: "/api/ping", body: {}, timeoutMs: 15000 });
      const models = await conn.request({ method: "GET", path: "/model", timeoutMs: 15000 }).catch(() => null);
      return {
        ok: ping.status < 400,
        kind: "muse-web",
        account: account.label,
        vmType: vm.vmType,
        ping: ping.status,
        model: models && models.status === 200 ? (safeJson(models).result || {}).selected_model : null,
      };
    });
    return report;
  }

  async *_withAccountStream(work) {
    const list = this.pool.available().sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    let lastError = null;
    for (const account of list) {
      let handedOff = false;
      try {
        for await (const chunk of work(account)) {
          handedOff = true;
          yield chunk;
        }
        return;
      } catch (err) {
        const kind = err instanceof GatewayError ? err.kind : "upstream";
        if (kind === "auth") this.pool.mark(account, "invalid");
        else if (kind === "quota") this.pool.mark(account, "cooling", COOLDOWN_MS);
        // A second account is only safe before the first byte of answer: after
        // that, retrying would splice two different turns into one reply.
        if (handedOff || (err && err.name === "AbortError")) throw err;
        lastError = err;
        if (kind === "timeout" || kind === "upstream" || kind === "auth" || kind === "quota") {
          this.connections.delete(account.label);
          continue;
        }
        throw err;
      }
    }
    // One account is the common case: its real failure must reach the caller,
    // not be disguised as pool exhaustion.
    throw lastError || new GatewayError("exhausted", "no Muse account could serve this stream");
  }

  close() {
    for (const [, record] of this.connections) {
      try {
        record.conn.close();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
  }
}

function safeJson(res) {
  try {
    return res.json();
  } catch {
    return null;
  }
}

// A stable session id per conversation: the same first message continues the
// same Muse thread, so retries and follow-ups gain context instead of piling up
// throwaway sessions in the account.
function deterministicSessionId(prompt) {
  const digest = crypto.createHash("sha256").update(prompt.slice(0, 2000)).digest();
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function deterministicNode(sessionId) {
  const digest = crypto.createHash("sha256").update("node:" + sessionId).digest();
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// The newest assistant event after a moment, optionally bound to the user
// message the ack reported. `done` means the event is finished, which the tunnel
// signals with an explicit terminal event name or by display_text_ready.
function pickAssistant(events, { afterMs = 0, replyTo = null } = {}) {
  const candidates = events.filter((event) => {
    const name = event.event_name || event.event || "";
    if (!/^(message\.assistant|delta\.message_done|delta\.presentation)$/.test(String(name))) return false;
    if (event.role && event.role !== "assistant" && String(name) !== "delta.presentation") return false;
    if (afterMs && Number(event.occurred_at_ms || 0) && Number(event.occurred_at_ms) < afterMs) return false;
    if (replyTo && event.reply_to_message_id && event.reply_to_message_id !== replyTo) return false;
    return true;
  });
  if (!candidates.length) return null;
  const last = candidates[candidates.length - 1];
  const name = String(last.event_name || last.event || "");
  const finished = name === "delta.message_done" || last.display_text_ready === true;
  return { event: last, done: finished, name };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { MuseBridge, flattenMessages, textOf, pickAssistant, deterministicSessionId, MODEL_ALIAS, CAPABILITIES };
