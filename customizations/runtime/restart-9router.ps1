$ErrorActionPreference = "SilentlyContinue"
$cli = "C:\Users\Administrator\AppData\Roaming\npm\node_modules\9router\cli.js"
$log = "C:\Users\Administrator\Documents\Qoder\2026-11-03\10707d32\9router-restart.log"

Write-Output "requesting graceful shutdown"
try { Invoke-RestMethod -Uri "http://127.0.0.1:20128/api/shutdown" -Method Post -TimeoutSec 8 | Out-Null } catch { Write-Output ("shutdown call: " + $_.Exception.Message) }
Start-Sleep -Seconds 4

$targets = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
  $_.CommandLine -match "9router[\\/]cli\.js" -or $_.CommandLine -match "9router\\app\\custom-server\.js" -or $_.CommandLine -match "9router/runtime/mitm"
}
foreach ($t in $targets) {
  Write-Output ("stopping PID " + $t.ProcessId)
  Stop-Process -Id $t.ProcessId -Force
}
Start-Sleep -Seconds 2

Write-Output "relaunching cli.js detached"
Start-Process -FilePath "C:\Program Files\nodejs\node.exe" -ArgumentList @($cli, "--skip-update", "--no-browser") -WorkingDirectory "C:\Users\Administrator" -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError ($log + ".err")
Start-Sleep -Seconds 3

$up = $false
for ($i = 0; $i -lt 12; $i++) {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:20128/api/health" -TimeoutSec 2 | Out-Null
    $up = $true
    break
  } catch { Start-Sleep -Seconds 2 }
}
Write-Output ("router up: " + $up)
$procs = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match "9router" -or $_.CommandLine -match "9r-net-keeper" }
foreach ($p in $procs) {
  $c = $p.CommandLine
  if ($c.Length -gt 150) { $c = $c.Substring(0,150) }
  Write-Output ("PID=" + $p.ProcessId + " | " + $c)
}
