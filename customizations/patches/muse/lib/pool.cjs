// Account pool for the Muse bridge: where the cookies come from, how they are
// persisted as muse.ai rotates them, and which accounts may be used right now.
//
// Source order: MUSE_POOL file -> 9router's stored muse-web connection (read
// only). Rotated cookies are written back to the pool file, never into 9router's
// database, so this project cannot corrupt another application's state.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_POOL = path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "9router", "muse", "pool.json");
const COOLDOWN_MS = 60 * 60 * 1000; // one hour after a quota rejection
const DB_MODULE = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3";
const DB_PATH = process.env.NINE_R_DB || "C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite";

function readFilePool(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch {
    return [];
  }
}

// The muse-web connection 9router already stores: data.apiKey holds the whole
// cookie blob, which is exactly the string a browser would send.
function readNineRouterConnection() {
  let Database;
  try {
    Database = require(DB_MODULE);
  } catch {
    return null;
  }
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare("select id, data from providerConnections where provider = 'muse-web' limit 1").get();
    if (!row) return null;
    const data = JSON.parse(row.data);
    return { id: row.id, cookies: data.apiKey || "", connectionId: row.id };
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

class AccountPool {
  constructor(opts = {}) {
    this.file = opts.file || process.env.MUSE_POOL || DEFAULT_POOL;
    this.accounts = opts.accounts || null;
    this.log = opts.log || (() => {});
    this.now = opts.now || (() => Date.now());
  }

  load() {
    if (this.accounts) return this.accounts;
    let accounts = readFilePool(this.file);
    if (!accounts.length) {
      const stored = readNineRouterConnection();
      if (stored && stored.cookies) {
        accounts = [
          {
            label: stored.connectionId ? `9r:${String(stored.connectionId).slice(0, 8)}` : "9router",
            cookies: stored.cookies,
            state: "active",
            cooldownUntil: 0,
            source: "9router-db",
          },
        ];
        this.accounts = accounts;
        this.persist(); // cache the rotated jar here from now on
        this.log("seeded the pool from the 9router muse-web connection", { label: accounts[0].label });
        return accounts;
      }
    }
    this.accounts = accounts.map((a) => ({ state: "active", cooldownUntil: 0, cookies: "", label: "muse", ...a }));
    return this.accounts;
  }

  save(account, cookies) {
    const list = this.load();
    const target = list.find((a) => a.label === account.label) || list[0];
    if (!target) return;
    target.cookies = typeof cookies === "string" ? cookies : [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    target.updatedAt = new Date().toISOString();
    this.accounts = list;
    this.persist();
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const body = JSON.stringify({ version: 1, accounts: this.accounts }, null, 2);
      fs.writeFileSync(this.file, body, { mode: 0o600 });
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        /* Windows ignores the mode; the file lives outside any repo */
      }
    } catch (err) {
      this.log("pool write failed", err.message);
    }
  }

  // Cooldowns are per account and survive the process, so a rate-limited account
  // gets rest instead of being re-tried by every inbound request.
  mark(account, state, ms = 0) {
    const list = this.load();
    const target = list.find((a) => a.label === account.label);
    if (!target) return;
    target.state = state;
    target.cooldownUntil = ms > 0 ? this.now() + ms : 0;
    target.lastError = state;
    this.accounts = list;
    this.persist();
  }

  available() {
    const now = this.now();
    return this.load().filter((a) => a.state !== "invalid" && (!a.cooldownUntil || a.cooldownUntil <= now));
  }

  // Least-recently-used first, so one account is not hammered while others idle.
  pickNext() {
    const ready = this.available().sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    return ready[0] || null;
  }

  markUsed(account) {
    const list = this.load();
    const target = list.find((a) => a.label === account.label);
    if (target) {
      target.lastUsed = this.now();
      this.accounts = list;
      this.persist();
    }
  }

  describe() {
    return this.load().map((a) => ({
      label: a.label,
      state: a.state || "active",
      cooldownUntil: a.cooldownUntil || 0,
      cookieNames: String(a.cookies || "")
        .split(";")
        .map((p) => p.split("=")[0].trim())
        .filter(Boolean)
        .sort()
        .join(","),
      hasSession: /(^|;)\s*hatch_sess=/.test(String(a.cookies || "")),
    }));
  }
}

module.exports = { AccountPool, DEFAULT_POOL, COOLDOWN_MS, readNineRouterConnection };
