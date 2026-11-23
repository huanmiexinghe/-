#!/usr/bin/env bash
# Magnetic Rush 联机中转服务 · 健康检查（服务器本机执行）
#
# 用法：bash check-health.sh
#   查服务状态 → 端口监听 → HTTP 接口 → WebSocket 握手（需本机已装 node 与 ws）
# 退出码 0 = 全部通过，非 0 = 有项目失败（脚本会打印日志尾部）。

set -uo pipefail

APP_NAME="magnetic-rush-relay"
APP_DIR="/opt/magnetic-rush"
ENV_FILE="/etc/magnetic-rush/relay.env"

PORT="$(sed -n 's/^PORT=//p' "${ENV_FILE}" 2>/dev/null | tail -n1 | tr -d '[:space:]')"
PORT="${PORT:-8080}"
BASE="http://127.0.0.1:${PORT}"

fail=0
pass() { printf '  \033[1;32mOK\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=1; }
info() { printf '  ---- %s\n' "$*"; }

echo "== 服务状态 =="
STATE="$(systemctl is-active "${APP_NAME}" 2>/dev/null || true)"
if [[ "${STATE}" == "active" ]]; then pass "systemd: active"; else bad "systemd: ${STATE:-unknown}（sudo systemctl status ${APP_NAME}）"; fi

echo "== 端口监听 =="
if ss -lnt 2>/dev/null | grep -qE ":${PORT}\b"; then
  pass "本机已监听 TCP ${PORT}"
  ss -lntp 2>/dev/null | grep -E ":${PORT}\b" | sed 's/^/       /'
else
  bad "没有进程监听 TCP ${PORT}（端口被改过？查 ${ENV_FILE}）"
fi

echo "== HTTP 接口 =="
check_code() {
  local path="$1" expect="$2" desc="$3"
  local code
  code="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "${BASE}${path}" 2>/dev/null || echo 000)"
  if [[ ",${expect}," == *",${code},"* ]]; then
    pass "${desc} ${path} → HTTP ${code}"
  else
    bad "${desc} ${path} → HTTP ${code}（期望 ${expect}）"
  fi
}
check_code "/api/levels" "200" "关卡接口"
check_code "/privacy.html" "200" "隐私政策页"
check_code "/admin/login" "200" "后台登录页"
check_code "/admin" "200,303" "后台入口（未登录会 303 到 /admin/login）"

echo "== WebSocket 握手 =="
if command -v node >/dev/null 2>&1 && [[ -d "${APP_DIR}/node_modules/ws" ]]; then
  OUT="$(cd "${APP_DIR}" && timeout 10 node --input-type=module -e "
import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:${PORT}');
const done = (code, msg) => { console.log(msg); process.exit(code); };
ws.on('message', d => done(0, String(d).slice(0, 200)));
ws.on('error', e => done(1, 'ERR ' + e.message));
setTimeout(() => done(1, 'TIMEOUT'), 8000);
" 2>&1 || true)"
  if [[ "${OUT}" == *'"type":"hello"'* ]]; then
    pass "收到 hello：${OUT}"
  else
    bad "未收到 hello：${OUT}"
  fi
else
  info "本机没有 node 或 ${APP_DIR}/node_modules/ws，跳过握手检查"
fi

echo
if [[ ${fail} -ne 0 ]]; then
  echo "== 最近的日志（journalctl -u ${APP_NAME} -n 40）=="
  journalctl -u "${APP_NAME}" -n 40 --no-pager 2>/dev/null || true
  exit 1
fi
echo "全部通过。外网验证见 README 第 8 节。"
