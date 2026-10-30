# AGENTS.md — dsh-https

写给在本目录工作的代码智能体。规则从属于仓库根 `AGENTS.md`；这里只写本插件特有的部分。

## 这个插件是什么

标准 DSH bundle，一个包揽两件事：

- 宿主半 `lib/index.js`：在自己的监听地址上终止 TLS，把明文请求反向代理给 DSH 原来的监听地址；可选在代理链路最前面挂一层**登录鉴权闸门**；证书来源支持本地 CA、已有 PEM、ACME（腾讯云 DNSPod DNS-01）。
- 浏览器半 `lib/client.js`：DSH 设置 →「HTTPS 接入」页面（监听/证书/ACME 状态 + 证书来源切换 + 登录鉴权状态与改密）。

三处 id 必须一致：`package.json` 的 `name`、`cordis.patch.yml` 的 `insert.id`、`lib/client.js` 里 `__ModuleLoader__.load({ id })`。

## 目录

- `lib/`：宿主半源码，**源码即产物，没有构建步骤**。`lib/auth/` 是登录鉴权：`core.js`（纯函数：口令哈希、会话签名、限流、Cookie 解析）、`store.js`（`<dataDir>/auth` 落盘）、`pages.js`（登录/改密/错误页 HTML）、`gate.js`（闸门判定与核心 Cookie 换取）。
- `lib/client.js`：预构建提交的浏览器半，改完直接生效于浏览器（宿主半改动需要重启 DSH Web）。
- `scripts/`：`acme-preflight.mjs`、`provision-auth.mjs`（用户会直接 `node scripts/...` 运行，参数与输出要稳定、可脚本化）。
- `tests/`：端到端 smoke（真实 TLS，进程内起假上游）；`test/`：`node:test` 单元测试。

## 硬性规范

- **零额外运行时依赖**：只用 Node 标准库。`@peculiar/x509`、`acme-client` 只允许服务于本地 CA / ACME，登录鉴权不得引入它们。
- 生命周期一律 `ctx.effect(() => { ...; return dispose })`，不留下裸 `setInterval` / 未清理的 socket。
- 数据只写 `config.dataDir`（默认 `$DSH_HOME/https`），文件 0600、目录 0700；不回写 profile 配置，不在仓库里落数据。
- 日志脱敏：不打印访问口令、会话 Cookie、`?token=`、ACME 账号密钥、DNS 密钥、证书私钥；错误信息统一走 `sanitizeError` / `redactErrorMessage`。
- 命令行工具里的明文口令只允许写 0600 文件或 stdout 打印一次，绝不写入日志或审计。
- 反向代理**不得添加** `x-forwarded-*` / `forwarded` / `x-real-ip`，并继续剥除客户端传来的这些头（DSH 侧始终按明文 HTTP 语义运行）。
- 闸门默认关闭（`auth.enabled: false`），关闭时必须完全等同于 0.2.0 的纯反代行为；开启时必须 fail-closed（拿不到判定依据就拒绝，而不是放行）。
- 本插件在插件自己的端口上认证，**不得**改写 Host/Origin，也不得依赖 DSH 核心的内部实现细节；与核心的交互只通过 `connection.fetch.register`、`connection.authenticatedUrl` 和公开的 `/?token=` 交换。

## 验证（每次改动都要跑，退出码必须是 0）

```bash
pnpm install          # 首次；@peculiar/x509 与 acme-client 未装时 test/acme、test/local-ca 会直接失败
pnpm run verify       # check + test（含 test/auth.test.mjs）+ test:smoke + test:auth-smoke
```

- 改闸门行为（判定树、Cookie 换取、限流、页面输出）必须同时补/改 `test/auth.test.mjs` 与 `tests/auth-smoke.mjs`，两处都要覆盖"匿名被拦"和"登录放行"。
- **写完文件要回读校验**：本机 harness 会把形如 `.test(`、`token=<值>` 的字面量替换成 `{{SECRET_xxx}}` / `{{PASSWORD_xxx}}` 占位符，写完必须确认内容没被改坏（断言里用 `includes(...)` 或字符串拼接规避）。

## 提交

- 只 `git add dsh-https/`（仓库里还有其它插件和未跟踪目录），中文提交信息 `type(dsh-https): 摘要`，只提交本地仓库，不 push。

## 部署注意

