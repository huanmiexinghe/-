#!/usr/bin/env bash
# Magnetic Rush 联机中转服务 · 升级脚本
#
# 用法：
#   sudo bash upgrade.sh /path/to/新版部署包目录
#   例：把新包解压到 /root/magnetic-rush-server-linux，然后
#       sudo bash upgrade.sh /root/magnetic-rush-server-linux
#
# 做的事：
#   1. 把当前 /opt/magnetic-rush 的程序文件备份到 /var/backups/magnetic-rush/<时间戳>/
#   2. 停服务 → 覆盖程序文件（不碰数据目录、不碰 relay.env）
#   3. npm ci --omit=dev → 启动 → 本机自检
#   4. 失败时打印回滚命令（回滚只换程序，不动数据）
#   仅保留最近 5 份备份。

set -euo pipefail

APP_NAME="magnetic-rush-relay"
APP_DIR="/opt/magnetic-rush"
ENV_FILE="/etc/magnetic-rush/relay.env"
BACKUP_DIR="/var/backups/magnetic-rush"

log()  { printf '\033[1;32m[upgrade]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[upgrade]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[upgrade]\033[0m %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "请用 root 运行：sudo bash upgrade.sh <新版部署包目录>"
NEW_DIR="${1:-}"
[[ -n "${NEW_DIR}" ]] || die "用法：sudo bash upgrade.sh <新版部署包目录>（目录里要有 app/relay-server.mjs）"
NEW_DIR="$(cd "${NEW_DIR}" && pwd)"
PKG_APP="${NEW_DIR}/app"

[[ -f "${PKG_APP}/relay-server.mjs" ]] || die "新版包里找不到 app/relay-server.mjs：${PKG_APP}"
[[ -f "${PKG_APP}/public/admin.html" ]] || die "新版包里找不到 app/public/admin.html：${PKG_APP}"
systemctl cat "${APP_NAME}" >/dev/null 2>&1 || die "服务 ${APP_NAME} 未安装，请先运行 install.sh"
[[ -f "${ENV_FILE}" ]] || die "缺少 ${ENV_FILE}，请先运行 install.sh"

# ---------- 1. 备份当前版本 ----------
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="${BACKUP_DIR}/${TS}"
install -d -m 0700 -o root -g root "${BACKUP_DIR}"
install -d -m 0700 -o root -g root "${BACKUP}"
cp -a "${APP_DIR}"/*.mjs "${APP_DIR}/package.json" "${APP_DIR}/package-lock.json" "${BACKUP}/"
cp -a "${APP_DIR}/public" "${BACKUP}/"
log "当前版本已备份到 ${BACKUP}"

# ---------- 2. 停服务并覆盖程序文件 ----------
log "停止服务"
systemctl stop "${APP_NAME}"

log "覆盖程序文件（数据目录与 relay.env 保持不变）"
install -m 0644 "${PKG_APP}"/*.mjs "${APP_DIR}/"
install -m 0644 "${PKG_APP}/package.json" "${PKG_APP}/package-lock.json" "${APP_DIR}/"
install -m 0644 "${PKG_APP}"/public/*.html "${APP_DIR}/public/"
if [[ -f "${NEW_DIR}/README.md" ]]; then
  install -m 0644 "${NEW_DIR}/README.md" "${APP_DIR}/README.md"
fi

log "安装依赖：npm ci --omit=dev"
( cd "${APP_DIR}" && npm ci --omit=dev --no-audit --no-fund )

# ---------- 3. 启动并自检 ----------
log "启动服务"
systemctl restart "${APP_NAME}" || true

PORT="$(sed -n 's/^PORT=//p' "${ENV_FILE}" | tail -n1 | tr -d '[:space:]')"
PORT="${PORT:-8080}"
ok=0
for _ in $(seq 1 30); do
  sleep 0.5
  if curl -fsS -m 2 "http://127.0.0.1:${PORT}/api/levels" >/dev/null 2>&1; then ok=1; break; fi
done

# 只保留最近 5 份备份（最早的先删）
ls -1dt "${BACKUP_DIR}"/20* 2>/dev/null | tail -n +6 | while read -r old; do
  rm -rf "${old}"
done || true

echo
if [[ ${ok} -eq 1 ]]; then
  log "升级完成并通过本机自检（http://127.0.0.1:${PORT}/api/levels）"
  log "如需回滚：sudo bash rollback.sh ${TS}"
else
  warn "升级后自检失败，数据未受影响。查看日志："
  warn "  sudo journalctl -u ${APP_NAME} -n 80 --no-pager"
  warn "回滚到升级前：sudo bash rollback.sh ${TS}"
  exit 1
fi
