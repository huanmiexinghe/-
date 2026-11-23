#!/usr/bin/env bash
# Magnetic Rush 联机中转服务 · 回滚脚本
#
# 用法：
#   sudo bash rollback.sh            # 回到最近一次备份（upgrade.sh 自动生成）
#   sudo bash rollback.sh 20261120-153000   # 回到指定备份
#   sudo bash rollback.sh --list     # 只列出可用备份
#
# 回滚只替换程序文件（*.mjs / package*.json / public/），
# 不碰数据目录 /var/lib/magnetic-rush，也不碰 /etc/magnetic-rush/relay.env。

set -euo pipefail

APP_NAME="magnetic-rush-relay"
APP_DIR="/opt/magnetic-rush"
ENV_FILE="/etc/magnetic-rush/relay.env"
BACKUP_DIR="/var/backups/magnetic-rush"

log()  { printf '\033[1;32m[rollback]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[rollback]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[rollback]\033[0m %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "请用 root 运行：sudo bash rollback.sh [备份时间戳]"

if [[ ! -d "${BACKUP_DIR}" ]]; then
  die "没有备份目录 ${BACKUP_DIR}（还没执行过 upgrade.sh？）"
fi

mapfile -t BACKUPS < <(ls -1dt "${BACKUP_DIR}"/20* 2>/dev/null || true)

if [[ "${1:-}" == "--list" ]]; then
  if [[ ${#BACKUPS[@]} -eq 0 ]]; then
    echo "（没有可用备份）"
  else
    printf '%s\n' "${BACKUPS[@]}"
  fi
  exit 0
fi

TS="${1:-}"
if [[ -z "${TS}" ]]; then
  [[ ${#BACKUPS[@]} -gt 0 ]] || die "没有可用备份"
  TS="$(basename "${BACKUPS[0]}")"
  warn "未指定时间戳，使用最近一次备份：${TS}"
fi

SRC="${BACKUP_DIR}/${TS}"
[[ -f "${SRC}/relay-server.mjs" ]] || die "备份 ${SRC} 不存在或缺少 relay-server.mjs"
[[ -f "${SRC}/public/admin.html" ]] || die "备份 ${SRC} 缺少 public/admin.html"

log "回滚到 ${TS}"
systemctl stop "${APP_NAME}"

install -m 0644 "${SRC}"/*.mjs "${APP_DIR}/"
install -m 0644 "${SRC}/package.json" "${SRC}/package-lock.json" "${APP_DIR}/"
install -m 0644 "${SRC}"/public/*.html "${APP_DIR}/public/"

log "重新安装依赖：npm ci --omit=dev"
( cd "${APP_DIR}" && npm ci --omit=dev --no-audit --no-fund )

systemctl restart "${APP_NAME}" || true

PORT="$(sed -n 's/^PORT=//p' "${ENV_FILE}" 2>/dev/null | tail -n1 | tr -d '[:space:]')"
PORT="${PORT:-8080}"
ok=0
for _ in $(seq 1 30); do
  sleep 0.5
  if curl -fsS -m 2 "http://127.0.0.1:${PORT}/api/levels" >/dev/null 2>&1; then ok=1; break; fi
done

echo
if [[ ${ok} -eq 1 ]]; then
  log "回滚完成并通过本机自检（http://127.0.0.1:${PORT}/api/levels）"
else
  warn "回滚后自检仍失败，请查看：sudo journalctl -u ${APP_NAME} -n 80 --no-pager"
  exit 1
fi
