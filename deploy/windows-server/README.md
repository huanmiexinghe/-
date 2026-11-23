# Magnetic Rush 服务端 · Windows 部署包

这个包只包含**联机中转 + 自制关卡上传接口**（同一个 8080 端口，WebSocket 与 HTTP 共用）。
它不包含客户端（App/H5）本身，也不包含 cpolar 客户端。

- 服务端程序：Node.js 22 LTS 或更高（22 / 24 实测都能跑，只需 `ws` 一个依赖）
- 数据：`data\levels.json`（自制关卡），首次上传时自动创建
- 对外方式：cpolar 隧道 → `https://huanmie.vip.cpolar.cn` / `wss://huanmie.vip.cpolar.cn`
- 客户端默认地址 **已切到** `wss://huanmie.vip.cpolar.cn`（在服务器部署完成、wss 实测收到 `hello` 之后切换，见第 7 节）

---

## 1. 文件清单：哪些要放、哪些不要

### 必需的

| 文件 / 目录 | 作用 | 必需 |
|---|---|---|
| `relay-server.mjs` | 服务端入口：WS 房间转发 + 挂载 `/api/levels` | 是 |
| `level-store.mjs` | 关卡存储、服务端校验、限流、分享码（被入口 import） | 是 |
| `relay-validate.mjs` | 完赛成绩校验（被入口 import） | 是 |
| `package.json` | 声明运行依赖 `ws` 与 `npm start` | 是 |
| `package-lock.json` | 锁定 `ws` 版本，`npm ci` 用 | 是（用 `npm ci` 时必需） |
| `relay.env` | 端口 / 监听地址 / 数据目录 / Node 路径 | 是（两个 .cmd 靠它读配置） |
| `data\` | 关卡数据目录（自动创建 `levels.json`） | 是（要有写权限） |
| `node_modules\` | `npm ci --omit=dev` 在服务器上生成，**不要从别处拷贝** | 是（服务器上装出来） |

### 可选（推荐保留）

| 文件 | 作用 | 必需 |
|---|---|---|
| `start-server.cmd` | 前台试跑，方便看日志排查 | 可选 |
| `check-health.cmd` | 请求 `http://127.0.0.1:8080/api/levels` 打印状态码 | 可选 |
| `magnetic-rush-server.xml` | WinSW 服务配置（开机自启、崩溃重启、日志重定向） | 服务方式必需 |
| `install-service.cmd` / `uninstall-service.cmd` | 注册 / 移除 Windows 服务 | 服务方式可选 |
| `README.md` | 本说明 | 可选 |

### 不需要（不要拷进服务器）

`src\`、`dist\`、`android\`、`docs\`、`.git`、任何 `node_modules`（除服务器自己 `npm ci` 生成的）、
本机 `server\data\levels.json`（测试数据）、本机日志、cpolar 安装包/配置、APK。

---

## 2. 部署操作顺序

1. **装 Node 22 LTS**：https://nodejs.org/zh-cn/download → 选 LTS → 安装时勾选“Add to PATH”，**为所有用户安装**。装完开新的命令提示符执行 `node -v`，应显示 `v22.x`。
2. **解压到固定路径**：把 `magnetic-rush-server-win.zip` 解压到 `D:\magnetic-rush`（不要放在桌面、不要放在自动清理的临时目录）。
3. **装依赖**：在 `D:\magnetic-rush` 执行
   ```
   npm ci --omit=dev
   ```
   看到 `added 1 package`（只有 `ws`）即可。没网时这一步会失败，先解决网络。
4. **前台试跑**：双击 `start-server.cmd`，窗口应出现：
   ```
   [relay] Magnetic Rush online server listening on ws://127.0.0.1:8080
   [relay] 自制关卡接口：http://127.0.0.1:8080/api/levels（存 0 张，目录 data）
   ```
5. **验证 8080**：另开一个窗口双击 `check-health.cmd`，应显示 `OK HTTP 200` 与 `{"ok":true,"levels":[]}`。失败就看第 9 节。
6. **配置 cpolar**（见第 3 节），然后在**服务器本机**浏览器打开 `http://127.0.0.1:8080/api/levels` 确认本地正常，再打开 `https://huanmie.vip.cpolar.cn/api/levels` 确认外网正常。
7. **注册服务并开机自启**（见第 5 节）。
8. **电源与防杀软**（见第 6 节）。
9. 做完上面，把 `start-server.cmd` 那个前台窗口关掉（服务方式已经在跑，别两个抢 8080）。
10. 通知客户端侧：wss 验证通过后改 `DEFAULT_SERVER_URL` 并重打包（见第 7 节）。

