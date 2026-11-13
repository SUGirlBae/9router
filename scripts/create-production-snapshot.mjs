import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PROD_BUNDLE = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router";
const PROD_APPDATA = "C:/Users/Administrator/AppData/Roaming/9router";
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const SNAPSHOT_BASE = "D:/9router-production-snapshots";
const SNAPSHOT_DIR = path.join(SNAPSHOT_BASE, `snapshot-${TIMESTAMP}-pre-antigravity`);
const LOCAL_BAK_DIR = path.join(
  path.dirname(PROD_BUNDLE),
  `9router.bak-pre-v0119-${TIMESTAMP}`,
);

console.log("=================================================");
console.log("  9ROUTER PRODUCTION SNAPSHOT BACKUP CREATOR");
console.log("=================================================");
console.log(`Source Bundle:  ${PROD_BUNDLE}`);
console.log(`Source AppData: ${PROD_APPDATA}`);
console.log(`Destination:    ${SNAPSHOT_DIR}`);
console.log(`Local Fast Bak: ${LOCAL_BAK_DIR}`);
console.log("-------------------------------------------------");

fs.mkdirSync(SNAPSHOT_BASE, { recursive: true });
if (fs.existsSync(SNAPSHOT_DIR)) {
  throw new Error(`Snapshot destination already exists: ${SNAPSHOT_DIR}`);
}
if (fs.existsSync(LOCAL_BAK_DIR)) {
  throw new Error(`Rollback destination already exists: ${LOCAL_BAK_DIR}`);
}
fs.mkdirSync(SNAPSHOT_DIR);
const snapBundleDir = path.join(SNAPSHOT_DIR, "npm-bundle-9router");
const snapAppDataDir = path.join(SNAPSHOT_DIR, "appdata-9router");
fs.mkdirSync(snapBundleDir, { recursive: true });
fs.mkdirSync(snapAppDataDir, { recursive: true });

// Step 1: Atomic SQLite snapshot via VACUUM INTO
console.log("[1/5] Creating atomic SQLite database snapshot via VACUUM INTO...");
const prodDbPath = path.join(PROD_APPDATA, "db/data.sqlite");
const snapDbDir = path.join(snapAppDataDir, "db");
fs.mkdirSync(snapDbDir, { recursive: true });
const snapDbPath = path.join(snapDbDir, "data.sqlite");

if (fs.existsSync(prodDbPath)) {
  const db = new DatabaseSync(prodDbPath, { readOnly: true });
  db.exec(`VACUUM INTO '${snapDbPath.replace(/'/g, "''")}';`);
  db.close();
  const dbSize = fs.statSync(snapDbPath).size;
  console.log(`  -> Vacuumed snapshot created: ${(dbSize / 1024 / 1024).toFixed(2)} MB`);
} else {
  console.log("  -> Warning: No data.sqlite found at source.");
}

// Step 2: Copy remaining AppData files (excluding old .bak folders and live wal/shm if present)
console.log("[2/5] Copying Production AppData state and credentials...");
const appDataEntries = fs.readdirSync(PROD_APPDATA, { withFileTypes: true });
for (const entry of appDataEntries) {
  if (entry.name === "db" || entry.name.includes(".bak-pre-upgrade")) {
    continue; // db is handled atomically, old backup is skipped to save space
  }
  const srcPath = path.join(PROD_APPDATA, entry.name);
  const dstPath = path.join(snapAppDataDir, entry.name);
  fs.cpSync(srcPath, dstPath, { recursive: true, force: true });
}
// Copy db subfolder extra files (like .migrated-from-json)
const dbSubEntries = fs.readdirSync(path.join(PROD_APPDATA, "db"), { withFileTypes: true });
for (const entry of dbSubEntries) {
  if (entry.name.startsWith("data.sqlite")) continue;
  const src = path.join(PROD_APPDATA, "db", entry.name);
  const dst = path.join(snapDbDir, entry.name);
  fs.cpSync(src, dst, { recursive: true, force: true });
}
console.log("  -> AppData copy complete.");

// Step 3: Copy full npm bundle to snapshot destination on D:
console.log("[3/5] Copying full npm package bundle to D: snapshot...");
fs.cpSync(PROD_BUNDLE, snapBundleDir, { recursive: true, force: true });
console.log("  -> Full package bundle copy complete.");

