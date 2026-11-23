# 一键启动：联机中转服务器 + cpolar 隧道（Windows 主用启动方式）
# 用法：右键"使用 PowerShell 运行"，或在 server 目录执行 .\start-with-tunnel.ps1
# 服务器窗口会自动识别 cpolar 隧道并打印 wss 公网地址（玩家填的那个）
# 前提：已安装 cpolar 并执行过 cpolar authtoken <你的token>，且本机 8080 端口空闲

Set-Location $PSScriptRoot

if (-not (Test-Path "node_modules")) {
    Write-Host "首次运行，安装依赖…" -ForegroundColor Cyan
    npm install
}

# 中转服务器放到独立窗口（它会自动探测并打印隧道地址）
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot'; node relay-server.mjs"

Start-Sleep -Seconds 1
Write-Host "正在启动 cpolar 隧道（http 8080）… 本窗口保持开启即保持联机" -ForegroundColor Cyan
cpolar http 8080
