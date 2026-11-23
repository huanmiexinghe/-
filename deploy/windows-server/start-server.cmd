@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Load relay.env (skip blank lines and lines starting with #)
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0relay.env") do (
  if not "%%~A"=="" set "%%~A=%%~B"
)

if "%NODE_EXE%"=="" set "NODE_EXE=node"
if "%PORT%"=="" set "PORT=8080"
if "%HOST%"=="" set "HOST=127.0.0.1"
if "%LEVELS_DIR%"=="" set "LEVELS_DIR=data"

echo ============================================================
echo  Magnetic Rush relay server - foreground mode
echo  PORT=%PORT%  HOST=%HOST%  LEVELS_DIR=%LEVELS_DIR%
echo  Health check: run check-health.cmd in another window
echo  Closing this window stops the server.
echo ============================================================
echo.

"%NODE_EXE%" relay-server.mjs

echo.
echo [exit] node exited with code %ERRORLEVEL%
pause
