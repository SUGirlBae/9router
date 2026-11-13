// Installs the DNS stale-if-error keeper into 9router's launcher so the server process
// preloads it. Needed because 9router's own upstream calls fail with
// "[502]: fetch failed (cause: ENOTFOUND getaddrinfo ENOTFOUND api3.qoder.sh)" whenever the
// Windows resolver blips, and each such attempt stalls the caller for tens of seconds.
//
//   node patch-9r-net-keeper.js --dry-run    # show what would change
//   node patch-9r-net-keeper.js              # back up cli.js and inject --require
//
// Takes effect on the next 9router server start (a restart decision belongs to the user).

const fs = require("fs");
const path = require("path");

const PKG = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router";
const CLI = process.env.NINE_R_CLI_PATH || path.join(PKG, "cli.js");   // override lets the patch be rehearsed on a copy
const KEEPER_SRC = fs.existsSync(path.join(__dirname, "9r-net-keeper.js"))
  ? path.join(__dirname, "9r-net-keeper.js")
  : path.join(__dirname, "..", "runtime", "9r-net-keeper.js");
const KEEPER_DST = (process.env.NINE_R_KEEPER_DST || path.join(process.env.APPDATA || "", "9router", "runtime", "9r-net-keeper.js"))
  .replace(/\\/g, "/");   // forward slashes: this string is injected into JS source, and "\r" in
                          // C:\Users\...\runtime would be parsed as a carriage return
const BACKUP = CLI + ".pre-netkeeper.bak";
const DRY = process.argv.includes("--dry-run");

const SPAWNS = [
  {
    patterns: [
      `["--dns-result-order=ipv4first", "--max-old-space-size=6144", serverPath]`,
      `["--max-old-space-size=6144", serverPath]`,
    ],
    label: "server child",
  },
  {
    patterns: [
      `["--dns-result-order=ipv4first", __filename, "--tray", "--skip-update", "-p", port.toString()]`,
      `[__filename, "--tray", "--skip-update", "-p", port.toString()]`,
    ],
    label: "tray relaunch",
  },
];

function main() {
  if (!fs.existsSync(CLI)) throw new Error(`cli.js not found: ${CLI}`);
  if (!fs.existsSync(KEEPER_SRC)) throw new Error(`keeper missing: ${KEEPER_SRC}`);
  let src = fs.readFileSync(CLI, "utf8");
  const plan = [];
  const inject = (find) => `["--require", "${KEEPER_DST}", ` + find.slice(1);

  for (const s of SPAWNS) {
    const already = s.patterns.some((p) => src.includes(inject(p)));
    if (already) { plan.push(`OK    ${s.label}: already injected`); continue; }
    const match = s.patterns.find((p) => src.includes(p));
    if (!match) { plan.push(`SKIP  ${s.label}: pattern not present (9router version changed — re-check by hand)`); continue; }
    src = src.replace(match, inject(match));
    plan.push(`PATCH ${s.label}: add --require keeper`);
  }

  console.log(plan.join("\n"));
  console.log(`keeper -> ${KEEPER_DST}`);
  if (DRY) { console.log("\ndry run: nothing written"); return; }
  if (!plan.some((p) => p.startsWith("PATCH"))) { console.log("no changes needed"); return; }

  fs.mkdirSync(path.dirname(KEEPER_DST), { recursive: true });
  fs.copyFileSync(KEEPER_SRC, KEEPER_DST);
  if (!fs.existsSync(BACKUP)) fs.copyFileSync(CLI, BACKUP);
  fs.writeFileSync(CLI, src, "utf8");
  console.log(`written (backup: ${BACKUP})`);

  // the injected string is JS source, so verify what the parser will actually see, not just
  // that the file was edited
  const check = fs.readFileSync(CLI, "utf8");
  const lits = [...check.matchAll(/"--require",\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const lit of lits) {
    const okPath = fs.existsSync(lit);
    console.log(`  literal ${okPath ? "OK  " : "BAD "} ${lit}`);
    if (!okPath) { console.log("  path does not resolve after JS unescaping — restoring backup"); fs.copyFileSync(BACKUP, CLI); process.exitCode = 1; return; }
  }
  if (!lits.length) console.log("  WARNING: no --require literal found after write");
  console.log("restart 9router to load it — the running server keeps the old resolver behaviour until then");
}

main();