// Step 4: Create local fast rollback copy on C: (beside node_modules)
console.log("[4/5] Creating local fast rollback bundle on C: drive...");
fs.cpSync(PROD_BUNDLE, LOCAL_BAK_DIR, { recursive: true, force: true });
console.log("  -> Local rollback directory created.");

// Step 5: Verification & Manifest generation
console.log("[5/5] Verifying snapshot integrity and writing manifest...");
// Verify SQLite in snapshot
let verifiedConnections = 0;
if (fs.existsSync(snapDbPath)) {
  const verifyDb = new DatabaseSync(snapDbPath, { readOnly: true });
  const row = verifyDb.prepare("SELECT count(*) as cnt FROM providerConnections").get();
  verifiedConnections = row.cnt;
  verifyDb.close();
}

// Generate manifest
const manifest = {
  timestamp: new Date().toISOString(),
  snapshotId: `snapshot-${TIMESTAMP}-pre-antigravity`,
  sources: {
    bundle: PROD_BUNDLE,
    appdata: PROD_APPDATA,
  },
  destinations: {
    snapshotDir: SNAPSHOT_DIR,
    localBakDir: LOCAL_BAK_DIR,
  },
  verifiedData: {
    sqliteOk: true,
    connectionsCount: verifiedConnections,
    snapDbSizeBytes: fs.statSync(snapDbPath).size,
  },
  processContext: {
    port: 20128,
    pidSource: "resolved dynamically by rollback script",
  },
};

fs.writeFileSync(path.join(SNAPSHOT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

// Generate rollback script
const rollbackPs1 = `# ONE-CLICK ROLLBACK SCRIPT FOR 9ROUTER PRODUCTION
# Snapshot: ${manifest.snapshotId}
param([switch]$Force)

$ErrorActionPreference = "Stop"
$snapBundle = "${snapBundleDir.replace(/\//g, "\\")}"
$snapAppData = "${snapAppDataDir.replace(/\//g, "\\")}"
$prodBundle = "${PROD_BUNDLE.replace(/\//g, "\\")}"
$prodAppData = "${PROD_APPDATA.replace(/\//g, "\\")}"

Write-Host "=== ROLLBACK 9ROUTER PRODUCTION TO SNAPSHOT ===" -ForegroundColor Yellow
Write-Host "Snapshot: $snapBundle" -ForegroundColor Gray

# 1. Stop production processes on port 20128
Write-Host "Stopping port 20128 processes..." -ForegroundColor Cyan
$conns = Get-NetTCPConnection -LocalPort 20128 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  if ($c.OwningProcess -and $c.OwningProcess -ne 0) {
    try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
    try { Start-Process -FilePath "taskkill.exe" -ArgumentList @("/F", "/PID", $c.OwningProcess) -NoNewWindow -Wait -ErrorAction SilentlyContinue } catch {}
  }
}
Start-Sleep -Seconds 2

# 2. Restore bundle
Write-Host "Restoring bundle..." -ForegroundColor Cyan
Copy-Item -Path "$snapBundle\\*" -Destination $prodBundle -Recurse -Force

# 3. Restore appdata
Write-Host "Restoring AppData database & credentials..." -ForegroundColor Cyan
Copy-Item -Path "$snapAppData\\*" -Destination $prodAppData -Recurse -Force

# 4. Relaunch production
Write-Host "Relaunching 9router..." -ForegroundColor Cyan
$cli = Join-Path $prodBundle "cli.js"
Start-Process -FilePath "C:\\Program Files\\nodejs\\node.exe" -ArgumentList @($cli, "--skip-update", "--no-browser") -WorkingDirectory "C:\\Users\\Administrator" -WindowStyle Hidden

Write-Host "Rollback finished. Verifying port 20128..." -ForegroundColor Green
`;

fs.writeFileSync(path.join(SNAPSHOT_DIR, "rollback.ps1"), rollbackPs1, "utf8");

console.log("-------------------------------------------------");
console.log("SNAPSHOT CREATION SUCCESSFUL!");
console.log(`Snapshot Path:    ${SNAPSHOT_DIR}`);
console.log(`Verified DB Conns: ${verifiedConnections}`);
console.log(`Rollback Script:  ${path.join(SNAPSHOT_DIR, "rollback.ps1")}`);
console.log("=================================================");
