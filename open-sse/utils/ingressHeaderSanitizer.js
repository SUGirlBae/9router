const STRIP_PREFIXES = [
  "cf-",
  "x-forwarded-",
  "x-nf-",
  "netlify-",
  "x-vercel-",
  "x-amzn-",
  "x-9r-",
  "x-azure-",
  "x-fastly-",
  "akamai-",
  "x-render-",
  "x-deno-",
];

const STRIP_EXACT = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "accept-encoding",
  "forwarded",
  "via",
  "cdn-loop",
  "x-real-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "true-client-ip",
  "x-country",
  "traceparent",
  "tracestate",
  "logs-url",
  "x-invocation-id",
  "x-middleware-subrequest",
  "x-request-id",
  "x-connection-id",
  // CDN/edge cache + request-trace headers (Cloudflare, Fastly, Varnish, Fly, Deno)
  "x-cache",
  "x-cache-hits",
  "x-served-by",
  "x-timer",
  "x-varnish",
  "x-fastly-request-id",
  "fly-request-id",
  "x-client-trace-id",
]);

const HOP_RUNTIME_UA_RE = /^(?:undici|node(?:-fetch)?|axios|got|9router)(?:\/|\s|$)/i;

export function sanitizeIngressHeaders(headers = {}) {
  const clean = {};
  if (!headers || typeof headers !== "object") return clean;
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    const lower = String(key).toLowerCase();
    if (STRIP_EXACT.has(lower)) continue;
    if (STRIP_PREFIXES.some((p) => lower.startsWith(p))) continue;
    if (lower === "user-agent" && HOP_RUNTIME_UA_RE.test(String(value).trim())) continue;
    clean[lower] = value;
  }
  return clean;
}
