"use strict";
// Preloaded into the 9router server (--require) to keep provider fetches alive through
// transient resolver failures. Node's dns.lookup goes to the OS resolver, and a failed
// getaddrinfo surfaces as undici "fetch failed", which 9router records as a 502 after a
// long stall. Observed on api3.qoder.sh: lastError "[502]: fetch failed (cause: ENOTFOUND
// getaddrinfo ENOTFOUND api3.qoder.sh)" while direct resolution worked fine seconds later.
//
// Positive answers are cached and served stale-if-error, so a resolver blip cannot fail a
// request that already had a working address. Negative answers are never cached.

const dns = require("node:dns");

const TTL_MS = Number(process.env.NINE_ROUTER_DNS_TTL_MS || 60000);
const STALE_MS = Number(process.env.NINE_ROUTER_DNS_STALE_MS || 1800000);
const LOG = process.env.NINE_ROUTER_DNS_LOG === "1";

const cache = new Map();
const now = () => Date.now();
const note = (...a) => { if (LOG) console.log("[net-keeper]", ...a); };

function keyOf(host, opts) {
  const ver = opts && opts.all === undefined ? (opts.verbatim === false ? "os" : "vb") : "all";
  const fam = opts && opts.family ? opts.family : 0;
  return `${String(host).toLowerCase()}|${fam}|${ver}`;
}

function store(key, addresses) {
  const prev = cache.get(key);
  cache.set(key, { addresses, freshAt: now(), hits: (prev?.hits || 0) + 1, misses: prev?.misses || 0 });
}

function freshOrStale(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (now() - e.freshAt <= STALE_MS) return e;
  cache.delete(key);
  return null;
}

// --- callback api (used by net.connect / undici / undici's internal lookup) -------------
const origLookup = dns.lookup;
dns.lookup = function (host, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const key = keyOf(host, options || {});
  origLookup.call(dns, host, options, (err, address, family) => {
    if (!err) {
      const list = options && options.all
        ? (Array.isArray(address) ? address : [{ address, family }])
        : [{ address, family }];
      store(key, list);
      return callback(null, address, family);
    }
    const cached = freshOrStale(key);
    if (!cached) return callback(err, address, family);
    if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
      cached.misses = (cached.misses || 0) + 1;
      note(`served stale for ${host} (${err.code}) ->`, cached.addresses.map((a) => a.address).join(","));
    }
    if (options && options.all) return callback(null, cached.addresses);
    const first = cached.addresses[0];
    return callback(null, first.address, first.family);
  });
};
Object.defineProperty(dns.lookup, "promises", { value: dns.promises.lookup, configurable: true });

// --- promises api ----------------------------------------------------------------------
const origPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function (host, options) {
  const key = keyOf(host, options || {});
  try {
    const res = await origPromiseLookup.call(dns.promises, host, options);
    store(key, options && options.all ? res : [res]);
    return res;
  } catch (err) {
    const cached = freshOrStale(key);
    if (cached && (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN")) {
      cached.misses = (cached.misses || 0) + 1;
      note(`served stale(promise) for ${host} (${err.code})`);
      return options && options.all ? cached.addresses : cached.addresses[0];
    }
    throw err;
  }
};

// --- warm the hosts 9router depends on -------------------------------------------------
const WARM = (process.env.NINE_ROUTER_DNS_WARM ||
  "api3.qoder.sh,openapi.qoder.sh,gateway.qoder.com.cn,openapi.qoder.com.cn,center.qoder.sh," +
  "www.deepseek.com,chat.deepseek.com,api.minimax.io,api.z.ai,api.groq.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

async function warm() {
  for (const host of WARM) {
    try { await dns.promises.resolve4(host); } catch { /* fall back to OS lookup */ }
    try {
      const a = await origPromiseLookup.call(dns.promises, host, { all: true, verbatim: true });
      if (a?.length) { store(keyOf(host, { all: true }), a); store(keyOf(host, { family: 4 }), a.map((x) => ({ address: x.address, family: 4 }))); }
    } catch (err) { note(`warm ${host} failed: ${err.code || err.message}`); }
  }
}
warm().catch(() => {});
const timer = setInterval(warm, Math.max(30000, TTL_MS));
timer.unref?.();

note(`dns keeper active (ttl=${TTL_MS}ms stale=${STALE_MS}ms hosts=${WARM.length})`);