- 切换拓扑时：`listen.port` 必须不等于 `upstream.port`；DSH 自己要去掉 `--tls-cert/--tls-key`，把 `--host` 收回到 `127.0.0.1`，保留 `--public-url` 与 `--trusted-host`（域名访问靠它过 Host 栅栏）。云主机上**对外监听必须留在云 NAT/EIP 指向的那张网卡的地址**（本机是 `10.1.0.2`），只有上游能收回到回环。
- 上游必须只监听回环，否则同机进程可以绕过登录闸门直接访问 DSH。
- **重启 DSH Web 会中断正在进行的会话**（包括正在操作的智能体会话），所以切流/回滚要用带看门狗与自动回滚的单命令脚本，时机由用户决定，不要在别人的会话里擅自重启。

## 本机部署事实（2026-10-30 起生效）

- 拓扑：`10.1.0.2:3000`（dsh-https：TLS 终止 + 登录鉴权，证书用 `files` 模式复用 `/opt/magpie/certs/{fullchain,privkey}.pem`）→ `127.0.0.1:3001`（dsh 本体，明文）。
- systemd：`/etc/systemd/system/dsh-web.service`（权威）与副本 `/root/.dsh/bin/dsh-web.service` 内容一致；`ExecStart` = `dsh web --no-open --host 127.0.0.1 --port 3001 --public-url https://api.comptar.cn:3000/ --trusted-host api.comptar.cn`；另有 `EnvironmentFile=/root/.dsh/web-token` 与 `ExecStartPre=/root/.dsh/bin/ensure-web-fixed-token.sh`。
- profile：`/root/.dsh/profiles/web`；`cordis.patch.yml` 有 `id: dsh-https`（listen `10.1.0.2:3000`、upstream `127.0.0.1:3001`、`dataDir: /root/.dsh/https`、`auth.enabled: true`）；`package.json` 的依赖与 `dsh.profile.bundles` 都含 `dsh-https: link:/opt/dsh-plugins/dsh-https`。
- 数据：`/root/.dsh/https/auth/{password.hash,secret,audit-key,audit.jsonl,setup-token}`；首次口令明文在 `/root/.dsh/dsh-https-initial-password.txt`（0600，用完即删）。
- `dsh-web-cert-check.timer/.service` 已 **disabled**（证书改由插件热加载）；acme.sh 仍写同一对 PEM，插件最多 `watchIntervalSec`（30 秒）内换新，无需重启。
- 运维脚本（宿主专属，不在仓库、也不随插件发布）：

| 脚本 | 用法 |
| --- | --- |
| `/root/.dsh/bin/dsh-https-verify.sh` | `gate`（默认：逐项确认匿名全被拦、上游只监听回环、口令文件权限）/ `--expect-legacy`（确认还是老的 dsh 自带 TLS）。目标可用 `DSH_HTTPS_ENTRY_HOST/ENTRY_PORT/ENTRY_IP/UPSTREAM_PORT/DATA_DIR` 改 |
| `/root/.dsh/bin/dsh-https-cutover.sh` | `--dry-run` 先看要写什么；`--print-config` 只打印 patch 与 unit；直接执行 = 备份 → 预置口令 → 追加 patch → `dsh plugin add` → 校验组合配置 → 改 unit → 停 cert timer → 重启 → 看门狗 180 秒自检，失败自动回滚 |
| `/root/.dsh/bin/dsh-https-rollback.sh` | `--list` 列备份；默认取最新；只还原 unit / `package.json` / `cordis.patch.yml` 并重启，**不删鉴权数据**（随时能再切回） |

备份目录：`/root/.dsh/backup/dsh-https-<时间戳>/`。

## 踩过的坑（改闸门或这些脚本前先看）

- `DSH_HOME` 不是 profile 目录的上一级：`/root/.dsh/profiles/web` 要 `dirname` **两次**才得到 `/root/.dsh`。切流脚本曾少算一层，把 `dsh plugin add` 指到错误 home，在 `/root/.dsh/profiles/profiles/web` 建出一个假 profile，报"组合配置里没有对外端口 3000"（那份假配置是插件默认的 3088）。现在脚本先校验 `$DSH_HOME/profiles/<name>` 存在，否则直接拒绝运行。
- 重启**之前**的任何失败都必须把改过的文件还原（切流脚本现在用 `abort_pre` + `ERR` trap，已用注入失败的沙箱测试验证），否则用户会拿到一个"半改"的 profile。
- 判断组合配置是否正确要同时查 id 和两个端口：`dsh --profile web --dump-config | grep -A16 'id: dsh-https'`，`port: 3000` 与 `port: 3001` 缺一不可。
- 本机 `dsh` 版本下 `dsh plugin --profile <name> add …` **会**自动更新 `dsh.profile.bundles`（仓库根 README 的旧说法已更正）。
- 宿主半的 `logger.info` 在默认日志级别下不进 `journalctl`（只看得到 warn/error）；确认闸门状态用设置页或 `/api/dsh-https/status`。