---

## 3. cpolar 侧要做什么（在 cpolar 客户端 / 网页里，不是本地文件）

1. 隧道类型必须是 **http website（HTTP 隧道）**，不是 `tcp`：
   - `proto: http`
   - 本地地址 `addr: "8080"`（等价于 `localhost:8080`）
   - `bind_tls: both`（同时开 http 与 https；客户端要 wss，所以必须有 TLS）
2. **绑定固定二级域名** `huanmie.vip.cpolar.cn` 到这条隧道（保留/预留域名需要在 cpolar 后台做过绑定）。
3. cpolar 客户端也要**常驻并开机自启**（cpolar 有自己的服务/启动项）。隧道断了，服务端再正常玩家也连不上。
4. 改端口时：先改 `relay.env` 的 `PORT` 与 WinSW xml 的 `<env PORT>`，**再同步改 cpolar 隧道的本地地址**。

### 为什么监听只绑 127.0.0.1

cpolar 是在**同一台机器**上回源（它自己访问 `localhost:8080`），走的是本机回环，不经过防火墙、也不出网卡。
把 `HOST` 绑成 `0.0.0.0` 会让 8080 对整个局域网（甚至路由器映射后的公网）开放，既没必要也不安全。
所以 `relay.env` 里默认 `HOST=127.0.0.1`；只有需要“同 WiFi 手机直连调试”时才临时改 `0.0.0.0` 并在防火墙放行 TCP 8080。

> 代码里已支持该变量（`server/relay-server.mjs` 第 17–19 行新增 `HOST = process.env.HOST || '0.0.0.0'`，`httpServer.listen(PORT, HOST, …)`）。不设 `HOST` 时行为与以前完全一致（监听 0.0.0.0、照旧打印局域网地址）。

---

## 4. 数据、备份与恢复

