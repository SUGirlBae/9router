/**
 * Telemetry Sinkhole for 9router MITM
 *
 * Intercepts Google Antigravity & IDE telemetry, analytics, and experiment calls,
 * absorbing them locally and responding with synthetic HTTP 200 { "status": "OK" }.
 * This completely prevents real hardware identifiers (MAC hash, SQM MachineId,
 * Windows DeveloperTools deviceid, error stacks) from ever leaking to Google's servers.
 */

const SINKHOLE_PATTERNS = [
  "recordCodeAssistMetrics",
  "recordTrajectoryAnalytics",
  "fetchAdminControls",
  "listExperiments",
  "play.googleapis.com",
  "feedback-pa.googleapis.com",
  "/log"
];

/**
 * Checks whether an incoming request URL or host targets a telemetry / analytics endpoint.
 * @param {string} url - Request URL path or full URI
 * @param {string} [host=""] - Host header
 * @returns {boolean}
 */
export function isTelemetrySinkhole(url, host = "") {
  const full = `${host || ""}${url || ""}`;
  return SINKHOLE_PATTERNS.some(pattern => full.includes(pattern));
}

/**
 * Handles a sinkholed telemetry request locally without any network access.
 * @param {object} req - Incoming HTTP request
 * @param {object} res - Server HTTP response
 */
export function handleTelemetrySinkhole(req, res) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "x-9router-sinkhole": "absorbed"
  });
  res.end(JSON.stringify({ status: "OK", response: {} }));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { isTelemetrySinkhole, handleTelemetrySinkhole };
}
