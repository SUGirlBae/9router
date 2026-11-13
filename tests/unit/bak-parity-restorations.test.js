import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { NETLIFY_RELAY_FUNCTION_CODE } from "../../src/lib/network/netlifyRelay.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("1. pre-aglock: getModelUpstreamId preserves preset suffix (low) even when providerThinking or body reasoning_effort is high", () => {
  // Exact 0.5.116 behavior: preset suffix on model (e.g. gemini-3.8-flash-low -> upstream gemini-3.8-flash-low(low))
  // must NOT be overwritten by body reasoning_effort unless caller passed an explicit suffix like model(high).
  const outWithBody = getModelUpstreamId("ag", "gemini-3.8-flash-low", { reasoning_effort: "high" });
  const outExplicit = getModelUpstreamId("ag", "gemini-3.8-flash-low(medium)", { reasoning_effort: "high" });
  assert.equal(outWithBody, "gemini-3.8-flash-low(low)");
  assert.equal(outExplicit, "gemini-3.8-flash-low(medium)");
});

test("2. pre-ecdh: proxyFetch uses X25519:P-256:P-384 default TLS_ECDH_CURVE", () => {
  const src = fs.readFileSync(path.join(ROOT, "open-sse/utils/proxyFetch.js"), "utf8");
  assert.match(src, /NINEROUTER_TLS_ECDH_CURVE\s*\|\|\s*"X25519:P-256:P-384"/);
});

test("3. pre-netlifyfix / pre-cfdeploy / pre-visibility: all 4 relays strip IP/proxy headers and netlify-deploy enforces sso_login=false + visibility check", () => {
  for (const needle of ["STRIP_PREFIXES", "STRIP_EXACT", "shouldStrip", "x-forwarded-", "x-real-ip", "cf-"]) {
    assert.ok(NETLIFY_RELAY_FUNCTION_CODE.includes(needle), `netlifyRelay missing ${needle}`);
  }
  for (const rel of [
    "src/app/api/proxy-pools/cloudflare-deploy/route.js",
    "src/app/api/proxy-pools/vercel-deploy/route.js",
    "src/app/api/proxy-pools/deno-deploy/route.js",
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const needle of ["STRIP_PREFIXES", "STRIP_EXACT", "shouldStrip", "x-forwarded-", "x-real-ip"]) {
      assert.ok(src.includes(needle), `${rel} missing ${needle}`);
    }
  }
  const netlifyDeploy = fs.readFileSync(path.join(ROOT, "src/app/api/proxy-pools/netlify-deploy/route.js"), "utf8");
  assert.match(netlifyDeploy, /sso_login:\s*false/);
  assert.match(netlifyDeploy, /account_sso_login:\s*false/);
  assert.match(netlifyDeploy, /Netlify site is Private \(401\)/);

  const cfDeploy = fs.readFileSync(path.join(ROOT, "src/app/api/proxy-pools/cloudflare-deploy/route.js"), "utf8");
  assert.match(cfDeploy, /getProxyPools/);
  assert.match(cfDeploy, /updateProxyPool/);
  assert.match(cfDeploy, /strictProxy:\s*true/);

  const vercelDeploy = fs.readFileSync(path.join(ROOT, "src/app/api/proxy-pools/vercel-deploy/route.js"), "utf8");
  assert.match(vercelDeploy, /getProxyPools/);
  assert.match(vercelDeploy, /updateProxyPool/);
  assert.match(vercelDeploy, /strictProxy:\s*true/);
});

test("4. pre-netlifyfix: proxy-pools create and update auto-detect relay type from proxyUrl", () => {
  for (const rel of ["src/app/api/proxy-pools/route.js", "src/app/api/proxy-pools/[id]/route.js"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(src, /netlify\\\.app/);
    assert.match(src, /workers\\\.dev/);
    assert.match(src, /vercel\\\.app/);
    assert.match(src, /deno\\\.\(net\|dev\)/);
  }
});

test("5. pre-proxydropdown: provider UI computes providerBoundCount and prevents dropdown scroll-dismiss", () => {
  const pageSrc = fs.readFileSync(path.join(ROOT, "src/app/(dashboard)/dashboard/providers/[id]/page.js"), "utf8");
  assert.match(pageSrc, /providerBoundCount/);

  const rowSrc = fs.readFileSync(path.join(ROOT, "src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js"), "utf8");
  assert.match(rowSrc, /providerBoundCount/);
  assert.match(rowSrc, /overscroll-contain/);
  assert.match(rowSrc, /onWheel=\{\(e\) => e\.stopPropagation\(\)\}/);
  assert.match(rowSrc, /proxyDropdownRef\.current\.contains\(e\?\.target\)/);

  const addSrc = fs.readFileSync(path.join(ROOT, "src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js"), "utf8");
  assert.match(addSrc, /providerBoundCount/);

  const cardSrc = fs.readFileSync(path.join(ROOT, "src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js"), "utf8");
  assert.match(cardSrc, /providerBoundCount/);
  assert.match(cardSrc, /overscroll-contain/);
});

test("6. pre-chatpin: src/sse/handlers/chat.js forwards x-connection-id as preferredConnectionId", () => {
  const chatSrc = fs.readFileSync(path.join(ROOT, "src/sse/handlers/chat.js"), "utf8");
  assert.match(chatSrc, /x-connection-id[\s\S]*preferredConnectionId/);
});
