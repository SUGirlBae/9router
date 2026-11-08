// Make a pinned connection stick across the router's internal retries.
//
// The chat dispatch now forwards x-connection-id, but the credential selector looked the pin
// up only in the list of connections that had not been excluded yet. On the first retry the
// pinned id lands in the excluded set, the pin silently resolves to nothing, and the router
// falls back to rotating accounts — so a plan-gated 403 from the pinned account is never
// returned to the caller and the response is held while it walks the whole pool. That also
// makes it impossible for the hedge gateway to learn which account actually serves a model.
//
//   node patch-9r-pin-sticky.js --dry-run
//   node patch-9r-pin-sticky.js
//
// Needs a 9router restart.

const fs = require("fs");
const path = require("path");

const DIR = process.env.NINE_R_CHUNKS || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router/app/.next-cli-build/server/chunks";
const DRY = process.argv.includes("--dry-run");

const NEEDLE = `if(o&&(b=r.find(a=>a.id===o))&&j.info("AUTH"`;
const FIXED = `if(o&&(b=k.find(a=>a.id===o))&&j.info("AUTH"`;

function main() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".js"));
  const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
  const targets = files.filter((f) => read(f).includes(NEEDLE));
  const already = files.filter((f) => read(f).includes(FIXED));

  if (!targets.length && !already.length) {
    console.log(`NO MATCH in ${DIR} — the selector changed; re-read the file before patching`);
    process.exitCode = 1;
    return;
  }
  for (const f of already) console.log(`OK    ${f}: pin already sticky`);
  let changed = 0;
  for (const f of targets) {
    if (already.includes(f)) continue;
    console.log(`PATCH ${f}: resolve the pin from all active connections, not only unexcluded ones`);
    if (!DRY) {
      const p = path.join(DIR, f);
      const src = read(f);
      const bak = p + ".pre-pinsticky.bak";
      if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
      fs.writeFileSync(p, src.split(NEEDLE).join(FIXED), "utf8");
    }
    changed++;
  }
  if (DRY) console.log("\ndry run: nothing written");
  else console.log(changed ? "\nwritten (backups: *.pre-pinsticky.bak) — restart 9router to load" : "\nno changes needed");
}

main();
