import { NextResponse } from "next/server";
import { createProxyPool, getProxyPools, updateProxyPool } from "@/models";

// Relay worker source code deployed to Cloudflare
const RELAY_WORKER_CODE = `// Cloudflare Worker relay — FIXED: clean Headers builder stripping all identifying/proxy headers & prefixes.
const STRIP_PREFIXES = [
  "cf-",
  "x-vercel-",
  "x-nf-",
  "netlify-",
  "x-forwarded-",
  "x-amzn-",
];

const STRIP_EXACT = new Set([
  "x-relay-target",
  "x-relay-path",
  "host",
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
]);

function shouldStrip(name) {
  const lower = String(name).toLowerCase();
  if (STRIP_EXACT.has(lower)) return true;
  for (const p of STRIP_PREFIXES) {
    if (lower.startsWith(p)) return true;
  }
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";

    if (!target) {
      return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const targetUrl = target.replace(/\\/$/, "") + relayPath;
    const cleanHeaders = new Headers();
    for (const [k, v] of request.headers.entries()) {
      if (!shouldStrip(k)) cleanHeaders.set(k, v);
    }

    const newRequestInit = {
      method: request.method,
      headers: cleanHeaders,
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      newRequestInit.body = request.body;
      newRequestInit.duplex = "half";
    }

    try {
      const response = await fetch(targetUrl, newRequestInit);
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
`;

// POST /api/proxy-pools/cloudflare-deploy
export async function POST(request) {
  try {
    const body = await request.json();
    const accountId = body.accountId?.trim();
    const apiToken = body.apiToken?.trim();
    const projectName = body.projectName?.trim() || `relay-${Date.now().toString(36)}`;

    if (!accountId || !apiToken) {
      return NextResponse.json({ error: "Cloudflare Account ID and API Token are required" }, { status: 400 });
    }

    // 1. Upload Worker Script
    const workerScriptUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${projectName}`;
    
    // Cloudflare requires multipart/form-data for worker script upload.
    // Use Buffer with explicit boundary to avoid cross-realm FormData serialization bugs in Node/Undici.
    const boundary = `----cfBoundary${Date.now().toString(16)}`;
    const metadataStr = JSON.stringify({
      main_module: "index.js",
      compatibility_date: "2024-03-20",
      observability: { enabled: true }
    });
    const bodyBuffer = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="metadata"; filename="metadata.json"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${metadataStr}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="index.js"; filename="index.js"\r\n` +
      `Content-Type: application/javascript+module\r\n\r\n` +
      `${RELAY_WORKER_CODE}\r\n` +
      `--${boundary}--\r\n`
    );

    const uploadRes = await fetch(workerScriptUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: bodyBuffer,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      console.error("Cloudflare upload error:", err);
      return NextResponse.json(
        { error: err.errors?.[0]?.message || "Failed to upload Worker to Cloudflare" },
        { status: uploadRes.status }
      );
    }

    // 2. Enable workers.dev subdomain for the script
    const enableSubdomainRes = await fetch(`${workerScriptUrl}/subdomain`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled: true }),
    });

    if (!enableSubdomainRes.ok) {
      const err = await enableSubdomainRes.json().catch(() => ({}));
      console.error("Cloudflare subdomain enable error:", err);
      // We don't fail completely here, just continue
    }

    // 3. Get the workers.dev subdomain for the account to construct the final URL
    let deployUrl = "";
    const subdomainRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (subdomainRes.ok) {
      const subdomainData = await subdomainRes.json();
      if (subdomainData.result && subdomainData.result.subdomain) {
        deployUrl = `https://${projectName}.${subdomainData.result.subdomain}.workers.dev`;
      }
    }

    if (!deployUrl) {
       return NextResponse.json(
        { error: "Worker deployed but failed to retrieve workers.dev subdomain. Make sure you have setup a workers.dev subdomain in Cloudflare Dashboard." },
        { status: 400 }
      );
    }

    // Upsert proxy pool entry with type cloudflare (strictProxy: true)
    const existingPools = await getProxyPools();
    const existingPool = existingPools.find((p) => p.proxyUrl === deployUrl || p.name === projectName);
    const proxyPool = existingPool
      ? await updateProxyPool(existingPool.id, {
          name: projectName,
          proxyUrl: deployUrl,
          type: "cloudflare",
          isActive: true,
          strictProxy: true,
        })
      : await createProxyPool({
          name: projectName,
          proxyUrl: deployUrl,
          type: "cloudflare",
          noProxy: "",
          isActive: true,
          strictProxy: true,
        });

    return NextResponse.json({ proxyPool, deployUrl }, { status: 201 });
  } catch (error) {
    console.log("Error deploying Cloudflare relay:", error);
    return NextResponse.json({ error: error.message || "Deploy failed" }, { status: 500 });
  }
}
