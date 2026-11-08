const dns = require("node:dns");
let mode = "ok";
// install stub BEFORE requiring the keeper so the keeper wraps the stub
dns.lookup = (host, opts, cb) => {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  if (mode === "ok") return cb(null, opts && opts.all ? [{ address: "1.2.3.4", family: 4 }] : "1.2.3.4", 4);
  const e = Object.assign(new Error(`queryA ${mode} ${host}`), { code: mode, hostname: host });
  cb(e);
};
dns.promises.lookup = async (host, opts) => {
  if (mode === "ok") return opts && opts.all ? [{ address: "1.2.3.4", family: 4 }] : { address: "1.2.3.4", family: 4 };
  throw Object.assign(new Error(`queryA ${mode} ${host}`), { code: mode, hostname: host });
};

require("./9r-net-keeper.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (h, o) => new Promise((res) => dns.lookup(h, o, (e, a, f) => res(e ? { err: e.code } : { addr: a, fam: f })));

(async () => {
  await sleep(400);
  console.log("1. resolver healthy   api3.qoder.sh ->", JSON.stringify(await L("api3.qoder.sh")));
  mode = "ENOTFOUND";
  console.log("2. resolver ENOTFOUND api3.qoder.sh ->", JSON.stringify(await L("api3.qoder.sh")), " (expect cached 1.2.3.4)");
  console.log("3. unknown host       nope.invalid  ->", JSON.stringify(await L("nope.invalid")), " (expect err, no fake answer)");
  await L("api3.qoder.sh", { all: true });
  console.log("4. all=true while down              ->", JSON.stringify(await L("api3.qoder.sh", { all: true })));
  mode = "EAI_AGAIN";
  console.log("5. EAI_AGAIN          api3.qoder.sh ->", JSON.stringify(await L("api3.qoder.sh")));
  mode = "ok";
  console.log("6. healthy again      api3.qoder.sh ->", JSON.stringify(await L("api3.qoder.sh")));
  const p = await dns.promises.lookup("api3.qoder.sh").catch((e) => ({ err: e.code }));
  console.log("7. promises api passthrough         ->", JSON.stringify(p));
  mode = "ENOTFOUND";
  await sleep(150);
  const p2 = await dns.promises.lookup("api3.qoder.sh").catch((e) => ({ err: e.code }));
  console.log("8. promises stale                   ->", JSON.stringify(p2));
})();
