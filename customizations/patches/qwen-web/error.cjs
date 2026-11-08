/**
 * Qwen Web Error Mapper - map provider errors to OpenAI-style errors
 * Surfaces backend_busy, rate_limit, stale_token to caller (not swallowed)
 */
"use strict";

function mapError(err) {
  // HTTP error object from client: {status, body, headers}
  if (err && typeof err.status === "number") {
    const status = err.status;
    let code = "provider_error";
    let message = `Qwen web returned HTTP ${status}`;
    let type = "api_error";
    try {
      const parsed = JSON.parse(err.body);
      if (parsed.message) message = parsed.message;
      if (parsed.code) code = String(parsed.code);
      if (parsed.type) type = parsed.type;
    } catch {}
    if (status === 401) {
      code = "stale_token";
      type = "authentication_error";
      message = "Qwen web token expired or invalid; refresh required";
    } else if (status === 429) {
      code = "rate_limit";
      type = "rate_limit_error";
    } else if (status === 503 || /backend_busy/i.test(err.body || "")) {
      code = "backend_busy";
      type = "server_error";
      message = "Qwen backend busy; retry later";
    }
    return { error: { message, type, code } };
  }
  // Network/abort error
  if (err && err.name === "AbortError") {
    return { error: { message: "Qwen web request timed out", type: "timeout_error", code: "timeout" } };
  }
  return { error: { message: (err && err.message) || "Unknown Qwen web error", type: "api_error", code: "unknown" } };
}

function isRetryable(mapped) {
  const code = mapped && mapped.error && mapped.error.code;
  return code === "backend_busy" || code === "rate_limit" || code === "timeout";
}

function needsTokenRefresh(mapped) {
  return mapped && mapped.error && mapped.error.code === "stale_token";
}

module.exports = { mapError, isRetryable, needsTokenRefresh };