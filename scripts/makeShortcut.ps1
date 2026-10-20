# Puts a "SM64 Invisible Wall Viewer" shortcut on your desktop. It runs
# run-exe.cmd: rebuild the exe if the code changed, then start it.
#
#   npm run shortcut
#
# Keep this file ASCII (see run-exe.ps1).

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'SM64 Invisible Wall Viewer.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = Join-Path $root 'run-exe.cmd'
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'Run the SM64 Invisible Wall Viewer (rebuilt first if the code changed)'
# The exe's own icon; until the first build exists, the default .cmd icon.
$exe = Join-Path $root 'dist-exe\InvisibleWallViewer.exe'
if (Test-Path $exe) { $shortcut.IconLocation = "$exe,0" }
$shortcut.Save()
Write-Host "Created $link"
