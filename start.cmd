@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if %ERRORLEVEL% neq 0 (
  echo.
  echo start.ps1 exited with an error - see above.
  pause
)
