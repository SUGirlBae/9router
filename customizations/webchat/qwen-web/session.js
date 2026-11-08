/**
 * Qwen Web Session Module - token refresh logic with TTL awareness
 * No hardcoded secrets; refresh based on error codes or TTL schedule.
 */
"use strict";
const { getBearerToken } = require("./auth");

// Refresh threshold: refresh when <16h left (preemptive like Muse hatch_vml lesson)
const REFRESH_THRESHOLD_MS = 16 * 60 * 60 * 1000;
let lastRefreshAt = Date.now();
let cachedToken = null;

async function refresh() {
  try {
    const token = await getBearerToken(process.env.QWEN_BROWSER_PROFILE_PATH || process.env.DEFAULT_QWEN_PROFILE);
    if (!cachedToken && token) {
      // First successful import
    } else if (token !== cachedToken) {
      // New token received
    }
    cachedToken = token;
    lastRefreshAt = Date.now();
    return true;
  } catch (e) {
    console.error("[QwenSession] Refresh failed:", e.message);
    throw e;
  }
}

async function getToken() {
  // Always ensure we have a fresh token (stale cookie detection via API will force refresh)
  if (!cachedToken) {
    await refresh();
  }
  return cachedToken;
}

function needsRefresh() {
  return !cachedToken || (Date.now() - lastRefreshAt > REFRESH_THRESHOLD_MS);
}

module.exports = { refresh, getToken, needsRefresh };