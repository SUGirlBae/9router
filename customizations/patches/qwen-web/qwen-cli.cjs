#!/usr/bin/env node
/**
 * Qwen-Web Automation CLI — Modeled after @notebooklm CLI (`notebooklm-py`)
 *
 * Commands:
 *   node qwen-cli.cjs auth check [--test] [--json]
 *   node qwen-cli.cjs auth refresh [--browser-cookies <profile>] [--json]
 *   node qwen-cli.cjs login
 *   node qwen-cli.cjs doctor [--fix] [--json]
 *   node qwen-cli.cjs ask "<prompt>" [-m <model>] [--json]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  DEFAULT_PROFILE,
  DEFAULT_STORAGE_STATE,
  syncStorageStateFromProfile,
  cleanupProfileLock,
} = require("./browser-client.cjs");

const PW_PATH = process.env.PLAYWRIGHT_PATH || "C:/Users/Administrator/.9router/runtime/node_modules/playwright-core";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DB_PATH = process.env.QWEN_DB_PATH || "D:/9router/data/db/data.sqlite";
const ROUTER_URL = process.env.QWEN_ROUTER_URL || "http://localhost:20130";

function parseJwtExp(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function inspectStorageState(statePath = DEFAULT_STORAGE_STATE) {
  const checks = {
    storage_exists: false,
    json_valid: false,
    cookies_present: false,
    token_present: false,
    token_fetch: null,
  };
  const details = {
    storage_path: statePath,
    auth_source: "file",
    cookies_found: [],
    cookie_domains: [],
    token_length: 0,
    token_exp: null,
  };

  if (!fs.existsSync(statePath)) {
    return { status: "error", checks, details };
  }
  checks.storage_exists = true;

  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    checks.json_valid = true;
  } catch {
    return { status: "error", checks, details };
  }

  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  details.cookies_found = cookies.map((c) => c.name);
  details.cookie_domains = [...new Set(cookies.map((c) => c.domain))];
  checks.cookies_present = cookies.some((c) => String(c.domain).includes("qwen.ai"));

  const qwenOrigin = (state.origins || []).find((o) => String(o.origin).includes("qwen.ai"));
  const tokEntry = (qwenOrigin?.localStorage || []).find((x) => x.name === "token");
  if (tokEntry?.value && tokEntry.value.length >= 20) {
    checks.token_present = true;
    details.token_length = tokEntry.value.length;
    details.token_exp = parseJwtExp(tokEntry.value);
    details.token_value = tokEntry.value;
  }

  const ok = checks.storage_exists && checks.json_valid && checks.cookies_present && checks.token_present;
  return { status: ok ? "ok" : "error", checks, details };
}

function updateSqliteConnection(token) {
  if (!fs.existsSync(DB_PATH)) return false;
  const db = new DatabaseSync(DB_PATH);
  try {
    const row = db.prepare("SELECT * FROM providerConnections WHERE provider = 'qwen-web'").get();
    if (!row) return false;
    let data = {};
    try {
      data = JSON.parse(row.data || "{}");
    } catch {}
    if (token) data.apiKey = token;
    data.testStatus = "active";
    data.lastError = null;
    data.lastErrorAt = null;
    data.errorCode = null;
    data.rateLimitedUntil = null;
    data.backoffLevel = 0;
    if (data.providerSpecificData) {
      delete data.providerSpecificData.proxyPoolId;
    }
    for (const k of Object.keys(data)) {
      if (k.startsWith("modelLock_")) data[k] = null;
    }
    db.prepare("UPDATE providerConnections SET isActive = 1, data = ?, updatedAt = ? WHERE id = ?").run(
      JSON.stringify(data),
      new Date().toISOString(),
      row.id
    );
    return true;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

async function cmdAuthCheck(args) {
  const wantTest = args.includes("--test");
  const wantJson = args.includes("--json");
  const report = inspectStorageState(DEFAULT_STORAGE_STATE);

  if (wantTest && report.checks.json_valid) {
    const pw = require(PW_PATH);
    let browser = null;
    try {
      browser = await pw.chromium.launch({
        headless: true,
        executablePath: CHROME,
        args: ["--disable-blink-features=AutomationControlled"],
      });
      const ctx = await browser.newContext({ storageState: DEFAULT_STORAGE_STATE });
      const page = await ctx.newPage();
      await page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForFunction(() => !!localStorage.getItem("token"), { timeout: 8000 }).catch(() => {});
      const netCheck = await page.evaluate(async () => {
        const tok = localStorage.getItem("token");
        if (!tok) return { ok: false, reason: "no_token_in_localStorage" };
        const r = await fetch("/api/v2/users/status", {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        });
        const j = await r.json().catch(() => ({}));
        return { ok: r.ok && j.data === true, status: r.status, body: j, token: tok };
      });
      report.checks.token_fetch = netCheck.ok === true;
      if (netCheck.ok && netCheck.token) {
        await ctx.storageState({ path: DEFAULT_STORAGE_STATE });
        updateSqliteConnection(netCheck.token);
      } else {
        report.status = "error";
        report.details.test_error = netCheck;
      }
    } catch (err) {
      report.checks.token_fetch = false;
      report.status = "error";
      report.details.test_error = err.message;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  delete report.details.token_value;
  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Status: ${report.status.toUpperCase()}`);
    console.log("Checks:", JSON.stringify(report.checks));
    console.log("Storage:", report.details.storage_path);
  }
  process.exit(report.status === "ok" ? 0 : 1);
}

async function cmdAuthRefresh(args) {
  const wantJson = args.includes("--json");
  let profilePath = DEFAULT_PROFILE;
  const idx = args.indexOf("--browser-cookies");
  if (idx >= 0 && args[idx + 1]) {
    const argProf = args[idx + 1];
    profilePath = fs.existsSync(argProf)
      ? argProf
      : path.join("D:/9router/data/browser-profiles", argProf);
  }

  await syncStorageStateFromProfile(profilePath, DEFAULT_STORAGE_STATE);
  const report = inspectStorageState(DEFAULT_STORAGE_STATE);
  if (report.details.token_value) {
    updateSqliteConnection(report.details.token_value);
  }
  delete report.details.token_value;
  if (wantJson) {
    console.log(JSON.stringify({ refreshed: report.status === "ok", ...report }, null, 2));
  } else {
    console.log(`[qwen-cli] Refreshed storage_state.json from ${profilePath} -> status=${report.status}`);
  }
  process.exit(report.status === "ok" ? 0 : 1);
}

async function cmdDoctor(args) {
  const fix = args.includes("--fix");
  const wantJson = args.includes("--json");
  const diag = {
    storage_state: inspectStorageState(DEFAULT_STORAGE_STATE).status,
    sqlite_unlocked: false,
    router_20130_healthy: false,
    fixes_applied: [],
  };

  if (fix) {
    cleanupProfileLock(DEFAULT_PROFILE);
    diag.fixes_applied.push("cleaned_profile_locks");
    if (diag.storage_state !== "ok" && fs.existsSync(DEFAULT_PROFILE)) {
      try {
        await syncStorageStateFromProfile(DEFAULT_PROFILE, DEFAULT_STORAGE_STATE);
        diag.fixes_applied.push("synced_storage_state_from_profile");
      } catch {}
    }
    const rep = inspectStorageState(DEFAULT_STORAGE_STATE);
    diag.storage_state = rep.status;
    if (updateSqliteConnection(rep.details.token_value)) {
      diag.sqlite_unlocked = true;
      diag.fixes_applied.push("unlocked_sqlite_models_and_removed_proxy_pool");
    }
  } else if (fs.existsSync(DB_PATH)) {
    const db = new DatabaseSync(DB_PATH);
    try {
      const row = db.prepare("SELECT * FROM providerConnections WHERE provider = 'qwen-web'").get();
      if (row) {
        let d = {};
        try {
          d = JSON.parse(row.data || "{}");
        } catch {}
        diag.sqlite_unlocked = !Object.keys(d).some((k) => k.startsWith("modelLock_") && d[k]);
      }
    } finally {
      try {
        db.close();
      } catch {}
    }
  }

  try {
    const r = await fetch(`${ROUTER_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
    diag.router_20130_healthy = r.ok;
  } catch {
    diag.router_20130_healthy = false;
  }

  if (wantJson) console.log(JSON.stringify(diag, null, 2));
  else console.log("[qwen-cli doctor]", JSON.stringify(diag, null, 2));
}

async function cmdAsk(args) {
  const wantJson = args.includes("--json");
  let model = "qwen-web/qwen3.7-plus";
  const mIdx = args.indexOf("-m");
  if (mIdx >= 0 && args[mIdx + 1]) model = args[mIdx + 1];
  const prompt = args.find((a, i) => !a.startsWith("-") && (mIdx < 0 || (i !== mIdx && i !== mIdx + 1))) || "Hello";

  let apiKey = "";
  if (fs.existsSync(DB_PATH)) {
    const db = new DatabaseSync(DB_PATH);
    try {
      const k = db.prepare("SELECT key FROM apiKeys LIMIT 1").get();
      if (k?.key) apiKey = k.key;
    } finally {
      try {
        db.close();
      } catch {}
    }
  }

  const resp = await fetch(`${ROUTER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });
  const text = await resp.text();
  if (wantJson) {
    console.log(text);
  } else {
    try {
      const j = JSON.parse(text);
      const msg = j.choices?.[0]?.message;
      if (msg?.reasoning_content) console.log(`[Thinking]\n${msg.reasoning_content}\n`);
      console.log(msg?.content || text);
    } catch {
      console.log(text);
    }
  }
  process.exit(resp.ok ? 0 : 1);
}

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const sub = argv[1];

  if (cmd === "auth" && sub === "check") return cmdAuthCheck(argv.slice(2));
  if (cmd === "auth" && sub === "refresh") return cmdAuthRefresh(argv.slice(2));
  if (cmd === "login") {
    const res = spawnSync(process.execPath, [path.join(__dirname, "open-login.cjs")], { stdio: "inherit" });
    if (res.status === 0) {
      await syncStorageStateFromProfile(DEFAULT_PROFILE, DEFAULT_STORAGE_STATE);
    }
    process.exit(res.status ?? 1);
  }
  if (cmd === "doctor") return cmdDoctor(argv.slice(1));
  if (cmd === "ask") return cmdAsk(argv.slice(1));

  console.log("Usage:");
  console.log("  node qwen-cli.cjs auth check [--test] [--json]");
  console.log("  node qwen-cli.cjs auth refresh [--browser-cookies <profile>] [--json]");
  console.log("  node qwen-cli.cjs login");
  console.log("  node qwen-cli.cjs doctor [--fix] [--json]");
  console.log("  node qwen-cli.cjs ask \"<prompt>\" [-m <model>] [--json]");
})();
