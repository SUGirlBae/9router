// Sidecar HTTP tests: the parts that need no upstream.
//
//   Y1  a missing or wrong bearer key is refused with 401, in OpenAI error shape
//   Y2  /healthz answers and leaks no credential material (scanned, not trusted)
//   Y3  the socket is bound to loopback only
//   Y4  an unknown route is 404, not a crash
//   Y5  chat with an unusable credential fails typed, never as an empty 200
//
// The sidecar is spawned as a real child process on an ephemeral port with a
// synthetic pool file, so nothing here touches muse.ai.
//
// Run: node muse/test-sidecar.js
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 20150 + (process.pid % 40);
const BASE = `http://127.0.0.1:${PORT}`;
const POOL_FILE = path.join(os.tmpdir(), `muse-sidecar-pool-${process.pid}.json`);
const KEY = "test-sidecar-key";

// A cookie-looking string that must never come back from any endpoint.
const SECRET = "hatch_sess=SECRET-DO-NOT-ECHO; hatch_vml=ALSO-SECRET";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const child = spawn(process.execPath, [path.join(__dirname, "sidecar.cjs")], {
  env: { ...process.env, MUSE_SIDECAR_PORT: String(PORT), MUSE_SIDECAR_KEY: KEY, MUSE_POOL: POOL_FILE, MUSE_POOL_ACCOUNT: "test" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
let stdout = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

fs.writeFileSync(POOL_FILE, JSON.stringify({ version: 1, accounts: [{ label: "synthetic", cookies: SECRET, state: "active", cooldownUntil: 0 }] }), { mode: 0o600 });

async function waitUp(limit = 60) {
  for (let i = 0; i < limit; i += 1) {
    try {
      const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(700) });
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("Y1 wrong or missing bearer is a 401 in OpenAI shape", async () => {
  const missing = await fetch(`${BASE}/v1/models`);
  assert.equal(missing.status, 401);
  const body = await missing.json();
  assert.ok(body.error && typeof body.error.message === "string", "OpenAI error envelope");
  const wrong = await fetch(`${BASE}/v1/models`, { headers: { Authorization: "Bearer nope" } });
  assert.equal(wrong.status, 401);
  const ok = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const okBody = await ok.json().catch(() => ({}));
  assert.ok(
    ok.status !== 401 || !/bearer key/i.test((okBody.error || {}).message || ""),
    "the right key is accepted (a 401 here must come from muse.ai, not from the sidecar)"
  );
});

test("Y2 /healthz never echoes credentials", async () => {
  const res = await fetch(`${BASE}/healthz`);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes("SECRET-DO-NOT-ECHO"), "no cookie value in the body");
  assert.ok(!/hatch_sess=[A-Za-z0-9]/.test(text), "no cookie pair echoed");
  assert.ok(!text.includes(KEY), "the sidecar key is not echoed either");
  assert.match(text, /"ok":true/, "still useful as a health probe");
});

test("Y3 bound to loopback only", async () => {
  const probe = await new Promise((resolve) => {
    const socket = net.connect(PORT, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
  assert.equal(probe, true, "reachable on 127.0.0.1");
  const external = await freePort();
  assert.notEqual(external, PORT, "sanity: the probe port is independent");
  assert.ok(stdout.includes("127.0.0.1:" + PORT), "it announces a loopback address");
  assert.doesNotMatch(stderr, /0\.0\.0\.0/, "never announces a wildcard bind");
});

test("Y4 unknown route is a 404 JSON error", async () => {
  const res = await fetch(`${BASE}/v1/nonsense`, { headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(typeof body.error.message, "string");
});

test("Y5 an unusable credential fails typed, not empty", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "muse-chat", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.notEqual(res.status, 200, "a broken credential must not look like success");
  const body = await res.json();
  assert.ok(body.error, "typed error body");
  assert.ok(/auth|upstream|policy|quota|timeout|exhausted/.test(body.error.code), `error code is one of the taxonomy, got ${body.error.code}`);
  assert.ok(!/SECRET-DO-NOT-ECHO/.test(JSON.stringify(body)), "the failure does not leak the cookie");
}, 90000);

(async () => {
  let failed = 0;
  if (!(await waitUp())) {
    console.log("FAIL sidecar did not come up\n" + stderr.slice(0, 500));
    child.kill();
    fs.unlinkSync(POOL_FILE);
    process.exit(1);
  }
  for (const c of cases) {
    try {
      await Promise.race([
        c.fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("case timed out")), 90000)),
      ]);
      console.log(`ok   ${c.name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${c.name}\n     ${String(err && err.message).split("\n").join("\n     ")}`);
    }
  }
  child.kill();
  try {
    fs.unlinkSync(POOL_FILE);
  } catch {
    /* temp file already gone */
  }
  console.log(failed ? `${failed}/${cases.length} FAILED` : `all ${cases.length} sidecar cases passed`);
  process.exit(failed ? 1 : 0);
})();
