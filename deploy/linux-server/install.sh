#!/usr/bin/env bash
# Magnetic Rush 联机中转服务 · Linux 安装脚本
# 适用：Ubuntu 22.04 / 24.04、Debian 12（systemd + apt）
#
# 用法：
#   解压部署包 → 进入解压目录 → sudo bash install.sh
#
# 做的事（可重复执行，不会覆盖已有数据和后台密码）：
#   1. 检查 root / node / npm，缺 curl 时补装
#   2. 创建系统用户 magnetic-rush（无登录 shell）
#   3. 程序装到 /opt/magnetic-rush，数据放 /var/lib/magnetic-rush
#   4. 首次生成 /etc/magnetic-rush/relay.env（随机后台密码，只打印一次）
#   5. 安装并启动 systemd 服务 magnetic-rush-relay
#   6. 本机自检 /api/levels，打印状态与后续要做的放行步骤

set -euo pipefail

APP_NAME="magnetic-rush-relay"
SERVICE_USER="magnetic-rush"
APP_DIR="/opt/magnetic-rush"
DATA_DIR="/var/lib/magnetic-rush"
ENV_DIR="/etc/magnetic-rush"
ENV_FILE="${ENV_DIR}/relay.env"
UNIT_FILE="/etc/systemd/system/${APP_NAME}.service"
BACKUP_DIR="/var/backups/magnetic-rush"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_APP="${SRC_DIR}/app"

log()  { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
[[ ${EUID} -eq 0 ]] || die "请用 root 运行：sudo bash install.sh"
[[ -d /run/systemd/system ]] || die "当前系统没有运行 systemd（容器/WSL1 里请用其它方式守护进程）"
[[ -f "${PKG_APP}/relay-server.mjs" ]] || die "找不到 ${PKG_APP}/relay-server.mjs，请在解压后的部署包目录里执行本脚本"

NODE_BIN="$(command -v node || true)"
[[ -n "${NODE_BIN}" ]] || die "未找到 node。请先安装 Node.js（推荐 22 LTS），见 README 第 2 节"
NODE_MAJOR="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || die "Node.js 版本过低（当前 $("${NODE_BIN}" -v)），需要 18+，推荐 22 LTS"
command -v npm >/dev/null 2>&1 || die "未找到 npm，请安装完整的 Node.js 包（含 npm）"

if ! command -v curl >/dev/null 2>&1; then
  log "安装 curl / ca-certificates…"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates
fi

# ---------- 1. 专用用户 ----------
if ! getent group "${SERVICE_USER}" >/dev/null 2>&1; then
  log "创建系统组 ${SERVICE_USER}"
  groupadd --system "${SERVICE_USER}"
fi
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  log "创建系统用户 ${SERVICE_USER}"
  useradd --system --gid "${SERVICE_USER}" --home-dir "${DATA_DIR}" --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
else
  log "系统用户 ${SERVICE_USER} 已存在"
fi

# ---------- 2. 目录与权限 ----------
log "准备目录"
install -d -m 0755 -o root -g root "${APP_DIR}"
install -d -m 0755 -o root -g root "${APP_DIR}/public"
install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${DATA_DIR}"
install -d -m 0750 -o root -g "${SERVICE_USER}" "${ENV_DIR}"
install -d -m 0700 -o root -g root "${BACKUP_DIR}"

# ---------- 3. 程序文件（不碰数据目录） ----------
log "复制程序文件到 ${APP_DIR}"
install -m 0644 "${PKG_APP}"/*.mjs "${APP_DIR}/"
install -m 0644 "${PKG_APP}/package.json" "${PKG_APP}/package-lock.json" "${APP_DIR}/"
install -m 0644 "${PKG_APP}"/public/*.html "${APP_DIR}/public/"
if [[ -f "${SRC_DIR}/README.md" ]]; then
  install -m 0644 "${SRC_DIR}/README.md" "${APP_DIR}/README.md"
fi

# ---------- 4. 依赖（只有 ws） ----------
log "安装依赖：npm ci --omit=dev"
( cd "${APP_DIR}" && npm ci --omit=dev --no-audit --no-fund )

# ---------- 5. relay.env：只首次生成，升级不覆盖 ----------
if [[ -f "${ENV_FILE}" ]]; then
  log "保留已有配置 ${ENV_FILE}（后台密码不会被覆盖）"
else
  log "生成 ${ENV_FILE}"
  [[ -f "${SRC_DIR}/relay.env.example" ]] || die "缺少 ${SRC_DIR}/relay.env.example"
  ADMIN_PASS="$("${NODE_BIN}" -e "console.log(require('node:crypto').randomBytes(12).toString('base64url').slice(0,16))")"
  sed "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PASS}|" "${SRC_DIR}/relay.env.example" > "${ENV_FILE}"
  echo
  warn "================ 后台初始账号（只显示这一次，请立即保存）================"
  warn "  地址：http://<服务器IP>:${PORT:-8080}/admin"
  warn "  账号：admin"
  warn "  密码：${ADMIN_PASS}"
  warn "修改方式：登录后台 → 账号管理 → 重置密码；或编辑 ${ENV_FILE}（仅首次生效）后重启"
  warn "========================================================================"
  echo
fi
chown root:"${SERVICE_USER}" "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"

# 手动前台试跑（node relay-server.mjs）时也能读到同一份配置
ln -sfn "${ENV_FILE}" "${APP_DIR}/relay.env"

# ---------- 6. systemd ----------
log "安装 systemd 服务 ${APP_NAME}"
sed "s|^ExecStart=.*|ExecStart=${NODE_BIN} ${APP_DIR}/relay-server.mjs|" \
  "${SRC_DIR}/${APP_NAME}.service" > "${UNIT_FILE}"
chmod 0644 "${UNIT_FILE}"
systemctl daemon-reload
systemctl enable "${APP_NAME}" >/dev/null
systemctl restart "${APP_NAME}" || true

# ---------- 7. 自检 ----------
PORT="$(sed -n 's/^PORT=//p' "${ENV_FILE}" | tail -n1 | tr -d '[:space:]')"
PORT="${PORT:-8080}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/levels"

ok=0
for _ in $(seq 1 30); do
  sleep 0.5
  if curl -fsS -m 2 "${HEALTH_URL}" >/dev/null 2>&1; then ok=1; break; fi
done

echo
if [[ ${ok} -eq 1 ]]; then
  log "安装完成，服务已启动并通过本机自检（${HEALTH_URL}）"
  log "监听状态："
  ss -lntp 2>/dev/null | grep -E ":${PORT}\b" || true
  echo
  log "下一步："
  echo "  1) 服务管理：sudo systemctl {status|restart|stop} ${APP_NAME}"
  echo "  2) 查看日志：sudo journalctl -u ${APP_NAME} -n 80 --no-pager（-f 实时）"
  echo "  3) 对外访问：阿里云安全组放行 TCP ${PORT}（来源建议先填自己的 IP），"
  echo "     如启用了 ufw 还要：sudo ufw allow ${PORT}/tcp"
  echo "  4) 走 Nginx/Caddy 反代的话：把 HOST 改成 127.0.0.1 并重启，不要对公网放行 ${PORT}"
  echo "  5) 外网验证：curl -m 10 http://<公网IP>:${PORT}/api/levels"
else
  warn "服务已安装，但本机自检失败。请查看日志定位："
  warn "  sudo systemctl status ${APP_NAME} --no-pager"
  warn "  sudo journalctl -u ${APP_NAME} -n 80 --no-pager"
  exit 1
fi
