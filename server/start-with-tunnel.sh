#!/bin/bash
# 一键启动：联机中转服务器 + cpolar 隧道（Linux 主用启动方式）
# 用法：chmod +x start-with-tunnel.sh && ./start-with-tunnel.sh
# 前提：已安装 cpolar 并执行过 cpolar authtoken <你的token>
# Ctrl+C 会同时关掉 cpolar 和中转服务器

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
    echo "首次运行，安装依赖…"
    npm install
fi

node relay-server.mjs &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null" EXIT

sleep 1
echo "正在启动 cpolar 隧道（http 8080）…"
cpolar http 8080
