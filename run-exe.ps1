# Runs the packaged viewer (dist-exe\InvisibleWallViewer.exe) for testing.
# If any code the exe is built from changed since the last build, the exe is
# rebuilt first (seconds to a minute), so this always runs the current code. Then it
# starts the exe, which opens the viewer in your browser with the ground-truth
# capture panel enabled.
#
#   run-exe.cmd                      double-click (or the desktop shortcut)
#   .\run-exe.ps1 -Rebuild           rebuild even if nothing changed
#   .\run-exe.ps1 -NoOpen            don't open the browser
#   .\run-exe.ps1 -Port 8082         serve on another port
#
# Keep this file ASCII: Windows PowerShell 5.1 reads a script without a BOM in
# the system codepage, and one non-ASCII character in a string breaks parsing.

param(
  [switch]$Rebuild,
  [switch]$NoOpen,
  [int]$Port = 8081
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$exe = Join-Path $root 'dist-exe\InvisibleWallViewer.exe'

# Everything the exe is built from (scripts\buildExe.mjs packs the viewer build
# together with bridge\src\standalone.ts).
$inputs = @(
  'src', 'bridge\src', 'index.html', 'vite.config.ts', 'tsconfig.json',
  'package.json', 'package-lock.json', 'bridge\package.json', 'scripts\buildExe.mjs'
) | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }

function Get-NewestInputTime {
  $newest = [datetime]::MinValue
  foreach ($path in $inputs) {
    if (Test-Path $path -PathType Container) {
      $items = Get-ChildItem $path -Recurse -File
    } else {
      $items = Get-Item $path
    }
    foreach ($item in $items) {
      if ($item.LastWriteTime -gt $newest) { $newest = $item.LastWriteTime }
    }
  }
  return $newest
}

$reason = $null
if ($Rebuild) {
  $reason = 'rebuild requested'
} elseif (-not (Test-Path $exe)) {
  $reason = 'no exe built yet'
} elseif ((Get-NewestInputTime) -gt (Get-Item $exe).LastWriteTime) {
  $reason = 'the code changed since the last build'
}

if ($reason) {
  # The build can't replace an exe that is running, and a stale instance would
  # keep serving the old code anyway.
  $running = Get-Process InvisibleWallViewer -ErrorAction SilentlyContinue
  if ($running) {
    Write-Host 'Stopping the running viewer...'
    $running | Stop-Process -Force
    $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
  }
  Write-Host "Building the exe ($reason) - this can take up to a minute..."
  Push-Location $root
  try {
    & npm run build:exe
    if ($LASTEXITCODE -ne 0) { throw "the build failed (exit code $LASTEXITCODE) - see above" }
  } finally {
    Pop-Location
  }
}

# The dev bridge (start.cmd) listens on the same port and the exe can't share
# it. Our own exe holding the port is fine: starting it again just reopens the
# browser. (No -State filter: a listener wedged on a dead emulator can be
# missed by -State Listen.)
$owners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $owners) {
  if ($procId -le 0) { continue }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  if ($proc -and $proc.Name -eq 'node.exe' -and $proc.CommandLine -like "*$root\bridge*") {
    Write-Host "Stopping the dev bridge (pid $procId) - it holds port $Port."
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
}

$exeArgs = @("--port=$Port", '--capture')
if ($NoOpen) { $exeArgs += '--no-open' }
Write-Host "Starting $exe"
Start-Process -FilePath $exe -ArgumentList $exeArgs -WorkingDirectory (Split-Path $exe)
