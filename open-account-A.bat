@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Open-AccountWindow.ps1" -Profile A
if errorlevel 1 (
  echo.
  echo Failed. Read the error above.
  pause
  exit /b 1
)
exit /b 0
