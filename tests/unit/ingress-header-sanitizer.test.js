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

test("strips third-party CDN/edge cache and request-trace headers", () => {
  const out = sanitizeIngressHeaders({
    "x-cache": "Hit from cloudfront",
    "x-cache-hits": "1",
    "x-served-by": "cache-fra-egr1",
    "x-timer": "S123.456",
    "x-varnish": "12345",
    "x-fastly-request-id": "abc",
    "fly-request-id": "01J",
    "x-client-trace-id": "trace",
    "x-azure-ref": "2026",
    "akamai-grn": "0.1",
    "x-render-origin-server": "render",
    "x-deno-ray": "ray",
    "x-nf-request-id": "nf",
    "x-vercel-id": "fra1::abc",
    "anthropic-beta": "context-1m-2025-08-07",
  });
  for (const k of [
    "x-cache", "x-cache-hits", "x-served-by", "x-timer", "x-varnish",
    "x-fastly-request-id", "fly-request-id", "x-client-trace-id", "x-azure-ref",
    "akamai-grn", "x-render-origin-server", "x-deno-ray", "x-nf-request-id", "x-vercel-id",
  ]) {
    assert.equal(out[k], undefined, `expected ${k} to be stripped`);
  }
  assert.equal(out["anthropic-beta"], "context-1m-2025-08-07");
});

test("preserves legitimate client user-agent like claude-cli or opencode", () => {
  const out = sanitizeIngressHeaders({
    "user-agent": "claude-cli/2.1.0 (external, cli)",
    "anthropic-beta": "context-1m-2025-08-07",
  });
  assert.equal(out["user-agent"], "claude-cli/2.1.0 (external, cli)");
  assert.equal(out["anthropic-beta"], "context-1m-2025-08-07");
});

test("normalizes header names to lowercase so downstream lookups keep working", () => {
  // open-sse/executors/default.js reads rawHeaders["anthropic-beta"] (exact key),
  // cursor.js reads rawHeaders["user-agent"] — casing must not survive.
  const out = sanitizeIngressHeaders({
    "Anthropic-Beta": "context-1m-2025-08-07",
    "User-Agent": "opencode/latest/2.0.29/desktop",
    "X-Session-Id": "sess-upper",
    "Content-Type": "application/json",
  });
  assert.equal(out["Anthropic-Beta"], undefined);
  assert.equal(out["anthropic-beta"], "context-1m-2025-08-07");
  assert.equal(out["user-agent"], "opencode/latest/2.0.29/desktop");
  assert.equal(out["x-session-id"], "sess-upper");
  assert.equal(out["content-type"], "application/json");
});

test("keeps array header values intact instead of dropping them", () => {
  const out = sanitizeIngressHeaders({
    "x-session-id": ["a", "b"],
    "anthropic-beta": "context-1m-2025-08-07",
  });
  assert.deepEqual(out["x-session-id"], ["a", "b"]);
});

test("does not confuse x-9router-token-saver with the x-9r- internal prefix", () => {
  const out = sanitizeIngressHeaders({
    "x-9router-token-saver": "off",
    "x-9r-cli-token": "secret",
  });
  assert.equal(out["x-9router-token-saver"], "off");
  assert.equal(out["x-9r-cli-token"], undefined);
});

test("handles null/undefined/non-object input without throwing", () => {
  assert.deepEqual(sanitizeIngressHeaders(null), {});
  assert.deepEqual(sanitizeIngressHeaders(undefined), {});
  assert.deepEqual(sanitizeIngressHeaders("nope"), {});
  assert.deepEqual(sanitizeIngressHeaders({ "x-cache": null }), {});
});
