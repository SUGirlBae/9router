# Restart Production 9router on Port 20128 ONLY
# SAFETY GUARANTEE: Never touches Port 20130 (Test instance PID)

$ErrorActionPreference = "SilentlyContinue"
$prodPort = 20128
$testPort = 20130
$cli = "C:\Users\Administrator\AppData\Roaming\npm\node_modules\9router\cli.js"
$log = "C:\Users\Administrator\Documents\Qoder\2026-11-03\10707d32\9router-restart.log"

Write-Host "=== RESTARTING 9ROUTER PRODUCTION (PORT $prodPort) ===" -ForegroundColor Cyan

function Terminate-PidSafe([int]$pidToKill) {
  if (-not $pidToKill -or $pidToKill -le 0 -or $pidToKill -eq $PID) { return }
  # Safety check: do not kill test port owner
  $testConn = Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue
  if ($testConn -and $testConn.OwningProcess -eq $pidToKill) {
    Write-Host "SAFETY ABORT: Refusing to kill PID $pidToKill (owns test port $testPort)!" -ForegroundColor Red
    return
  }
  Write-Host "Terminating process PID $pidToKill..." -ForegroundColor Yellow
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToKill" -ErrorAction SilentlyContinue
    if ($proc) { $proc | Invoke-CimMethod -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }
  } catch {}
  try { Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue } catch {}
  try { Start-Process -FilePath "taskkill.exe" -ArgumentList @("/F", "/PID", $pidToKill) -NoNewWindow -Wait -ErrorAction SilentlyContinue } catch {}
}

# 1. Graceful shutdown request
Write-Host "1. Requesting graceful shutdown on port $prodPort..." -ForegroundColor Gray
try { Invoke-RestMethod -Uri "http://127.0.0.1:$prodPort/api/shutdown" -Method Post -TimeoutSec 3 | Out-Null } catch {}
Start-Sleep -Seconds 2

# 2. Kill current port 20128 listeners
$conns = Get-NetTCPConnection -LocalPort $prodPort -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  if ($c.OwningProcess) {
    Terminate-PidSafe $c.OwningProcess
  }
}

# 2.1 Read launcher.pid to also terminate launcher if running
$pidFile = "C:\Users\Administrator\AppData\Roaming\9router\launcher.pid"
if (Test-Path $pidFile) {
  try {
    $content = Get-Content $pidFile -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($content.cliPid) { Terminate-PidSafe $content.cliPid }
    if ($content.serverPid) { Terminate-PidSafe $content.serverPid }
  } catch {}
}

# 3. Wait for port 20128 to release
Write-Host "2. Waiting for port $prodPort to release..." -ForegroundColor Gray
for ($i = 0; $i -lt 10; $i++) {
  $bound = Get-NetTCPConnection -LocalPort $prodPort -State Listen -ErrorAction SilentlyContinue
  if (-not $bound) { break }
  Start-Sleep -Seconds 1
}

$bound = Get-NetTCPConnection -LocalPort $prodPort -State Listen -ErrorAction SilentlyContinue
if ($bound) {
  Write-Host "ERROR: Port $prodPort is still in use by PID $($bound.OwningProcess)" -ForegroundColor Red
  exit 1
}
Write-Host "Port $prodPort is completely free." -ForegroundColor Green

# 4. Relaunch production via cli.js
Write-Host "3. Relaunching 9router Production..." -ForegroundColor Cyan
Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
  -ArgumentList @($cli, "--skip-update", "--no-browser") `
  -WorkingDirectory "C:\Users\Administrator" `
  -WindowStyle Hidden `
  -RedirectStandardOutput $log `
  -RedirectStandardError ($log + ".err")

# 5. Wait for readiness
Write-Host "4. Polling health on port $prodPort..." -ForegroundColor Gray
$up = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 1
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$prodPort/api/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($h.ok) {
      $up = $true
      break
    }
  } catch {}
}

if ($up) {
  $newConn = Get-NetTCPConnection -LocalPort $prodPort -State Listen -ErrorAction SilentlyContinue
  Write-Host "9router Production is UP and HEALTHY!" -ForegroundColor Green
  Write-Host "  Port:   $prodPort" -ForegroundColor Green
  Write-Host "  PID:    $($newConn.OwningProcess)" -ForegroundColor Green
  Write-Host "  Health: http://127.0.0.1:$prodPort/api/health" -ForegroundColor Green
} else {
  Write-Host "WARNING: 9router Production did not respond healthy within 25s. Check log at $log" -ForegroundColor Red
  exit 1
}

# 6. Verify test port is still alive
$testCheck = Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue
if ($testCheck) {
  Write-Host "Test instance on port $testPort is also running normally (PID $($testCheck.OwningProcess))." -ForegroundColor Green
} else {
  Write-Host "Note: Test instance on port $testPort is not listening." -ForegroundColor Yellow
}
