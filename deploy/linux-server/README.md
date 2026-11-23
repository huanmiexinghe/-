# Magnetic Rush 服务端 · Linux 部署包

一套跑在 **有公网 IP 的 Linux 服务器** 上的部署包：systemd 托管、专用用户、journald 日志、安装/升级/回滚脚本。
服务端本身是单进程 Node（ESM），只依赖一个 `ws`，**8080 端口同时提供 WebSocket 联机、`/api/levels` 关卡接口、`/admin` 运维后台和 `/privacy.html`**。

- 目标系统：Ubuntu 22.04 / 24.04、Debian 12（systemd + apt）
- 本次验证环境：阿里云 ECS `ecs.c1m1.large`，2 vCPU / 2 GiB，Ubuntu 22.04 64 位，公网 IP `47.96.190.73`，内网 `172.27.82.85`
- 与 Windows 包的差异：`.cmd` / WinSW 全部去掉，改为 systemd unit；路径改 `/opt` + `/var/lib` + `/etc`；日志改 journald；所有脚本为 LF 换行
- **客户端地址未改动**：`src/net/ServerUrl.ts` 的 `DEFAULT_SERVER_URL` 仍是 `wss://huanmie.vip.cpolar.cn`（见第 6 节）

---

## 1. 文件清单

| 文件 / 目录 | 作用 | 必需 |
|---|---|---|
| `app/relay-server.mjs` | 服务端入口（WS 房间 + HTTP 路由 + `/admin` 挂载） | 是 |
| `app/level-store.mjs` | 自制关卡存储、服务端校验、限流、分享码 | 是 |
| `app/relay-validate.mjs` | 完赛成绩校验 | 是 |
| `app/stats-store.mjs` | 运维统计持久化（只存计数，不存 IP / 昵称） | 是 |
| `app/accounts.mjs` | 后台账号（scrypt 哈希） | 是 |
| `app/admin.mjs` | `/admin` 登录、看板、账号与数据管理接口 | 是 |
| `app/public/admin.html`、`admin-login.html`、`privacy.html` | 后台页面与隐私政策页 | 是 |
| `app/package.json`、`package-lock.json` | 依赖声明与锁定（`npm ci` 用） | 是 |
| `relay.env.example` | 环境变量示例（安装时复制成 `/etc/magnetic-rush/relay.env`） | 是 |
| `magnetic-rush-relay.service` | systemd unit（安装时复制到 `/etc/systemd/system/`） | 是 |
| `install.sh` | 从零安装（建用户、装程序、装依赖、装服务、自检） | 是 |
| `upgrade.sh` | 升级（自动备份 → 覆盖程序 → 重启 → 自检） | 是 |
| `rollback.sh` | 回滚到指定 / 最近一次备份 | 是 |
| `check-health.sh` | 本机健康检查（服务、端口、HTTP、WebSocket 握手） | 推荐 |
| `README.md` | 本说明 | 是 |

安装后服务器上的布局：

| 路径 | 内容 | 属主 / 权限 |
|---|---|---|
| `/opt/magnetic-rush/` | 程序文件、`public/`、`node_modules/` | `root:root`，`0755`（运行时只读） |
| `/var/lib/magnetic-rush/` | `levels.json`、`stats.json`、`accounts.json` | `magnetic-rush:magnetic-rush`，`0750` |
| `/etc/magnetic-rush/relay.env` | 端口 / 监听地址 / 数据目录 / 引导管理员 | `root:magnetic-rush`，`0640` |
| `/etc/systemd/system/magnetic-rush-relay.service` | systemd unit | `root:root`，`0644` |
| `/var/backups/magnetic-rush/<时间戳>/` | 每次升级前的程序备份（保留最近 5 份） | `root:root`，`0700` |

---

## 2. 从零安装

> 全程用 root（或 `sudo`）。下面所有命令都可以直接复制执行。

### 2.1 登录服务器

```bash
ssh root@47.96.190.73
```

### 2.2 安装 Node.js（推荐 22 LTS）

```bash
apt-get update
apt-get install -y curl ca-certificates unzip

# NodeSource 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

node -v      # 期望 v22.x
npm -v
```

> 国内网络拉 NodeSource 慢时，可以先用系统自带版本 `apt-get install -y nodejs npm`（Ubuntu 22.04 是 18.19，服务端也兼容，18+ 即可），后续再换 22 LTS。**不要低于 18。**

