# Fully relaunches the toolchain after (re)starting Project64:
#   1. kills the old bridge and viewer - port owners on 8081/5173, any bridge
#      node wedged on a dead PJ64 without a port, and the leftover 'IWV *'
#      console windows from earlier launches,
#   2. starts the bridge in its own window,
#   3. starts the Vite dev server in its own window,
#   4. opens the viewer once the dev server actually answers.
# Usage: .\start.ps1   (or double-click start.cmd)

$root = $PSScriptRoot

# Kill whatever owns the bridge/viewer ports. No -State filter: a listener
# wedged on a dead emulator can be missed by -State Listen but still owns it.
foreach ($port in 8081, 5173) {
  $owners = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $owners) {
    if ($procId -gt 0) {
      Write-Host "Killing stale process (pid $procId) on port $port"
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
  }
}

# A bridge attached to a dead PJ64 can wedge on the process handle WITHOUT
# holding its port - catch any bridge node by command line too.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$root\bridge*" } |
  ForEach-Object {
    Write-Host "Killing wedged bridge node (pid $($_.ProcessId))"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

# Close leftover console windows from earlier launches (-NoExit keeps them
# open after their npm child dies).
Get-Process powershell, pwsh -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like 'IWV *' } |
  ForEach-Object {
    Write-Host "Closing old window '$($_.MainWindowTitle)' (pid $($_.Id))"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }

Write-Host "Starting bridge..."
Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle = 'IWV bridge'; Set-Location '$root\bridge'; npm start"
)

Write-Host "Starting viewer server..."
Start-Process powershell -ArgumentList @(
  "-NoExit", "-Command", "`$Host.UI.RawUI.WindowTitle = 'IWV viewer'; Set-Location '$root'; npm run dev"
)

# Open the browser once Vite answers (up to ~15 s), not on a blind timer.
$up = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) {
    $up = $true
    break
  }
}
if ($up) {
  Start-Process "http://localhost:5173"
} else {
  Write-Host "Vite didn't come up on 5173 within 15s - check the 'IWV viewer' window."
}

Write-Host "Viewer: http://localhost:5173  (click 'Connect to Project64' once PJ64 is in-game)"
