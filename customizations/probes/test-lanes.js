// Tests the per-model account lanes.
//   auto    an ordinary model must never be pinned: rotation spreads parallel load best
//   probe   a model that keeps dying under rotation gets its connections probed one by one
//   pinned  once a serving connection is found, later calls go straight to it
//   blocked when no connection serves the model, requests are refused instead of fanned out
// A throwaway sqlite file plays the role of 9router's DB so the real inventory loader runs.
const http = require("node:http"), { spawn } = require("node:child_process"), fs = require("node:fs"), path = require("node:path");
const Database = require("C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3");

const FAKE_PORT = 20198, GW_PORT = 20137;
const DB_FILE = path.join(__dirname, "rehearse-lanes-db.sqlite");
const LANES_FILE = path.join(__dirname, "rehearse-lanes.json");
const CONNS = [
  { id: "11111111-1111-1111-1111-111111111111", label: "acct-free-1" },
  { id: "22222222-2222-2222-2222-222222222222", label: "acct-free-2" },
  { id: "33333333-3333-3333-3333-333333333333", label: "acct-entitled" },
];
const ENTITLED = CONNS[2].id;          // only this account serves m-limited
let calls = [];

function makeDb() {
  fs.rmSync(DB_FILE, { force: true });
  const db = new Database(DB_FILE);
  db.exec("create table providerConnections (id text, provider text, name text, email text, priority int, isActive int, data text)");
  const ins = db.prepare("insert into providerConnections values (?,?,?,?,?,1,?)");
  CONNS.forEach((c, i) => ins.run(c.id, "qoder", c.label, c.label + "@example.test", i + 1, JSON.stringify({ accessToken: "dt-x" })));
  db.close();
}

const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    let model = "?"; try { model = JSON.parse(raw).model; } catch {}
    const pin = req.headers["x-connection-id"] || null;
    calls.push({ model, pin });
    const rejected = (model.includes("m-limited") && pin !== ENTITLED) || model.includes("m-none");
    if (rejected) {
      const body = JSON.stringify({ error: { message: 'qoder: {"code":"112","message":"{\\"pricingUrl\\":\\"https://qoder.com/pricing\\"}"}', code: 403 } });
      res.writeHead(400, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      return void res.end(body);
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: {"choices":[{"delta":{"content":"FROM-${pin ? pin.slice(0, 4) : "rotated"}"}}]}\n\n`);
    setTimeout(() => res.end(), 60);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(model) {
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  let t = ""; for await (const c of r.body) t += Buffer.from(c).toString();
  return { status: r.status, text: t };
}
const laneOf = async (m) => (await (await fetch(`http://127.0.0.1:${GW_PORT}/healthz`)).json()).lanes[m];

(async () => {
  await new Promise((r) => fake.listen(FAKE_PORT, "127.0.0.1", r));
  makeDb();
  fs.rmSync(LANES_FILE, { force: true });                 // start from a clean lane table
  const gw = spawn(process.execPath, ["9r-hedge-gateway.js"], {
    cwd: __dirname, windowsHide: true,
    env: { ...process.env, PORT: String(GW_PORT), UPSTREAM_HOST: "127.0.0.1", UPSTREAM_PORT: String(FAKE_PORT),
      NINE_R_DB: DB_FILE, HEDGE_LANES_FILE: LANES_FILE, HEDGE_PIN: "1", HEDGE_MAX_ATTEMPTS: "4", HEDGE_FIRST_BYTE_MS: "4000",
      // trip counts are set out of reach so this suite exercises lanes, not the circuit breaker
      HEDGE_BREAK_TRIPS: "99", HEDGE_EXHAUST_TRIPS: "99" },
  });
  gw.stderr.on("data", (d) => process.stdout.write("  [gw!] " + d));
  await sleep(900);

  const R = [];
  calls = [];
  const a = await call("qd/m-any");
  const l1 = await laneOf("qd/m-any");
  R.push(["A1 ordinary model runs unpinned (rotation)",
    a.status === 200 && calls.length === 1 && calls[0].pin === null && l1?.mode === "auto",
    `pins=[${calls.map((c) => (c.pin || "rot").slice(0, 4)).join(",")}] mode=${l1?.mode}`]);

  calls = [];
  await call("qd/m-limited");                             // auto, dud 1
  await call("qd/m-limited");                             // auto, dud 2 -> probe
  const probe = await call("qd/m-limited");               // one connection per attempt
  const l2 = await laneOf("qd/m-limited");
  R.push(["A2 gated model discovered by probing",
    probe.status === 200 && l2?.mode === "pinned" && l2.pinned.join() === "acct-entitled",
    `http=${probe.status} mode=${l2?.mode} pinned=[${l2?.pinned}] calls=${calls.length}`]);

  calls = [];
  const b = await call("qd/m-limited");
  R.push(["A3 follow-up uses the learned lane once",
    b.status === 200 && calls.length === 1 && calls[0].pin === ENTITLED,
    `upstreamCalls=${calls.length} pin=${(calls[0]?.pin || "-").slice(0, 4)}`]);

  calls = [];
  await call("qd/m-none"); await call("qd/m-none"); await call("qd/m-none");   // auto duds -> probe -> blocked
  const l4 = await laneOf("qd/m-none");
  const before = calls.length;
  const c = await call("qd/m-none");                                            // must be refused, not fanned out
  R.push(["A4 unservable model blocked, later calls refused",
    l4?.mode === "blocked" && c.status === 503 && /no .*connection serves|circuit/i.test(c.text) && calls.length === before,
    `mode=${l4?.mode} nextCall=${c.status} upstreamCallsAfterBlocked=${calls.length - before}`]);

  R.push(["A5 lanes persisted with mode", fs.existsSync(LANES_FILE) && /"mode"/.test(fs.readFileSync(LANES_FILE, "utf8")), LANES_FILE]);

  for (const [n, pass, d] of R) console.log(`${pass ? "PASS" : "FAIL"}  ${n.padEnd(48)} ${d}`);
  gw.kill(); fake.close();
  await sleep(250);
  fs.rmSync(DB_FILE, { force: true }); fs.rmSync(LANES_FILE, { force: true });
  console.log(R.every((r) => r[1]) ? "ALL PASS" : "FAILURES PRESENT");
  process.exitCode = R.every((r) => r[1]) ? 0 : 1;
})();
