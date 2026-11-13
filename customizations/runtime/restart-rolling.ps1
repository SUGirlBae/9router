# 9Router-fork Zero-Downtime Rolling Upgrade
# Blue/Green worker reload for the CUSTOM instance on port 20130 (%APPDATA%\9router-fork).
#
# IMPORTANT: this script NEVER touches port 20128 or %APPDATA%\9router — that is the
# pristine stock instance. Defaults follow $env:ROUTER_FORK_PORT / $env:ROUTER_FORK_DATA_DIR
# so the script works wherever the fork is installed.
param(
    [string]$SlotServerPathA,
    [string]$SlotServerPathB,
    [int]$Port = 0
)

$ErrorActionPreference = "SilentlyContinue"

if ($Port -le 0) {
    $Port = if ($env:ROUTER_FORK_PORT) { [int]$env:ROUTER_FORK_PORT } else { 20130 }
}
if ($Port -eq 20128) {
    Write-Output "Refusing to run: port 20128 belongs to the stock 9router instance. Use 9router's own upgrade path."
    exit 2
}

$slotA = $Port + 1
$slotB = $Port + 2
$forkData = if ($env:ROUTER_FORK_DATA_DIR) {
    $env:ROUTER_FORK_DATA_DIR
} else {
    $appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE "AppData\Roaming" }
    Join-Path $appData "9router-fork"
}

$hasVersionedPaths = -not [string]::IsNullOrWhiteSpace($SlotServerPathA) -or -not [string]::IsNullOrWhiteSpace($SlotServerPathB)
if ($SlotServerPathA -and -not (Test-Path $SlotServerPathA -PathType Leaf)) {
    Write-Output "SlotServerPathA does not exist: $SlotServerPathA"
    exit 2
}
if ($SlotServerPathB -and -not (Test-Path $SlotServerPathB -PathType Leaf)) {
    Write-Output "SlotServerPathB does not exist: $SlotServerPathB"
    exit 2
}

$gatewayUrl = "http://127.0.0.1:$Port/_gateway"
$healthUrl = "http://127.0.0.1:$Port/api/health"
$logFile = Join-Path $forkData "logs\gateway.log"
$errFile = Join-Path $forkData "logs\gateway.err.log"

Write-Output "[9Router-fork Rolling Upgrade] Checking if Master Gateway is active on port $Port..."

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

# Cold start: fork gateway is not currently running on $Port
Write-Output "[9Router-fork Rolling Upgrade] Launching fork Zero-Downtime Master Supervisor..."

$gatewayScript = Join-Path $forkData "runtime\9r-zero-downtime-gateway.js"
if (-not (Test-Path $gatewayScript)) {
    $gatewayScript = "D:\9router\customizations\gateway\9r-zero-downtime-gateway.js"
}
if (-not (Test-Path $gatewayScript)) {
    Write-Output "Gateway script not found at $gatewayScript"
    exit 2
}

# Free ONLY this fork's ports; a process that does not look like the fork is left alone.
foreach ($p in @($Port, $slotA, $slotB)) {
    try {
        $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            if ($c.OwningProcess -and $c.OwningProcess -ne 0) {
                $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
                if ($proc -and $proc.CommandLine -match "9router-fork|9r-zero-downtime-gateway") {
                    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
                } else {
                    Write-Output ("[9Router-fork Rolling Upgrade] Port $p held by a non-fork process (PID " + $c.OwningProcess + "); leaving it alone.")
                }
            }
        }
    } catch { }
}
Start-Sleep -Seconds 1

# Launch Master Gateway
$nodeExe = "C:\Program Files\nodejs\node.exe"
$logDir = Split-Path $logFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$env:PORT = "$Port"
$env:TUNNEL_LOCAL_PORT = "$Port"
$env:DATA_DIR = $forkData
if ($SlotServerPathA) { $env:SLOT_SERVER_PATH_A = $SlotServerPathA }
if ($SlotServerPathB) { $env:SLOT_SERVER_PATH_B = $SlotServerPathB }
Start-Process -FilePath $nodeExe -ArgumentList @($gatewayScript) -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errFile

Write-Output "[9Router-fork Rolling Upgrade] Waiting for Master Gateway + Worker A to become healthy..."
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
    Write-Output ("9Router-fork Zero-Downtime Gateway ONLINE on http://127.0.0.1:$Port (Active Slot: " + $st.activeSlot + ", Port: " + $st.activePort + ")")
} else {
    Write-Output "Gateway failed to respond within timeout. Check logs at $errFile"
    exit 1
}
