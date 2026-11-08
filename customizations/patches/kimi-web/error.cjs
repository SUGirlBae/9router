/**
 * Kimi Web Error Mapper - surfaces upstream errors to caller (not swallowed).
 * Kimi web returns 401 stale session, 403 permission (paid-tier gate), 429 rate, 5xx busy.
 */
"use strict";

function mapError(err) {
  if (err && typeof err.status === "number") {
    const status = err.status;
    let code = "provider_error", type = "api_error";
    let message = `Kimi web returned HTTP ${status}`;
    try {
      const p = JSON.parse(err.body);
      if (p.message) message = p.message;
      if (p.error && p.error.message) message = p.error.message;
      if (p.code) code = String(p.code);
    } catch {}
    if (status === 401) { code = "stale_token"; type = "authentication_error"; message = "Kimi web session expired; re-import cookies required"; }
    else if (status === 403) { code = "permission_denied"; type = "permission_error"; }
    else if (status === 429) { code = "rate_limit"; type = "rate_limit_error"; }
    else if (status >= 500) { code = "backend_busy"; type = "server_error"; }
    return { error: { message, type, code } };
  }
  if (err && err.name === "AbortError") return { error: { message: "Kimi web request timed out", type: "timeout_error", code: "timeout" } };
  return { error: { message: (err && err.message) || "Unknown Kimi web error", type: "api_error", code: "unknown" } };
}

function isRetryable(m) { const c = m && m.error && m.error.code; return c === "backend_busy" || c === "rate_limit" || c === "timeout"; }
function needsTokenRefresh(m) { return m && m.error && m.error.code === "stale_token"; }

module.exports = { mapError, isRetryable, needsTokenRefresh };