@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Copy-Token.ps1"
if errorlevel 1 (
  echo.
  echo Operation failed. Read the error above.
  pause
  exit /b 1
)
pause
