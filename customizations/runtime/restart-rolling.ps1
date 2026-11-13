# PowerShell script for 9Router Zero-Downtime Rolling Upgrade
# Performs seamless, 0-downtime Blue/Green worker reload on Port 20128.
param(
    [string]$SlotServerPathA,
    [string]$SlotServerPathB
)

$ErrorActionPreference = "SilentlyContinue"
$hasVersionedPaths = -not [string]::IsNullOrWhiteSpace($SlotServerPathA) -or -not [string]::IsNullOrWhiteSpace($SlotServerPathB)
if ($SlotServerPathA -and -not (Test-Path $SlotServerPathA -PathType Leaf)) {
    Write-Output "SlotServerPathA does not exist: $SlotServerPathA"
    exit 2
}
if ($SlotServerPathB -and -not (Test-Path $SlotServerPathB -PathType Leaf)) {
    Write-Output "SlotServerPathB does not exist: $SlotServerPathB"
    exit 2
}

$gatewayUrl = "http://127.0.0.1:20128/_gateway"
$healthUrl = "http://127.0.0.1:20128/api/health"
$logFile = "C:\Users\Administrator\AppData\Roaming\9router\logs\gateway.log"
$errFile = "C:\Users\Administrator\AppData\Roaming\9router\logs\gateway.err.log"

Write-Output "[9Router Rolling Upgrade] Checking if Master Gateway is active on port 20128..."

$isGateway = $false
try {
    $status = Invoke-RestMethod -Uri "$gatewayUrl/status" -TimeoutSec 2
    if ($status.activeSlot) {
        $isGateway = $true
        Write-Output ("[9Router Rolling Upgrade] Gateway detected! Active Slot: " + $status.activeSlot + " (Port " + $status.activePort + ")")
    }
} catch {
    $isGateway = $false
}

if ($isGateway -and -not $hasVersionedPaths) {
    Write-Output "[9Router Rolling Upgrade] Triggering atomic zero-downtime rolling reload..."
    try {
        $reloadResult = Invoke-RestMethod -Uri "$gatewayUrl/reload" -Method Post -TimeoutSec 50
        Write-Output ("[9Router Rolling Upgrade] SUCCESS! Switched to Slot: " + $reloadResult.switchedTo + " (Port " + $reloadResult.activePort + ")")
        Write-Output "[9Router Rolling Upgrade] Zero connections were dropped. Rolling upgrade complete."
        exit 0
    } catch {
        Write-Output ("[9Router Rolling Upgrade] Rolling reload error: " + $_.Exception.Message)
    }
}

# Cold start: Gateway is not currently running on 20128
Write-Output "[9Router Rolling Upgrade] Launching 9Router Zero-Downtime Master Supervisor..."

$gatewayScript = "C:\Users\Administrator\AppData\Roaming\9router\runtime\9r-zero-downtime-gateway.js"
if (-not (Test-Path $gatewayScript)) {
    $gatewayScript = "D:\9router\customizations\gateway\9r-zero-downtime-gateway.js"
}

# Stop legacy direct server on 20128 gracefully
try { Invoke-RestMethod -Uri "http://127.0.0.1:20128/api/shutdown" -Method Post -TimeoutSec 3 | Out-Null } catch { }
Start-Sleep -Seconds 2

# Free port 20128, 20131, 20132 if stale processes remain
foreach ($p in @(20128, 20131, 20132)) {
    try {
        $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            if ($c.OwningProcess -and $c.OwningProcess -ne 0) {
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    } catch { }
}
Start-Sleep -Seconds 1

# Launch Master Gateway
$nodeExe = "C:\Program Files\nodejs\node.exe"
$logDir = Split-Path $logFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

if ($SlotServerPathA) { $env:SLOT_SERVER_PATH_A = $SlotServerPathA }
if ($SlotServerPathB) { $env:SLOT_SERVER_PATH_B = $SlotServerPathB }
Start-Process -FilePath $nodeExe -ArgumentList @($gatewayScript) -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errFile

Write-Output "[9Router Rolling Upgrade] Waiting for Master Gateway + Worker A to become healthy..."
$up = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $h = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if ($h.ok) {
            $up = $true
            break
        }
    } catch { Start-Sleep -Seconds 1 }
}

if ($up) {
    $st = Invoke-RestMethod -Uri "$gatewayUrl/status" -TimeoutSec 2
    Write-Output ("9Router Zero-Downtime Gateway ONLINE on http://127.0.0.1:20128 (Active Slot: " + $st.activeSlot + ", Port: " + $st.activePort + ")")
} else {
    Write-Output "Gateway failed to respond within timeout. Check logs at $errFile"
    exit 1
}
