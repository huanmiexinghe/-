# 磁极冲刺（Magnetic Rush）

Vite + TypeScript + Canvas 2D 的横版磁极切换跑酷游戏，Android 端用 Capacitor 打包。支持自制关卡联机（房间号 / 分享码）与运维统计后台。

## 目录结构

| 路径 | 内容 |
|---|---|
| `src/` | 游戏客户端源码（场景、系统、实体、联机） |
| `public/` | 静态资源（图标、字体等） |
| `scripts/selfcheck.ts` | 关键逻辑自检（连击、星级、存档、联机协议、后台鉴权等） |
| `android/` | Capacitor Android 工程（`npx cap sync android` 生成 WebView 资源） |
| `server/` | 联机中转服务端（Node ESM，单端口 8080，仅依赖 `ws`） |
| `deploy/linux-server/` | Linux 部署包（systemd unit、安装/升级/回滚脚本、中文 README） |
| `deploy/windows-server/` | Windows 部署包（历史方案，WinSW + `.cmd`；`relay.env` 为无凭据模板） |
| `docs/` | 设计文档与联机方案说明 |

## 本地开发

```bash
npm install
npm run dev        # 本地开发
npm run selfcheck  # 逻辑自检
npm run build      # 产出 dist/
npx cap sync android
```

打 Android 调试包（需要 JDK 21，仓库不自带）：

```bash
cd android
./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

## 服务端

```bash
cd server
npm install
node relay-server.mjs
```

- 环境变量：`PORT`（默认 8080）、`HOST`（默认 `0.0.0.0`）、`DATA_DIR`（优先）或旧版 `LEVELS_DIR`（默认 `server/data`）。
- HTTP：`/api/levels`（自制关卡）、`/privacy.html`、`/admin`（运维后台）。
- WebSocket：与 HTTP 共用 8080，连接后服务端下发 `{"type":"hello",...}`。

## 运行时数据（不入库）

服务端在**数据目录**里写三个文件，仓库不包含、也不应包含：

| 文件 | 内容 |
|---|---|
| `levels.json` | 玩家上传的自制关卡 |
| `stats.json` | 运维统计计数（不含 IP / 昵称） |
| `accounts.json` | 后台账号（scrypt 哈希 + salt） |

- 生产环境默认：`/var/lib/magnetic-rush`（Linux 部署包创建，属主 `magnetic-rush`）；
- 本地开发默认：`server/data/`；
- 备份 / 迁移见 `deploy/linux-server/README.md` 第 7 节。这些路径已写入 `.gitignore`。

## 配置与凭据

- 真实 `relay.env`（含 `ADMIN_USER` / `ADMIN_PASSWORD`）**不入库**；只提交 `relay.env.example`。
- `deploy/windows-server/relay.env` 仅含端口/路径等非敏感模板值，已确认不含账号密码。
- 部署时由 `deploy/linux-server/install.sh` 随机生成后台初始密码并只打印一次；不要在仓库里写死凭据。

## 安全说明

- 当前内测客户端默认直连 `ws://47.96.190.73:8080`（明文），仅用于测试期；`/admin` 的密码与 Cookie 同样走明文，正式发布前应切换到域名 + 证书的 `wss`/`https` 反代。
- 仓库为公开仓库：提交前请确认没有把 `relay.env`、cpolar authtoken、账号文件或玩家数据带进来。

## 部署

推荐使用 [deploy/linux-server/README.md](deploy/linux-server/README.md)：从零安装、安全组口径、Nginx/Caddy TLS 反代、升级与回滚步骤都在里面。
