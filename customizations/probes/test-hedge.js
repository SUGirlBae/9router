// Behavioural tests for 9r-hedge-gateway against a fake 9router.
//   T1 a stalled attempt is dropped on the send-time clock and the hedge attempt wins
//   T2 an empty 200 turn is never delivered to the client as a successful blank reply
//   T3 non-chat paths pass through
//   T4 a model-specific rejection opens a long circuit and later calls stop reaching upstream
//   T5 a transient no-output model opens only a short circuit (no minute-long lockout)
//   T6 one model's open circuit must not block a different healthy model
const http = require("node:http"), { spawn } = require("node:child_process"), path = require("node:path"), fs = require("node:fs");
const FAKE_PORT = 20199, GW_PORT = 20139, FIRST = 1500;
let hits = 0, goodSeq = 0, destroyed = 0;

const stream = (res, parts, done) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  parts.forEach((p, i) => setTimeout(() => res.write(`data: {"choices":[{"delta":{"content":"${p}"}}]}\n\n`), 100 * (i + 1)));
  setTimeout(() => { res.write("data: [DONE]\n\n"); res.end(); }, 100 * parts.length + 140);
};

const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    let model = "?"; try { model = JSON.parse(raw).model; } catch {}
    hits++;
    res.on("close", () => { if (!res.writableEnded) destroyed++; });

    if (model === "m-good") {
      if (++goodSeq === 1) return;                     // first call: no headers, no bytes at all
      return void stream(res, ["HE", "LLO"]);
    }
    if (model === "m-ok") return void stream(res, ["FINE"]);
    if (model === "m-denied") {                        // same shape as a real qoder plan miss
      const body = JSON.stringify({ error: { message: 'qoder: model_config for "qmodel" not yet known (run a model list fetch or check upstream connectivity)' } });
      res.writeHead(400, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      return void res.end(body);
    }
    res.writeHead(200, { "content-type": "text/event-stream" });   // m-empty / anything else
    res.write('data: {"choices":[{"delta":{"content":""}}]}\n\n');
    setTimeout(() => res.end(), 120);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(model) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  let t = ""; for await (const c of r.body) t += Buffer.from(c).toString();
  return { status: r.status, attempts: r.headers.get("x-hedge-attempts"), retryAfter: r.headers.get("retry-after"), text: t, ms: Date.now() - t0 };
}
const joined = (t) => (t.match(/"content"\s*:\s*"([^"]*)"/g) || []).map((s) => s.replace(/^.*"content"\s*:\s*"/, "").replace(/"$/, "")).join("");

(async () => {
  const LANES = path.join(__dirname, "rehearse-hedge-lanes.json");
  fs.rmSync(LANES, { force: true });                    // stale learned lanes would change breaker behaviour
  await new Promise((r) => fake.listen(FAKE_PORT, "127.0.0.1", r));
  const gw = spawn(process.execPath, ["9r-hedge-gateway.js"], {
    cwd: __dirname, windowsHide: true,
    env: { ...process.env, PORT: String(GW_PORT), UPSTREAM_HOST: "127.0.0.1", UPSTREAM_PORT: String(FAKE_PORT), HEDGE_FIRST_BYTE_MS: String(FIRST), HEDGE_MAX_ATTEMPTS: "3", HEDGE_PIN: "0", HEDGE_LANES_FILE: path.join(__dirname, "rehearse-hedge-lanes.json") },
  });
  gw.stderr.on("data", (d) => process.stdout.write("  [gw!] " + d));
  await sleep(900);

  const R = [];
  const a = await call("m-good");
  R.push(["T1 stalled attempt dropped, hedge attempt wins",
    a.status === 200 && joined(a.text) === "HELLO" && a.attempts === "2" && a.ms < FIRST * 4,
    `http=${a.status} via attempt ${a.attempts} in ${(a.ms / 1000).toFixed(1)}s`]);

  const b = await call("m-empty");
  R.push(["T2 empty turn never delivered as success", b.status === 502 && /no output/i.test(b.text), `http=${b.status}`]);

  const h = await fetch(`http://127.0.0.1:${GW_PORT}/healthz`);
  R.push(["T3 non-chat path passes through", h.status === 200, `healthz=${h.status}`]);

  let before = hits;
  await call("m-denied"); await call("m-denied");
  const c = await call("m-denied");
  R.push(["T4 plan-miss model: long circuit, no fan-out",
    c.status === 503 && /not-provisioned/.test(c.text) && hits - before === 6 && Number(c.retryAfter) >= 100,
    `3rd=${c.status} upstreamCalls=${hits - before} retryAfter=${c.retryAfter}s`]);

  before = hits;
  await call("m-flaky"); await call("m-flaky");          // fresh model: 2 exhausted requests
  const d = await call("m-flaky");
  R.push(["T5 transient no-output: only a short circuit",
    d.status === 503 && /no-output/.test(d.text) && hits - before === 6 && Number(d.retryAfter) <= 30,
    `3rd=${d.status} upstreamCalls=${hits - before} retryAfter=${d.retryAfter}s`]);

  const e = await call("m-ok");
  R.push(["T6 open circuit on one model does not block another", e.status === 200 && joined(e.text) === "FINE", `m-ok=${e.status}`]);

  for (const [name, pass, detail] of R) console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(48)} ${detail}`);
  const health = await (await fetch(`http://127.0.0.1:${GW_PORT}/healthz`)).json();
  console.log(`\ncircuits: ${JSON.stringify(health.stats.circuits.map((x) => `${x.model}:${Math.round(x.openForMs / 1000)}s:${x.why ? "" : ""}`))}`);
  gw.kill(); fake.close();
  await sleep(250);
  console.log(R.every((r) => r[1]) ? "ALL PASS" : "FAILURES PRESENT");
  process.exitCode = R.every((r) => r[1]) ? 0 : 1;
})();