- 数据文件：`data\levels.json`（原子写入：先写 `.tmp` 再改名，断电不会写坏原文件）。
- 备份：停服务后复制整个 `data\` 目录即可（或直接复制 `levels.json`）。建议每天/每周用计划任务复制到别的盘或网盘。
- 恢复：把备份的 `levels.json` 放回 `data\`，启动服务。
- 数据目录可改：`relay.env` 的 `LEVELS_DIR`（相对路径相对本目录；也可写绝对路径如 `D:\magnetic-rush-data`），WinSW 里对应 `<env LEVELS_DIR>`。
- 上限：最多 2000 张关卡，超出按创建时间淘汰最旧的；单张 64KB、最多 300 个物件。

---

## 5. 注册 Windows 服务（两种方案，二选一）

### 方案 A：WinSW（推荐，包内已给配置）

1. 下载 WinSW：https://github.com/winsw/winsw/releases → 取 `WinSW-x64.exe`。
2. 把它放到 `D:\magnetic-rush` 并**改名为** `magnetic-rush-server.exe`（要和 `magnetic-rush-server.xml` 同名）。
3. **以管理员身份**运行 `install-service.cmd`。它会：清理旧服务 → 注册 → 启动 → 打印状态。
4. 以后管理命令（管理员 CMD，在 `D:\magnetic-rush` 下）：
   ```
   magnetic-rush-server.exe status
   magnetic-rush-server.exe restart
   magnetic-rush-server.exe stop
   magnetic-rush-server.exe uninstall
   ```
5. 日志：`logs\magnetic-rush-server.out.log` / `.err.log`（按 10MB 滚动，保留 8 份）。
6. 若服务启动即停：把 xml 里 `<executable>node</executable>` 改成绝对路径
   `C:\Program Files\nodejs\node.exe`，再 `install-service.cmd`。配置里已设开机自启（延迟启动）与崩溃自动重启（10s/20s/30s）。

### 方案 B：NSSM（备选）

```
nssm install MagneticRushRelay "C:\Program Files\nodejs\node.exe" "D:\magnetic-rush\relay-server.mjs"
nssm set MagneticRushRelay AppDirectory D:\magnetic-rush
nssm set MagneticRushRelay AppEnvironmentExtra PORT=8080 HOST=127.0.0.1 LEVELS_DIR=D:\magnetic-rush\data
nssm set MagneticRushRelay AppStdout D:\magnetic-rush\logs\relay.log
nssm set MagneticRushRelay AppStderr D:\magnetic-rush\logs\relay.err.log
nssm set MagneticRushRelay AppExit Default Restart
nssm set MagneticRushRelay Start SERVICE_AUTO_START
nssm start MagneticRushRelay
```
卸载：`nssm stop MagneticRushRelay` → `nssm remove MagneticRushRelay confirm`。

---

## 6. 电源 / 防火墙 / 杀软

- **电源计划：永不睡眠**（睡眠=服务端下线）
  ```
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  ```
  显示器可以关，但“系统睡眠/休眠”必须关。
- **防火墙**：`HOST=127.0.0.1` 时**不需要**放行 8080（cpolar 走本机回环）。只有临时改成 `0.0.0.0` 做局域网直连时才需要：
  ```
  netsh advfirewall firewall add rule name="MR Relay 8080" dir=in action=allow protocol=TCP localport=8080
  ```
- **杀软/Defender**：把 `D:\magnetic-rush` 加入排除目录，避免 `node_modules` 被反复扫描或误杀；同时给 `node.exe` 放行。
- 关掉 Windows 自动重启（可选）：`services.msc` → Windows Update → 设为手动，避免半夜自动重启中断联机。

---

## 7. 客户端默认地址（已切换为固定域名）

- 客户端默认地址在 `src\net\ServerUrl.ts` 的 `DEFAULT_SERVER_URL`，**当前已是** `wss://huanmie.vip.cpolar.cn`（在服务器部署完成、wss 实测收到 `hello` 之后切换并重打包）。
- 以后再换服务器：只改这一行 → `npm run build` → `npx cap sync android` → 重打包 APK；或直接让玩家在大厅「使用自建服务器」手填，不必改包。
- 部署完成后先用下面任一方式验证（必须看到 `hello`，只看 https 200 不算）：

**A. 浏览器控制台（推荐）**
```js
const ws = new WebSocket('wss://huanmie.vip.cpolar.cn');
ws.onopen = () => console.log('OPEN');
ws.onmessage = e => console.log('MSG', e.data);
ws.onerror = e => console.log('ERROR', e);
ws.onclose = e => console.log('CLOSE', e.code, e.reason);
```
期望：先 `OPEN`，紧接着一条 `{"type":"hello","token":…,"id":…,"serverNow":…}`。

**B. 在服务器 `D:\magnetic-rush` 目录用 Node（该目录已装 ws）**
```
node --input-type=module -e "import WebSocket from 'ws'; const ws=new WebSocket('wss://huanmie.vip.cpolar.cn'); ws.on('message',d=>{console.log(String(d));process.exit(0)}); ws.on('error',e=>{console.log('ERR',e.message);process.exit(1)}); setTimeout(()=>{console.log('TIMEOUT');process.exit(1)},8000)"
```

