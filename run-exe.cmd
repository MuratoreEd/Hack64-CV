@echo off
rem Runs the packaged viewer, rebuilding the exe first if the code changed.
rem See run-exe.ps1 for options.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-exe.ps1" %*
if %ERRORLEVEL% neq 0 (
  echo.
  echo run-exe.ps1 exited with an error - see above.
  pause
)
