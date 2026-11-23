@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "magnetic-rush-server.exe" (
  echo [ERROR] magnetic-rush-server.exe not found in this folder.
  pause
  exit /b 1
)

echo [1/2] Stopping service
"%~dp0magnetic-rush-server.exe" stop

echo [2/2] Removing service
"%~dp0magnetic-rush-server.exe" uninstall

echo.
echo Service removed. Program files, data\ and logs\ are kept.
echo Delete the whole folder manually if you want a full cleanup - back up data\ first.
pause