未重打包之前，玩家仍可用大厅里的「使用自建服务器」手填 `wss://huanmie.vip.cpolar.cn` 先联机（地址会保存在本机，下次启动仍生效）。

---

## 8. 升级与回滚

**升级**
1. `magnetic-rush-server.exe stop`
2. 覆盖 `relay-server.mjs`、`level-store.mjs`、`relay-validate.mjs`、`package.json`、`package-lock.json`（**不要覆盖 `data\`**）
3. `npm ci --omit=dev`
4. `magnetic-rush-server.exe start` → `check-health.cmd`

**回滚**：保留上一版整个 zip 或旧 `.mjs` 备份，按同样步骤换回文件、重装依赖、启动即可。`data\levels.json` 兼容两个方向（只是 JSON）。

---

## 9. 常见故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 外网 `https://…/api/levels` 返回 **502**，响应体含 `Tunnel … unavailable … A website server must be running on port http://localhost:8080` | 隧道在线，但本机 8080 没服务 / 端口不一致 / `HOST` 写错 | `check-health.cmd` 看本地是否 200；确认服务在跑；核对 `relay.env` 的 PORT 与 cpolar 隧道本地地址 |
| 外网返回 **404**，页面写 `domain doesn't exist` | cpolar 隧道离线，或固定域名没绑到这条隧道 | 打开 cpolar 客户端确认隧道 online；后台确认 `huanmie.vip` 绑定；重启 cpolar |
| `check-health.cmd` 显示 `FAIL HTTP 0` | 服务没启动 / 端口不是 8080 / `HOST=0.0.0.0` 但被防火墙拦 | 看 `start-server.cmd` 窗口或 `logs\*.err.log`；`netstat -ano | findstr :8080` 查监听 |
| 启动日志 `端口 8080 已被占用` | 有别的进程占用 | `netstat -ano | findstr :8080` → `taskkill /PID <pid> /F`；或换端口并同步隧道 |
| `'node' 不是内部或外部命令` | Node 没装 / 没进 PATH | 重装 Node 并勾选 Add to PATH；服务方式把 xml 里 executable 改绝对路径 |
| 服务注册失败 | 没用管理员权限 | 右键 `install-service.cmd` → 以管理员身份运行 |
| `https` 能开但 `wss` 握手失败 | 隧道没开 TLS、或类型是 tcp | cpolar 隧道确认 `proto: http` + `bind_tls: both`；用 https 隧道而非 tcp |
| 上传返回 **429** | 限流（每 IP 10 分钟 6 次上传 / 120 次读取） | 等一会儿；若 cpolar 不转发 `X-Forwarded-For`，所有玩家会共用同一个出口 IP，容易触发整体限流——这是已知限制 |
| 服务起来过一会就停 | Node 路径/工作目录不对、data 目录不可写 | 看 `logs\*.err.log`；确认 `D:\magnetic-rush` 与 `data\` 有写权限 |

---

## 10. 本包冒烟自测记录（开发机做的，服务器上不用重复）

- 解压包内容到临时目录 → `npm ci --omit=dev` → 成功（1 个依赖 `ws@8.22.0`）。
- 双击/运行 `start-server.cmd`（开发机 8080 空闲，`relay.env` 原样未改）→ 日志：
  `listening on ws://127.0.0.1:8080`，确认确实只绑回环地址。
- `check-health.cmd` → `OK HTTP 200`，`GET /api/levels` 返回 `{"ok":true,"levels":[]}`。
- `POST /api/levels`（2 个障碍的测试关卡）→ **201**，分享码 `FBDNZUUX`。
- 停止进程（8080 立即释放）→ 重启 → `GET /api/levels/FBDNZUUX` → **200**，两个障碍数据完整、`createdAt` 不变（重启不丢）；启动日志显示“存 1 张”。
- 全程只用临时目录与 **8080** 端口；结束后进程已停、8080 无监听、临时目录已删，无残留。
