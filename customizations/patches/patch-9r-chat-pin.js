// Let the CHAT dispatch honour a pinned connection, the way the video dispatch already does.
//
// Why: qoder entitlements differ per account — qfmodel works on all four, while
// auto/ultimate/gfmodel/cmodel/efficient are only entitled on one and return
// 403 {"code":"112","pricingUrl":...} on the rest. The router round-robins blindly, so a
// request for an account-limited model has ~1/4 odds of picking an entitled account and
// spends the rest of the time burning the shared pool, which also stalls healthy turns.
// With this patch the hedge gateway can send x-connection-id and pin a request to the
// account that actually serves that model.
//
//   node patch-9r-chat-pin.js --dry-run
//   node patch-9r-chat-pin.js
//
// Needs a 9router restart to take effect.

const fs = require("fs");
const path = require("path");

const DIR = process.env.NINE_R_CHUNKS || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router/app/.next-cli-build/server/chunks";
const DRY = process.argv.includes("--dry-run");

const NEEDLE = `for(;;){let b=await (0,f.c1)(B,F,C,{requestedModel:r||C});`;
const PATCHED = `for(;;){let b=await (0,f.c1)(B,F,C,{requestedModel:r||C,preferredConnectionId:(d&&d.headers&&"function"==typeof d.headers.get?d.headers.get("x-connection-id"):null)||null});`;

function main() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".js"));
  const targets = files.filter((f) => fs.readFileSync(path.join(DIR, f), "utf8").includes(NEEDLE));
  const already = files.filter((f) => fs.readFileSync(path.join(DIR, f), "utf8").includes(PATCHED));

  if (!targets.length && !already.length) {
    console.log(`NO MATCH in ${DIR} — 9router changed this dispatch, patch by hand after re-reading the file`);
    process.exitCode = 1;
    return;
  }
  let changed = 0;
  for (const f of already) console.log(`OK    ${f}: already patched`);
  for (const f of targets) {
    if (already.includes(f)) continue;
    console.log(`PATCH ${f}: pass x-connection-id into the credential selector`);
    if (DRY) { changed++; continue; }
    const p = path.join(DIR, f);
    const src = fs.readFileSync(p, "utf8");
    const bak = p + ".pre-chatpin.bak";
    if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
    fs.writeFileSync(p, src.replace(NEEDLE, PATCHED), "utf8");
    changed++;
  }
  if (DRY) console.log("\ndry run: nothing written");
  else console.log(changed ? "\nwritten (backups: *.pre-chatpin.bak) — restart 9router to load" : "\nno changes needed");
}

main();
