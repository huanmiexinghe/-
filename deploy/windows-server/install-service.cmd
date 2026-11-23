@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "magnetic-rush-server.exe" (
  echo [ERROR] WinSW is missing.
  echo         Download WinSW-x64.exe, rename it to magnetic-rush-server.exe, put it here.
  echo         https://github.com/winsw/winsw/releases
  pause
  exit /b 1
)
if not exist "node_modules\ws" (
  echo [ERROR] Dependencies are missing. Run: npm ci --omit=dev
  pause
  exit /b 1
)

echo [1/4] Removing any previous service instance
"%~dp0magnetic-rush-server.exe" stop
"%~dp0magnetic-rush-server.exe" uninstall

echo [2/4] Installing service - auto start on boot + restart on crash
"%~dp0magnetic-rush-server.exe" install
if errorlevel 1 (
  echo [ERROR] Install failed. Run this script as Administrator.
  pause
  exit /b 1
)

echo [3/4] Starting service
"%~dp0magnetic-rush-server.exe" start

echo [4/4] Current status
sc query magnetic-rush-server
echo.
echo Logs: logs\magnetic-rush-server.out.log and .err.log
pause
