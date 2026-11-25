# 协作规范（CONTRIBUTING）

本仓库是公开仓库，默认分支 `main`，包含客户端（Vite + TypeScript + Capacitor）、联机服务端、Linux/Windows 部署包与设计文档。生产中继跑在阿里云 Linux（`47.96.190.73`）的 systemd 服务里。

> 说明：`main` 的强制保护尚未开启（Ruleset 待配置）。在开启之前，本文件即为约定，请自觉执行；开启之后，直推、强推、删除分支都会被 GitHub 拒绝。本文档自身及后续 `.github/` 配置的修改，一律走 PR。

部署、升级、回滚和应急操作见 [docs/部署运维手册.md](docs/部署运维手册.md)。

---

## 1. 角色与权限

| 角色 | GitHub 权限 | 生产服务器权限 | 建议人数 |
|---|---|---|---|
| Maintainer（维护者） | Admin，唯一可合并 `main` | 默认**不给** SSH | 2 |
| Developer（开发） | Write，只能推自己的分支、开 PR | 无 | 不限 |
| Operator（运维） | Read，能看 Release、开 Issue | SSH + sudo + 阿里云控制台 | 2 |

规则：

- **合并权与生产权不默认绑在同一个人身上**。合并是代码评审，上线是高风险操作，分开后上线前天然有第二个人看过 PR 和 Release。
- 合并权至少两人。GitHub 不允许作者批准自己的 PR，只有一个 Maintainer 时无法开启「Require review from Code Owners」，仓库会卡死。
- 小团队允许兼任，但上线前要在 Release 下留部署确认评论，由非操作者确认。
- 生产控制台开启 MFA；SSH 一人一把密钥，禁止共享；人员离开时立即移除仓库权限、`authorized_keys` 中的公钥和 sudo 组。
- 建议把仓库迁到 GitHub Organization，用 Team 管理权限（个人仓库只能按单个账号授权，离职回收容易遗漏）。

---

## 2. 分支模型与命名

`main` 是唯一长期分支，始终保持可构建、可发版。

| 分支 | 用途 | 谁能推 |
|---|---|---|
| `main` | 长期分支，只接受 PR | 无人直推 |
| `feat/<短描述>` | 新功能 | 作者 |
| `fix/<短描述>` | 缺陷修复 | 作者 |
| `server/<短描述>` | `server/`、`deploy/` 改动 | 作者 |
| `docs/<短描述>` | 文档 | 作者 |
| `hotfix/<版本>-<问题>` | 线上紧急修复，从对应 tag 拉出 | Maintainer |

命名用小写字母、数字和短横线，不使用中文、空格、下划线。分支合并后自动删除。

### `main` 应当开启的保护（Ruleset）

- 禁止删除分支、禁止强推、要求线性历史；
- 必须通过 PR 合并，至少 1 个批准，新提交会作废旧批准；
- 必须通过状态检查（CI 接入后为 `verify`），且分支需与 `main` 同步；
- 所有对话必须解决后才能合并；
- 不设 bypass，管理员同样走 PR；
- 只允许 Squash 合并。

---

## 3. 提交信息与合并方式

采用 Conventional Commits，中文摘要：

```
<type>(<scope>): <摘要，≤50 字>

为什么改、影响哪些端、如何验证
```

- type：`feat` `fix` `refactor` `perf` `docs` `chore` `test` `build` `ci`
- scope：`client` `server` `deploy` `android` `admin` `docs`
- 示例：`fix(server): 修复分享码大小写导致下载 404`

合并只用 **Squash**，PR 标题会成为 `main` 上的提交标题，因此 PR 标题同样遵守上述格式。不要在一个 PR 里混入无关的格式化或重排，评审会被噪音淹没。

---

## 4. PR 必须贴的验证项

CI 尚未接入（后续通过 PR 添加 `.github/workflows/ci.yml`）。在此之前，每个 PR 描述里必须粘贴以下命令的实际输出或结果：

```bash
npx tsc --noEmit        # 类型检查
npm run selfcheck       # 游戏逻辑自检
npm run build           # 生产构建
```

涉及联机、分享码、后台的改动，还要附上真机或局域网验证结论（设备、场景、结果）。只跑构建不验证联机的 PR 不予合并。

PR 模板最少包含：改了什么、影响面（客户端 / 服务端 / 部署 / 文档）、验证输出、是否需要重启生产服务、回滚方式、安全自查（无密码、token、keystore、APK、玩家数据）。