### 2.3 上传并解压部署包

在本地把 `deploy/magnetic-rush-server-linux.zip` 传上去：

```bash
# 本地执行（Windows PowerShell 用 scp 同样可用）
scp deploy/magnetic-rush-server-linux.zip root@47.96.190.73:/root/

# 服务器执行
cd /root
unzip -q magnetic-rush-server-linux.zip
cd magnetic-rush-server-linux     # 里面有 app/ install.sh README.md …
```

### 2.4 一键安装

```bash
sudo bash install.sh
```

脚本会：

1. 校验 node / npm（要求 18+），缺 `curl` 会自动补装；
2. 创建系统用户 `magnetic-rush`（`/usr/sbin/nologin`，不能登录）；
3. 程序装到 `/opt/magnetic-rush`，数据目录 `/var/lib/magnetic-rush` 属主为服务用户；
4. **首次**生成 `/etc/magnetic-rush/relay.env`，随机生成 16 位后台密码并打印（只打印这一次，请立刻保存）；
5. 执行 `npm ci --omit=dev`；
6. 安装并启动 systemd 服务，`systemctl enable` 开机自启；
7. 本机自检 `/api/levels`，失败会打印日志排查入口。

> 重复执行 `install.sh` 是安全的：已有的 `relay.env`、`accounts.json`、`levels.json` 都不会被覆盖。

### 2.5 检查配置

```bash
sudo cat /etc/magnetic-rush/relay.env
```

关键三项：

- `HOST=0.0.0.0`：直接对外（需安全组放行 8080）；走反代/cpolar 时改成 `127.0.0.1`
- `PORT=8080`：默认端口，反代回源也用它
- `DATA_DIR=/var/lib/magnetic-rush`：数据目录，别改到不可写的位置

改完重启：`sudo systemctl restart magnetic-rush-relay`

### 2.6 放行端口（见第 4 节）

```bash
# 仅当“直接对外 8080”时才需要
sudo ufw allow 8080/tcp

# 走 Nginx/Caddy TLS 反代时只放 80/443
sudo ufw allow 80,443/tcp
```

> 注意：阿里云**安全组**和服务器**本机防火墙**是两层，两层都要放行才通。如果启用了 ufw，务必先 `sudo ufw allow 22/tcp` 再 `sudo ufw enable`，否则会把自己锁在外面。
> 本包不会自动改防火墙。

### 2.7 验证

```bash
sudo bash check-health.sh
```

全部 OK 后按第 8 节做外网验证。

---

## 3. 服务管理

```bash
sudo systemctl status magnetic-rush-relay --no-pager   # 状态
sudo systemctl restart magnetic-rush-relay             # 重启
sudo systemctl stop magnetic-rush-relay                # 停止
sudo journalctl -u magnetic-rush-relay -n 80 --no-pager  # 最近日志
sudo journalctl -u magnetic-rush-relay -f              # 实时日志
```

unit 的关键行为（`magnetic-rush-relay.service`）：

- `After=network-online.target` + `Wants=network-online.target`：等网络就绪再启动
- `Restart=always` + `RestartSec=5`：崩溃、被 kill、OOM 都会自动拉起
- `KillSignal=SIGTERM`：停止时服务端先落盘统计再退出（`TimeoutStopSec=20`）
- `Restart=always` 配合 `StartLimitIntervalSec=0`：不会因为连续重启被 systemd 放弃
- 加固：`NoNewPrivileges`、`PrivateTmp`、`ProtectSystem=strict`、`ProtectHome`，只允许写 `/var/lib/magnetic-rush`
- 日志只进 journald，不生成日志文件、不需要自己轮转

端口被占用时的排查：

```bash
sudo ss -lntp | grep :8080
sudo journalctl -u magnetic-rush-relay -n 20 --no-pager   # 日志会提示 EADDRINUSE 与查占用命令
```

---

## 4. 安全组 / 防火墙口径

### 4.1 当前安全组（截图核对）

