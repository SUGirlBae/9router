param([switch]$ForceCold)
$ErrorActionPreference = "SilentlyContinue"
$cli = "C:\Users\Administrator\AppData\Roaming\npm\node_modules\9router\cli.js"
$log = "C:\Users\Administrator\Documents\Qoder\2026-11-03\10707d32\9router-restart.log"

if (-not $ForceCold) {
  try {
    $gw = Invoke-RestMethod -Uri "http://127.0.0.1:20128/_gateway/status" -TimeoutSec 2
    if ($gw.activeSlot) {
      Write-Output ("Zero-Downtime Gateway active (Slot: " + $gw.activeSlot + ", Port: " + $gw.activePort + "). Triggering rolling upgrade...")
      $rel = Invoke-RestMethod -Uri "http://127.0.0.1:20128/_gateway/reload" -Method Post -TimeoutSec 50
      if ($rel.status -eq "success") {
        Write-Output ("Rolling upgrade complete! Switched to Slot " + $rel.switchedTo + " (Port " + $rel.activePort + ") with 0 downtime.")
        exit 0
      }
    }
  } catch { }
}

Write-Output "requesting graceful shutdown"
try { Invoke-RestMethod -Uri "http://127.0.0.1:20128/api/shutdown" -Method Post -TimeoutSec 3 | Out-Null } catch { }
Start-Sleep -Seconds 2

function Terminate-ProcessFast($pidToKill) {
  if (-not $pidToKill -or $pidToKill -eq 0 -or $pidToKill -eq $PID) { return }
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToKill" -ErrorAction SilentlyContinue
    if ($proc) {
      $proc | Invoke-CimMethod -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null
    }
  } catch { }
  try { Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue } catch { }
  try { Start-Process -FilePath "taskkill.exe" -ArgumentList @("/F", "/PID", $pidToKill) -NoNewWindow -Wait -ErrorAction SilentlyContinue } catch { }
}

# 1. Kill any process currently listening on port 20128, 20131, 20132
try {
  $conns = Get-NetTCPConnection -LocalPort 20128,20131,20132 -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    if ($c.OwningProcess -and $c.OwningProcess -ne 0) {
      Write-Output ("killing process on port " + $c.LocalPort + ": PID " + $c.OwningProcess)
      Terminate-ProcessFast $c.OwningProcess
    }
  }
} catch { }

# 2. Terminate matching 9router node processes
$targets = Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -like "*9router*" -or $_.CommandLine -like "*9r-net-keeper*"
}
foreach ($t in $targets) {
  Write-Output ("stopping PID " + $t.ProcessId)
  Terminate-ProcessFast $t.ProcessId
}

# 2.1 Clean up any orphan chrome processes holding 9router profiles
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -like "*browser-profiles*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# 3. Wait until port 20128 is completely released
for ($i = 0; $i -lt 5; $i++) {
  $bound = Get-NetTCPConnection -LocalPort 20128 -State Listen -ErrorAction SilentlyContinue
  if (-not $bound) { break }
  Start-Sleep -Seconds 1
}

Write-Output "relaunching cli.js detached"
Start-Process -FilePath "C:\Program Files\nodejs\node.exe" -ArgumentList @($cli, "--skip-update", "--no-browser") -WorkingDirectory "C:\Users\Administrator" -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError ($log + ".err")
Start-Sleep -Seconds 3

$up = $false
for ($i = 0; $i -lt 15; $i++) {
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:20128/api/health" -TimeoutSec 2
    if ($h.ok) {
      $up = $true
      break
    }
  } catch { Start-Sleep -Seconds 2 }
}
Write-Output ("router up: " + $up)
$procs = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match "9router" -or $_.CommandLine -match "9r-net-keeper" }
foreach ($p in $procs) {
  $c = $p.CommandLine
  if ($c -and $c.Length -gt 150) { $c = $c.Substring(0,150) }
  Write-Output ("PID=" + $p.ProcessId + " | " + $c)
}