---

## 5. 服务端唯一可信源

**`server/` 是唯一可信源。** 任何 `*.mjs` 改动只改 `server/`，发版时整体同步到 `deploy/linux-server/app/`，不要在 `deploy/linux-server/app/` 里单独修 bug，否则两份代码会悄悄分叉。

- `server/`：开发源，CI 与服务端评审以此为准。
- `deploy/linux-server/`：Linux 发版副本，内容必须与 `server/` 一致；`install.sh` / `upgrade.sh` 读取的是这里的 `app/`。
- `deploy/windows-server/`：**历史版本，已落后于当前代码**。它缺少 `admin.mjs`、`accounts.mjs`、`stats-store.mjs`，`relay-server.mjs` 也是旧版，仅作 Windows 存档参考，不再维护、不再发版。新功能不要往这里补。

发版同步后，本地可用校验确认两处一致：

```bash
diff -r server deploy/linux-server/app
```

（`server/` 里没有 `public/` 等部署专属文件时，diff 输出应只涉及确有差异的文件；发布前必须逐项确认差异是有意为之。）

---

## 6. 禁止入库的凭据与产物

判据是「能重新生成的不入库」「拿到就能冒充身份的不入库」。以下内容一律不得提交，`.gitignore` 已覆盖大部分，但不要依赖它兜底：

**凭据类**

- 真实的 `relay.env`（含 `ADMIN_PASSWORD`）、`.env`、`.env.*`；
- 后台账号文件 `accounts.json`；
- cpolar authtoken、GitHub Personal Access Token、云厂商 AK/SK；
- keystore / jks / p12 / pfx / pem / key，以及 `keystore.properties`、`signing.properties`；
- 任何 SSH 私钥。

**数据类**

- 玩家上传的 `levels.json`、统计 `stats.json`（生产数据只存在于服务器与备份介质）；
- 从生产环境导出的任何数据样本，即使「脱敏」也不要入库。

**构建与打包产物**

- `node_modules/`、`dist/`、`.vite/`；
- `android/app/build/`、`android/build/`、`android/.gradle/`、`.tools/`；
- `*.apk`、`*.aab`、`*.ap_`、`*.dex`、`*.class`；
- `deploy/*.zip`、`server/*.zip` 等打包文件；
- `android/app/src/main/assets/public/` 与 `assets/capacitor.*.json`（`npx cap sync android` 会重建）。

**可以入库的例外**：`deploy/linux-server/relay.env.example`（仅占位符）、`deploy/windows-server/relay.env`（当前为无凭据模板，属于历史包；新建配置请用 `.example` 复制，不要把真实值写进去）。

如果不慎提交，按 [部署运维手册 · 应急处理](docs/部署运维手册.md#7-应急处理) 处理：先轮换凭据，再清理历史。

---

## 7. tag 与版本号

- tag 格式 `v<major>.<minor>.<patch>`，例如 `v1.2.0`，只能打在 `main` 的提交上。
- `package.json` 的 `version` 必须与 tag 完全一致。
- Android：`versionName` = `major.minor.patch`；`versionCode` = `major*10000 + minor*100 + patch`。
  - 当前是 `versionName 1.1` / `versionCode 2`；下一个版本按公式为 `1.2.0` / `10200`。首次套用公式会跳号，之后必须严格单调递增。
- 服务端发布包命名 `magnetic-rush-server-linux-<version>.zip`，内部 `app/` 与 tag 内容一致。
- APK 与部署 zip 作为 **GitHub Release 附件**发布，并附 `SHA256SUMS`；仓库里只留源码，不留二进制。

发布由 Maintainer 执行，步骤见 [docs/部署运维手册.md](docs/部署运维手册.md#3-标准升级流程)。

---

## 8. 日常流程速查

1. 从最新 `main` 拉分支：`git switch -c fix/<描述> origin/main`；
2. 小步提交，遵守第 3 节格式；
3. 推送并开 PR，填完模板，贴验证输出；
4. 至少 1 人批准、CI 全绿、对话解决后 Squash 合并；
5. 合并后删除分支；需要上线时按运维手册发 Release 并部署。

不要直接在 `main` 上 `git commit`，不要 `git push --force` 到共享分支，不要在 PR 里附带本地路径、内网 IP 之外的个人信息。
