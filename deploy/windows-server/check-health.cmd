@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Load relay.env (skip blank lines and lines starting with #)
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0relay.env") do (
  if not "%%~A"=="" set "%%~A=%%~B"
)
if "%PORT%"=="" set "PORT=8080"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='http://127.0.0.1:%PORT%/api/levels'; try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 $u; Write-Host ('OK  HTTP ' + [int]$r.StatusCode + '  <=  ' + $u) -ForegroundColor Green; Write-Host $r.Content } catch { $c=0; if ($_.Exception.Response) { $c=[int]$_.Exception.Response.StatusCode }; Write-Host ('FAIL  HTTP ' + $c + '  <=  ' + $u) -ForegroundColor Red; Write-Host $_.Exception.Message; exit 1 }"

echo.
echo Exit code: %ERRORLEVEL%  - 0 means server is OK, 1 means request failed
pause
