/**
 * Latency-Aware Account Orchestrator & Resilient Circuit Breaker
 *
 * Inherited from international AI gateway best practices (Portkey / LiteLLM / OmniRoute).
 * Tracks per-connection Exponential Moving Average (EMA) latency and error streaks
 * entirely in memory (zero SQLite write contention).
 */

const EMA_ALPHA = 0.3;
const DEFAULT_EMA_MS = 1000;
const FAILURE_THRESHOLD = 3;
const BASE_COOLDOWN_MS = 30000;
const MAX_COOLDOWN_MS = 300000; // 5 minutes max

const connectionMetrics = new Map();

function ensureEntry(connectionId) {
  const key = String(connectionId || "default");
  let entry = connectionMetrics.get(key);
  if (!entry) {
    entry = {
      emaMs: null,
      consecutiveFailures: 0,
      totalSuccess: 0,
      totalFailures: 0,
      circuitOpenUntil: 0,
      lastStatus: 200,
      lastUpdatedAt: 0
    };
    connectionMetrics.set(key, entry);
  }
  return entry;
}

export function recordConnectionSuccess(connectionId, latencyMs) {
  if (!connectionId) return;
  const entry = ensureEntry(connectionId);
  const validLatency = typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0
    ? latencyMs
    : DEFAULT_EMA_MS;

  entry.emaMs = entry.emaMs === null
    ? validLatency
    : Math.round(entry.emaMs * (1 - EMA_ALPHA) + validLatency * EMA_ALPHA);

  entry.consecutiveFailures = 0;
  entry.circuitOpenUntil = 0;
  entry.totalSuccess++;
  entry.lastStatus = 200;
  entry.lastUpdatedAt = Date.now();
}

export function recordConnectionFailure(connectionId, status = 500) {
  if (!connectionId) return;
  const entry = ensureEntry(connectionId);
  entry.consecutiveFailures++;
  entry.totalFailures++;
  entry.lastStatus = status;
  entry.lastUpdatedAt = Date.now();

  if (entry.consecutiveFailures >= FAILURE_THRESHOLD) {
    const exponent = Math.min(entry.consecutiveFailures - FAILURE_THRESHOLD, 4);
    const cooldownMs = Math.min(BASE_COOLDOWN_MS * Math.pow(2, exponent), MAX_COOLDOWN_MS);
    entry.circuitOpenUntil = Date.now() + cooldownMs;
  }
}

export function isCircuitOpen(connectionId, nowMs = Date.now()) {
  if (!connectionId) return false;
  const entry = connectionMetrics.get(String(connectionId));
  if (!entry || !entry.circuitOpenUntil) return false;
  return nowMs < entry.circuitOpenUntil;
}

export function getConnectionStats(connectionId) {
  return { ...ensureEntry(connectionId) };
}

export function scoreConnection(connection) {
  const entry = connectionMetrics.get(String(connection?.id || ""));
  if (!entry) return DEFAULT_EMA_MS;

  const baseLatency = entry.emaMs !== null ? entry.emaMs : DEFAULT_EMA_MS;
  const errorPenalty = entry.consecutiveFailures * 2000;
  return baseLatency + errorPenalty;
}

/**
 * Picks the optimal healthy connection based on EMA latency and circuit breaker status.
 * Automatically fails open if all connections have tripped circuits.
 *
 * @param {Array<object>} connections
 * @returns {object|null}
 */
export function selectOptimalConnection(connections) {
  if (!Array.isArray(connections) || connections.length === 0) return null;
  const now = Date.now();

  const healthy = connections.filter(c => !isCircuitOpen(c.id, now));
  const candidates = healthy.length > 0 ? healthy : connections;

  const sorted = [...candidates].sort((a, b) => {
    const scoreA = scoreConnection(a);
    const scoreB = scoreConnection(b);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return (a.priority || 999) - (b.priority || 999);
  });

  return sorted[0] || null;
}

export function resetOrchestrator() {
  connectionMetrics.clear();
}