| 规则 | 现状 | 建议 |
|---|---|---|
| TCP 22 ← `0.0.0.0/0` | 允许 | **建议删除**，只保留下面两条固定 IP |
| TCP 22 ← `1.192.129.30/32`、`123.52.54.74/32` | 允许 | 保留（你的出口 IP）；换网络后补一条新的、删旧的 |
| UDP 7777 ← `0.0.0.0/0` | 允许 | 与本服务无关，**没用到就删除** |
| TCP 3389 ← `0.0.0.0/0` | 允许（System created） | Linux 服务器用不到 RDP，**建议删除**（暴露面很大） |
| 全部 ICMP-IPv4 ← `0.0.0.0/0` | 允许（System created） | 可保留（ping 排障方便） |
| TCP 8080 | **未放行** | 见下：直连才放，反代不放 |

### 4.2 必须放行

| 场景 | 放行端口 | 来源 |
|---|---|---|
| 直接访问 `http://47.96.190.73:8080/admin` | TCP **8080** | 建议填你的固定出口 IP，而不是 `0.0.0.0/0` |
| Nginx / Caddy TLS 反代 | TCP **80 + 443** | `0.0.0.0/0` |
| SSH 运维 | TCP **22** | 固定 IP/32 |
| cpolar 隧道承接 | **不需要**放行 8080 | cpolar 从本机回环回源，`HOST=127.0.0.1` |

**推荐做法**：走 TLS 反代或 cpolar，`HOST=127.0.0.1`，安全组不放行 8080，只放 80/443。

### 4.3 不该放行

- `3389`（RDP，Linux 无此服务）、`3306`（MySQL）、`6379`（Redis）、`27017`（MongoDB）
- cpolar 本地 API `4040`：只给本机用，任何情况下都不要对公网开放
- `8080`：只要走了反代/隧道就不要放；多开一个口就多一份被扫描、被刷接口的风险

### 4.4 本机防火墙（ufw）

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80,443/tcp
# 仅直连 8080 时：
# sudo ufw allow 8080/tcp
sudo ufw enable
sudo ufw status verbose
```

> 阿里云安全组 + ufw 是叠加关系，缺一层都不通；排障时先确认两层都放行。

---

## 5. `/admin` 运维后台的外网访问

服务端监听 `HOST:PORT`（默认 `0.0.0.0:8080`）。后台与游戏接口同端口，路由是 `/admin`。

### 方案 A：直接对外（明文 HTTP）

配置：

```ini
HOST=0.0.0.0
PORT=8080
```

访问：`http://47.96.190.73:8080/admin` → 自动跳 `/admin/login` → 用 `install.sh` 打印的账号密码登录。

### 方案 B：Nginx + TLS 反代（推荐）

前提：一个解析到 `47.96.190.73` 的域名（例如 `relay.example.com`），否则签不出证书。

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

WebSocket 升级头需要 `map`，放到 http 上下文（新建文件）：

