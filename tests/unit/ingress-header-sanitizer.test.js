import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeIngressHeaders } from "../../open-sse/utils/ingressHeaderSanitizer.js";

test("strips proxy, tunnel, hop, 9router-internal, and hop runtime User-Agent headers", () => {
  const out = sanitizeIngressHeaders({
    "host": "rb54hwc.abc-tunnel.us",
    "user-agent": "undici",
    "x-forwarded-for": "1.2.3.4",
    "x-forwarded-host": "rr6g38g.abc-tunnel.us",
    "x-forwarded-proto": "https",
    "x-real-ip": "1.2.3.4",
    "cf-connecting-ip": "1.2.3.4",
    "cf-ray": "abc",
    "cf-ipcountry": "VN",
    "via": "1.1 cloudflare",
    "forwarded": "for=1.2.3.4",
    "cdn-loop": "cloudflare",
    "true-client-ip": "1.2.3.4",
    "x-9r-cli-token": "secret",
    "x-9r-real-ip": "127.0.0.1",
    "x-9r-peer-token": "secret2",
    "x-connection-id": "conn-123",
    "x-request-id": "req-123",
    "anthropic-beta": "interleaved-thinking-2025-05-14",
    "x-session-id": "sess-1",
    "x-opencode-session": "oc-123",
    "content-type": "application/json",
  });

  for (const k of [
    "host", "user-agent", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
    "x-real-ip", "cf-connecting-ip", "cf-ray", "cf-ipcountry", "via", "forwarded",
    "cdn-loop", "true-client-ip", "x-9r-cli-token", "x-9r-real-ip", "x-9r-peer-token",
    "x-connection-id", "x-request-id",
  ]) {
    assert.equal(out[k], undefined, `expected ${k} to be stripped`);
  }
  assert.equal(out["anthropic-beta"], "interleaved-thinking-2025-05-14");
  assert.equal(out["x-session-id"], "sess-1");
  assert.equal(out["x-opencode-session"], "oc-123");
  assert.equal(out["content-type"], "application/json");
});

test("preserves legitimate client user-agent like claude-cli or opencode", () => {
  const out = sanitizeIngressHeaders({
    "user-agent": "claude-cli/2.1.0 (external, cli)",
    "anthropic-beta": "context-1m-2025-08-07",
  });
  assert.equal(out["user-agent"], "claude-cli/2.1.0 (external, cli)");
  assert.equal(out["anthropic-beta"], "context-1m-2025-08-07");
});