```nginx
# /etc/nginx/conf.d/ws-upgrade.conf
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

站点配置：

```nginx
# /etc/nginx/sites-available/magnetic-rush.conf
server {
    listen 80;
    server_name relay.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    client_max_body_size 1m;   # 服务端自身限制 64KB，这里留余量

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # WebSocket 必需
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # 关键：/admin 的 Cookie 依据它决定是否加 Secure，漏了会让 HTTPS 下的会话 Cookie 不带 Secure
        proxy_set_header X-Forwarded-Proto $scheme;

        # 联机房间可能长时间空闲，读超时给足
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/magnetic-rush.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d relay.example.com    # 自动签发并改写 443 证书路径
```

然后把 `relay.env` 改成 `HOST=127.0.0.1` 并重启服务，**不要在安全组放行 8080**。
访问：`https://relay.example.com/admin`（Cookie 带 `Secure`），联机地址用 `wss://relay.example.com`。

### 方案 C：Caddy（自动 HTTPS，最省事）

```
# /etc/caddy/Caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
```

Caddy 会自动申请证书、自动设置 `X-Forwarded-Proto`、自动处理 WebSocket 升级。同样把 `HOST` 改为 `127.0.0.1`，不放行 8080。

### 明文 HTTP 暴露公网的风险（务必看）

- 后台密码、会话 Cookie、联机消息全部明文传输，公共 WiFi / 运营商链路可被嗅探和篡改；
- 8080 会被全网扫描器发现，`/api/levels` 上传接口会被刷（限流是每 IP 10 分钟 6 次，但攻击者可换 IP）；
- 走明文时 Cookie 不带 `Secure`，浏览器一旦从 https 站点跳转过来存在被降级利用的可能；
- 浏览器会把 `http://IP:8080` 标成"不安全"。

**最低限度加固**（如果暂时只能用明文）：

1. 安全组 8080 的来源填你自己的固定 IP，不要 `0.0.0.0/0`；
2. 后台密码用 `install.sh` 生成的随机密码，不要改成弱口令；
3. 尽快补上 Nginx/Caddy TLS 反代，或改用 cpolar 提供的 https 域名；
4. 后台登录失败 5 次会锁 15 分钟（按账号），不要用常见用户名。

---

## 6. cpolar 继续承接（客户端地址不变）

客户端默认地址仍是 `wss://huanmie.vip.cpolar.cn`，本次**没有改客户端**。如果新服务器继续用这条 cpolar 隧道：

1. **先在旧 Windows 机器上停掉隧道**（`cpolar` 客户端退出 / 卸载服务）。同一个固定域名同一时间只能指向一条隧道，两边同时在线会互相顶掉。
2. 在 Linux 上安装 cpolar（以 cpolar 官方 Linux 文档为准）：

   ```bash
   curl -L https://www.cpolar.com/static/downloads/install-release-cpolar.sh | sudo bash
   sudo cpolar authtoken <你的 authtoken>
   ```

3. 配置隧道（Linux 上通常是 `/usr/local/etc/cpolar/cpolar.yml`，以实际安装路径为准）：

   ```yaml
   authtoken: <你的 authtoken>
   tunnels:
     magnetic-rush:
       proto: http
       addr: 8080
       bind_tls: both
       domain: huanmie.vip.cpolar.cn
   ```

   - `proto: http`（不是 `tcp`），否则没有 TLS，`wss` 握手会失败
   - `bind_tls: both`：同时提供 http 与 https
   - `domain` 必须是 cpolar 后台已绑定到该账号的固定域名
4. 启动并设为开机自启（cpolar 通常自带 `cpolar service install`，完成后 `sudo systemctl enable --now cpolar`；以官方文档为准）。
5. `relay.env` 改成 `HOST=127.0.0.1` 并重启；安全组**不要**放行 8080。
6. 验证：`curl https://huanmie.vip.cpolar.cn/api/levels`，后台地址 `https://huanmie.vip.cpolar.cn/admin`。

### 以后想改成"直连"（不用 cpolar）

`wss://` 必须有**域名 + 有效证书**，裸 IP 签不出证书，也不能用 `ws://`（客户端默认是 wss，HTTPS 页面也不允许连非加密 WebSocket）。所以直连的前提是：

1. 域名解析到服务器公网 IP；
2. Nginx/Caddy 配好 TLS（第 5 节方案 B/C）；
3. 再改客户端 `src/net/ServerUrl.ts` 的 `DEFAULT_SERVER_URL` 为新地址并重新打包 APK。

本次**不改**客户端，以上只是前提说明。

---

## 7. 数据、备份与迁移

数据都在 `DATA_DIR`（默认 `/var/lib/magnetic-rush`）：

| 文件 | 内容 |
|---|---|
| `levels.json` | 自制关卡（最多 2000 张，超出按创建时间淘汰；单张 64KB、最多 300 个物件） |
| `stats.json` | 运维统计计数（只存计数与按天汇总，不存 IP / 昵称） |
| `accounts.json` | 后台账号（scrypt 哈希 + 每账号 salt，无明文密码） |

写入方式都是"先写 `.tmp` 再 rename"，断电不会写坏原文件。

**备份**：

```bash
sudo systemctl stop magnetic-rush-relay
sudo tar czf /root/magnetic-rush-data-$(date +%F).tgz -C /var/lib/magnetic-rush .
sudo systemctl start magnetic-rush-relay
```

也可以用 `systemd` 定时器/`cron` 定期执行，把 tar 传到对象存储。

**恢复**：

```bash
sudo systemctl stop magnetic-rush-relay
sudo tar xzf /root/magnetic-rush-data-2026-11-20.tgz -C /var/lib/magnetic-rush
sudo chown -R magnetic-rush:magnetic-rush /var/lib/magnetic-rush
sudo systemctl start magnetic-rush-relay
```

**从旧 Windows 服务器迁移**：把旧机器 `data\` 下的 `levels.json`、`stats.json`、`accounts.json` 上传到 `/var/lib/magnetic-rush/`，`chown magnetic-rush:magnetic-rush` 后启动即可。
注意：`accounts.json` 迁移过来后，`relay.env` 里的 `ADMIN_USER` / `ADMIN_PASSWORD` 不再生效（只在“零账号”时用于引导），登录密码沿用旧后台密码。

---

## 8. 验证

> 只看 HTTP 200 不够：`/api/levels` 只能证明 HTTP 通，**必须看到 WebSocket 的 `hello` 才算联机可用**。

### 8.1 服务器本机

```bash
sudo bash check-health.sh
```

或手动逐项：

```bash
# 1) 服务与端口
systemctl is-active magnetic-rush-relay
sudo ss -lntp | grep :8080

# 2) 关卡接口（期望 {"ok":true,"version":2,"levels":[...]}）
curl -sS -m 5 http://127.0.0.1:8080/api/levels

# 3) 隐私政策页（期望 200）
curl -sS -m 5 -o /dev/null -w 'privacy=%{http_code}\n' http://127.0.0.1:8080/privacy.html

# 4) 后台入口（未登录，期望 303 跳 /admin/login）
curl -sS -m 5 -o /dev/null -w 'admin=%{http_code}\n' http://127.0.0.1:8080/admin
curl -sS -m 5 -L http://127.0.0.1:8080/admin | head -n 5      # 登录页 HTML
```

后台登录测试（把密码换成 `install.sh` 打印的那个）：

```bash
# 期望 303 + Set-Cookie: mr_admin=...
curl -sS -i -m 5 -c /tmp/mr.cookie \
  -d 'user=admin&password=你的后台密码' \
  http://127.0.0.1:8080/admin/login | head -n 8

# 期望 {"ok":true,"user":{"id":...,"username":"admin","role":"admin"},...}
curl -sS -m 5 -b /tmp/mr.cookie http://127.0.0.1:8080/admin/api/me

# 期望 200 + 统计 JSON
curl -sS -m 5 -b /tmp/mr.cookie http://127.0.0.1:8080/admin/api/stats | head -c 300

# 错误密码：期望 401（连续 5 次后 429，锁 15 分钟）
curl -sS -o /dev/null -w 'bad=%{http_code}\n' \
  -d 'user=admin&password=wrong' http://127.0.0.1:8080/admin/login
rm -f /tmp/mr.cookie
```

WebSocket 握手（用程序自带依赖，期望一条 `{"type":"hello",...}`）：

```bash
cd /opt/magnetic-rush && sudo -u magnetic-rush node --input-type=module -e "
import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080');
ws.on('message', d => { console.log(String(d)); process.exit(0); });
ws.on('error', e => { console.error('ERR', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 8000);
"
```

### 8.2 外网（从你自己的电脑 / 手机流量）

直连 8080：

```bash
curl -sS -m 10 http://47.96.190.73:8080/api/levels
curl -sS -m 10 -o /dev/null -w 'admin=%{http_code}\n' http://47.96.190.73:8080/admin
curl -sS -m 10 -o /dev/null -w 'privacy=%{http_code}\n' http://47.96.190.73:8080/privacy.html

# WebSocket（本机有 node 时；期望 hello）
node --input-type=module -e "
import WebSocket from 'ws';
const ws = new WebSocket('ws://47.96.190.73:8080');
ws.on('message', d => { console.log(String(d)); process.exit(0); });
ws.on('error', e => { console.error('ERR', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 8000);
"
```

走 TLS 反代 / cpolar：

```bash
curl -sS -m 10 https://relay.example.com/api/levels            # 或 https://huanmie.vip.cpolar.cn/api/levels
curl -sS -m 10 -o /dev/null -w 'admin=%{http_code}\n' https://relay.example.com/admin
```

`wss` 用浏览器控制台最容易确认（必须看到 `OPEN` 和 `hello`）：

```js
const ws = new WebSocket('wss://huanmie.vip.cpolar.cn');   // 或用你的反代域名
ws.onopen = () => console.log('OPEN');
ws.onmessage = e => console.log('MSG', e.data);
ws.onerror = e => console.log('ERROR', e);
ws.onclose = e => console.log('CLOSE', e.code, e.reason);
```

外网能打开 `/admin` 就等于满足了第 3 条要求；再从外网提交一次登录，确认 `Set-Cookie` 正常、能进看板。

---

## 9. 升级与回滚

**升级**（新包解压到 `/root/magnetic-rush-server-linux-new`）：

```bash
cd /root/magnetic-rush-server-linux-new
sudo bash upgrade.sh /root/magnetic-rush-server-linux-new
```

脚本会：备份当前程序到 `/var/backups/magnetic-rush/<时间戳>/` → 停服务 → 覆盖 `.mjs` / `public/` / `package*.json` → `npm ci` → 启动 → 自检。
**数据目录与 `relay.env` 不动**，升级不会改后台密码。

**回滚**：

```bash
sudo bash rollback.sh --list            # 看有哪些备份
sudo bash rollback.sh                   # 回到最近一次
sudo bash rollback.sh 20261120-153000   # 回到指定备份
```

`upgrade.sh` 失败时会直接打印对应的 `rollback.sh <时间戳>` 命令。

> 备份目录只保留最近 5 份，更早的自动删除；需要长期归档就把 tar 包另存。

---

## 10. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `systemctl status` 显示 `failed` | 启动即崩 | `journalctl -u magnetic-rush-relay -n 80 --no-pager` 看第一条错误 |
| 日志 `端口 8080 已被占用` | 有别的进程 / 旧进程没退 | `sudo ss -lntp \| grep :8080`；`sudo systemctl stop magnetic-rush-relay` 后再起 |
| 本机 `curl 127.0.0.1:8080` 通，外网超时 | 安全组或 ufw 没放行；或 `HOST=127.0.0.1` | 两层都放行；直连时 `HOST=0.0.0.0` |
| 外网 `curl` 返回 404 `domain doesn't exist` | cpolar 隧道离线 / 域名没绑到这条隧道 | 看 cpolar 状态；确认旧机器的隧道已停 |
| cpolar 返回 502 且提示 `no server on port 8080` | 隧道在线但本机 8080 没服务 / 端口不一致 | `check-health.sh`；核对 `PORT` 与隧道 `addr` |
| `/admin` 显示"后台未初始化" | `relay.env` 没配 `ADMIN_USER` / `ADMIN_PASSWORD`，且还没有账号 | 配好后 `systemctl restart`；若 `accounts.json` 已存在则改这里的密码无效，请用旧密码登录 |
| 登录 429 | 同账号连续失败 5 次 | 等 15 分钟；期间可在服务器上确认账号是否存在（`accounts.json` 只有哈希，无法看密码） |
| 登录成功但刷新又回登录页 | 反代没传 Cookie / 用了 IP 与域名混访 | 统一用一个域名访问；确认反代没过滤 `Set-Cookie` |
| HTTPS 下后台 Cookie 没有 `Secure` | 反代漏了 `X-Forwarded-Proto` | 按第 5 节补上该请求头 |
| 上传返回 429 | 每 IP 10 分钟 6 次上传限流 | 等一会儿；隧道/cpolar 下若没带 `X-Forwarded-For`，所有玩家共用一个出口 IP，容易整体触发（已知限制） |
| `npm ci` 失败（`ETIMEDOUT` / `ECONNRESET`） | 服务器访问 npm 源不稳定 | `cd /opt/magnetic-rush && sudo npm ci --omit=dev --registry=https://registry.npmmirror.com`，再 `sudo systemctl restart magnetic-rush-relay` |
| 升级后自检失败 | 依赖或文件不完整 | 按 `upgrade.sh` 打印的命令执行 `rollback.sh` |
| 服务反复重启 | 数据目录不可写 / 端口冲突 / 依赖缺失 | `journalctl`；确认 `/var/lib/magnetic-rush` 属主是 `magnetic-rush` |

---

## 11. 安全清单（上线前逐条确认）

- [ ] `install.sh` 打印的随机后台密码已保存，且没有改回弱口令
- [ ] 安全组删掉 `3389`（RDP）和对全网开放的 `22`，`22` 只留固定 IP
- [ ] 没用的 `UDP 7777` 规则已删除
- [ ] 走反代/cpolar 时 `HOST=127.0.0.1`，安全组不放行 8080
- [ ] 直连 8080 时，来源限制为自己的固定 IP，并尽快补 TLS 反代
- [ ] 反代设置了 `X-Forwarded-Proto`（Cookie 的 `Secure` 依赖它）
- [ ] `cpolar` 本地 API 端口（4040）没有对公网开放
- [ ] 已配置数据目录定期备份（`/var/lib/magnetic-rush`）
- [ ] `journalctl -u magnetic-rush-relay` 没有反复出现的异常
- [ ] 外网能从 `/admin` 登录并看到看板，`wss` 能收到 `hello`
