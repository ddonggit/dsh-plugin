# dsh-https

为 DSH Web 提供一个独立的 HTTPS 入口：TLS 终止、透明反向代理、可选的登录鉴权闸门、本地 CA 引导和 ACME 自动证书。

它不修改 DSH 核心，也不占用 DSH 自己的 HTTP 端口。插件在自己的监听地址（可配置）上终止 TLS，把明文请求转发到 DSH 原来的监听地址；DSH 自身的 HTTP 入口继续可用。

```
浏览器 ──https:3088──▶ dsh-https（TLS 终止 + 登录鉴权）──http:127.0.0.1:3081──▶ DSH Web
                     └─ 本地 CA / ACME 证书、热加载、SNI
```

## 能力

- **独立入口**：默认 `https://<host>:3088/`，HTTP 3080 完全不动。
- **三种证书来源**：本地 CA、已有 PEM 文件、Let's Encrypt ACME（腾讯云 DNSPod DNS-01）。
- **登录鉴权（可选）**：`auth.enabled: true` 时，未登录访问**任何路径**（含插件自己注册的路由、`/plugins/*`、`/api/*`、WebSocket）都会被拦到登录页；登录后由插件在服务端完成 DSH 核心的令牌交换，不用再带 `?token=`。口令用 scrypt 加盐，会话是 HMAC 签名 Cookie，改密即全员下线。
- **热加载**：`files` 模式按 mtime 轮询；ACME 签发后通过 `setSecureContext` 直接换证书，不关闭监听端口。
- **SNI**：域名命中 ACME 证书时用公网证书；IP/localhost 用本地 CA 叶子证书。
- **完整代理**：HTTP、SSE、WebSocket upgrade、大请求体；保留 `Host`/`Origin`，去掉 hop-by-hop 头。
- **安全 Cookie**：HTTPS 响应里的 `Set-Cookie` 自动补 `Secure`（可关）。
- **设置页**：DSH 设置 →「HTTPS 接入」，查看监听、证书、到期时间、ACME 与登录鉴权状态；可一键切换证书来源、填写 ACME 参数和腾讯云密钥、修改访问密码，改完立即生效（无需重启）。
- **可移植安装/卸载**：标准 DSH bundle，用 `plugin_manager install_bundle` / `remove_bundle` 或 `dsh plugin add/remove`。

## 环境要求

- DSH `>= 0.2.1-rc.2`
- Node.js `>= 20`
- 可选：腾讯云 DNSPod API 凭据（仅 ACME 模式）

## 安装

### 方式 A：DSH 插件管理器（推荐）

在 DSH 会话中：

```text
plugin_manager action=install_bundle target=/path/to/dsh-https
```

安装后插件默认启用并立即挂载。首次启动使用本地 CA，不需要任何配置。

### 方式 B：profile CLI

```bash
dsh plugin --profile web add /path/to/dsh-https
```

`link:` 安装适合本地开发；发布时把目录打包或推到 npm，再把路径换成包名。

### 卸载

```text
plugin_manager action=remove_bundle target=dsh-https
```

或：

```bash
dsh plugin --profile web remove dsh-https
```

卸载会移除 Loader 条目并关闭 HTTPS 监听；3080/3081 不受影响。证书和 CA 数据默认保留在 `$DSH_HOME/https`，需要彻底清理时手动删除该目录。

## 快速使用

1. 安装并启动 DSH Web。
2. 浏览器打开 `https://<主机>:3088/dsh-https/`。
3. 下载 `dsh-local-ca.crt`，安装为受信任的根证书（页面里有各系统步骤）。
4. 用 `https://<主机>:3088/` 打开 DSH，首次仍需带 `?token=...` 完成登录。

> 本地 CA 的私钥在 `$DSH_HOME/https/local-ca/ca.key.pem`，权限 `0600`。只在你信任的设备上安装这个 CA。

## 配置

配置写在 profile 的 `cordis.patch.yml`（推荐由 `configEditor` 或手动编辑），按 `id: dsh-https` 覆盖：

```yaml
- id: dsh-https
  config:
    listen:
      host: '0.0.0.0'
      port: 3088
    publicCert:
      mode: 'local'          # local | files | acme
    localCa:
      enabled: true
      hosts: ['dsh.example.com']
    acme:
      enabled: false
    auth:
      enabled: false           # 打开登录鉴权
```

### 登录鉴权

把 DSH Web 入口交给密码保护。**打开后，未登录访问任何路径都会被拦下**——包括插件自己注册的路由（例如 billion-context 的 `/__bili/*`）、`/plugins/*`（否则插件清单匿名可读）、`/api/*` 和 WebSocket 升级。

```yaml
- id: dsh-https
  config:
    auth:
      enabled: true
      sessionMaxAgeDays: 30      # 登录后浏览器记住多久（1..365）
      rateLimitPerMinute: 5      # 每个来源 IP 每分钟允许的失败次数，超过则指数退避
      mintDshCookie: true        # 登录后由插件服务端换取 DSH 核心 Cookie（推荐）
      publicPaths: []            # 额外放行的路径；以 * 结尾表示前缀，如 '/healthcheck*'
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `auth.enabled` | `false` | 是否启用登录闸门 |
| `auth.sessionMaxAgeDays` | `30` | 会话 Cookie 有效期；超过 90 天会给出提醒 |
| `auth.rateLimitPerMinute` | `5` | 失败次数阈值，超过后按 1、2、4…分钟指数退避（上限 30 分钟）；状态在进程内存里，重启清零 |
| `auth.mintDshCookie` | `true` | 登录成功后插件自己向核心换取 `dsh-auth-*` Cookie，浏览器地址栏不会再出现 `?token=` |
| `auth.publicPaths` | `[]` | 额外的免登录路径（`/dsh-https`、`/dsh-https/`、`/dsh-https/ca.crt` 永远免登录，供本地 CA 引导） |

**首次设置**：`auth.enabled: true` 且还没有口令时，登录页会要求填「一次性口令」——它在启动时生成，保存在 `<dataDir>/auth/setup-token`（0600），设置成功后立即删除。想跳过这一步，在服务器上预置口令：

```bash
# 生成随机口令，明文写到 0600 文件（推荐，口令不会出现在终端记录里）
node scripts/provision-auth.mjs --data-dir "$DSH_HOME/https" --password-file /root/.dsh/dsh-https-initial-password.txt

# 或者把口令打到终端（只显示这一次）
node scripts/provision-auth.mjs --data-dir "$DSH_HOME/https" --print

# 查看状态 / 只轮换会话密钥（密码不变，所有浏览器下线）/ 删除口令回到首次设置
node scripts/provision-auth.mjs --status
node scripts/provision-auth.mjs --rotate-only
node scripts/provision-auth.mjs --clear
```

**忘记密码**：重新运行 `provision-auth.mjs`（会重设密码并让所有已登录浏览器下线）。**临时关闭鉴权**：把 `auth.enabled` 改成 `false` 并重启 DSH Web；`<dataDir>/auth/password.hash` 不存在时等于回到首次设置流程。

**登录页与路由**（都在插件自己的命名空间下，未登录也能访问登录/登出页）：

- `GET /dsh-https/auth/login`（也接受 `/dsh-https/login`）
- `POST /dsh-https/auth/login`、`GET|POST /dsh-https/auth/logout`
- `GET /dsh-https/auth/password`、`POST /dsh-https/auth/password`（改密，写完即登出）
- `GET /dsh-https/auth/status`（已登录可用）

行为要点：

- 已登录但缺少 DSH 核心 Cookie 时，插件会自己换取一次并 303 回原地址；换取不到就退回核心的 `?token=` 跳转，不会形成循环。
- 客户端自带的 `x-forwarded-*` / `forwarded` / `x-real-ip` 一律**剥除**，不转发给上游；插件自己也不添加转发头，DSH 侧始终按明文 HTTP 语义运行（核心 Cookie 因此是 host 绑定、不带 `Secure`，由插件的 `proxy.addSecureCookie` 统一补上）。
- 退出登录会同时清掉浏览器里的 `dsh-auth-*` 核心 Cookie，避免以后关了鉴权还能凭旧 Cookie 直接进入。
- **带 `?token=` 的匿名请求不再直接放行**：会被引到登录页，且令牌参数不会留在登录页 URL 里；登录后由插件自己换取核心会话。也就是说 `dsh web` 打印的令牌 URL 不再能绕过密码（只有 `mintDshCookie: false` 或拿不到 `connection` 服务时才退回"令牌直通"的旧路径）。手机/桌面端如果依赖令牌 URL 配对，请先在设备上用密码登录一次。
- 审计日志写在 `<dataDir>/auth/audit.jsonl`（0600，IP 用 HMAC 假名，超过 5MB 轮转）；日志、页面和接口都不会输出口令、令牌或 Cookie 值。

### 监听与上游

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `listen.host` | `0.0.0.0` | HTTPS 监听地址；`0.0.0.0` 暴露到局域网 |
| `listen.port` | `3088` | HTTPS 端口，不能等于上游端口 |
| `upstream.host` | `127.0.0.1` | DSH 后端地址 |
| `upstream.port` | `webServer.port`（通常 3081） | DSH 后端端口；留空时自动取 DSH Web 实际监听端口（插件加载时监听尚未绑定也没关系，启动时会重新读取） |
| `upstream.protocol` | `http` | 上游协议 |
| `proxy.addSecureCookie` | `true` | 给响应 Cookie 补 `Secure` |
| `proxy.keepAlive` | `true` | 到上游启用 keep-alive |
| `proxy.connectTimeoutMs` | `10000` | 连接/响应超时 |
| `proxy.maxConnections` | `512` | 最大 TLS 连接数 |

`trustedHosts` 不在这里配置：它属于 DSH 的 `connection` 行列。用域名访问时，确保启动参数 `--trusted-host` 包含该域名（无端口条目匹配任意端口）。用 IP 访问时，loopback 和监听地址本身已被信任。

### 本地 CA（默认）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `localCa.enabled` | `true` | 关闭后必须提供 `files` 或 `acme` 证书 |
| `localCa.hosts` | `[]` | 额外写入叶子证书 SAN 的域名；自动包含 localhost、回环地址、所有非内部 IPv4 和主机名 |
| `localCa.rootDays` | `3650` | 根证书有效期 |
| `localCa.leafDays` | `397` | 叶子证书有效期；浏览器不接受超过 398 天，配置更大值会被收敛为 397 并给出警告 |
| `localCa.renewBeforeDays` | `30` | 叶子剩余天数低于该值时自动重签 |

### 已有证书文件

如果证书已经由外部工具（acme.sh / certbot / 反向代理）维护，就让插件直接消费那两个稳定文件，不必再申请一张同名证书，避免重复 ACME 订单和速率限制：

```yaml
publicCert:
  mode: 'files'
  certFile: '/path/to/certs/dsh.example.com/fullchain.pem'
  keyFile: '/path/to/certs/dsh.example.com/key.pem'
  watchIntervalSec: 30
```

外部工具续期后，插件最多 `watchIntervalSec` 秒热加载，无需重启 DSH。只有在没有外部证书维护时才启用下面的内置 ACME。

- `certFile` 可以是 fullchain，叶子证书必须在最前。
- 私钥必须是未加密 PEM；权限建议 `0600`。
- 文件变化后最多 `watchIntervalSec` 秒热加载，无需重启。
- `certFile` / `keyFile` 的相对路径按 `dataDir`（默认 `$DSH_HOME/https`）解析；`dataDir` 本身按进程工作目录解析。
- `publicCert.mode: 'files'` 与 `acme.enabled: true` 互斥：文件模式下不会运行 ACME，避免文件证书与 ACME 证书互相覆盖。

### ACME 自动证书（Let's Encrypt + 腾讯云 DNSPod）

```yaml
publicCert:
  mode: 'acme'
acme:
  enabled: true
  staging: true              # 先 staging 验证，成功后再改 false
  email: 'you@example.com'
  domains: ['dsh.example.com']
  agreeTos: true
  dns:
    provider: 'tencent'
    zone: 'example.com'      # 可留空，插件会从域名反推
    credentialsFile: '/path/to/acme.sh/account.conf'
    # 或使用环境变量 / DSH credentials：
    secretIdRef: 'TENCENT_DNSPOD_SECRET_ID'
    secretKeyRef: 'TENCENT_DNSPOD_SECRET_KEY'
```

凭据解析顺序：

1. `acme.dns.credentialsFile`：支持 `KEY=value`、`export KEY=value` 或 JSON；会读取 `SAVED_Tencent_SecretId` / `SAVED_Tencent_SecretKey`。
2. DSH `credentials` 服务中的 `secretIdRef` / `secretKeyRef`。
3. 同名环境变量。

ACME 行为：

- 使用 DNS-01，TXT 记录名 `_acme-challenge.<domain>`，TTL 600。
- 启动后 5 秒检查；证书剩余天数低于 `renewBeforeDays` 时自动续期，之后每 `checkIntervalHours` 小时再检查。
- 签发失败后按 5/10/20/… 分钟指数退避，最长回到 `checkIntervalHours`，避免反复失败耗尽 Let's Encrypt 的速率限制。
- 先写 `previous/` 备份，再原子替换 `acme/fullchain.pem`、`acme/privkey.pem`、`acme/meta.json`。
- staging 与 production 证书切换、域名变化、到期临近都会触发重新签发。
- 失败会指数退避，错误只记录脱敏信息；DNS 记录在 `finally` 中清理。
- 手动续期：设置页右上角「立即续期」，或 `POST /api/dsh-https/renew`；10 分钟冷却。
- 模式切换：设置页「证书来源」里点「使用自动证书」/「使用证书文件」即可，选择保存到 `dataDir/settings.json`，重启后仍生效；切到自动证书后继续用当前证书，直到首次签发成功。

> 公网域名需要能被 Let's Encrypt 解析到权威 DNS。仅内网 DNS 覆盖、没有公网 NS 的域名无法完成 ACME。

## 状态 API

均走 DSH 官方 `connection.fetch`，继承 Host/Origin 校验和会话认证：

- `GET /api/dsh-https/status`：监听、上游、证书、ACME 状态、当前运行时设置。
- `POST /api/dsh-https/renew`：手动触发一次签发/续期。
- `POST /api/dsh-https/settings`：切换证书来源并保存 ACME 参数（`{mode, acme:{email,domains,zone,staging}}`），立即生效。
- `POST /api/dsh-https/credentials`：保存腾讯云密钥（`{secretId, secretKey}`，留空表示不修改），只写本机 0600 文件，响应只返回掩码。
- `GET /api/dsh-https/auth/status`：登录鉴权是否启用、是否已设密码、会话有效期、限流阈值、核心 Cookie 换取是否可用。
- `POST /api/dsh-https/auth/password`：改密（`{currentPassword, newPassword, confirmPassword}`），成功后轮换会话密钥，所有浏览器下线。

插件自己的路由（不经过 DSH 的 `/api` 网关，同样只在插件监听端口上提供）：

- `GET /dsh-https/auth/login`、`POST /dsh-https/auth/login`
- `GET|POST /dsh-https/auth/logout`
- `GET /dsh-https/auth/password`、`POST /dsh-https/auth/password`
- `GET /dsh-https/auth/status`

公开（不需要登录，便于装 CA）：

- `GET /dsh-https/`：CA 安装引导页。
- `GET /dsh-https/ca.crt`：下载本地根证书。

## 安全说明

- 插件只做 TLS 终止、反向代理和（可选的）入口登录鉴权，不做 HSTS、不强制跳转 HTTP→HTTPS。
- **登录鉴权是访问控制，不是安全边界**：它挡的是"能访问入口但不知道口令"的人。口令只以 scrypt 哈希落盘，会话 Cookie 是 HMAC 签名且 HttpOnly + SameSite=Lax；但过程内存级限流重启即清零，会话是无状态的（登出只清 Cookie，Cookie 泄露只能靠改密止损）。
- 打开鉴权后，**未登录时所有路径都被拦**，包括插件自己注册的路由（如 `/__bili/*`）、`/plugins/*` 与 WebSocket；只有 `/dsh-https`、`/dsh-https/`、`/dsh-https/ca.crt` 和你在 `auth.publicPaths` 里额外指定的路径例外。**不要把 `/api*` 之类的路径放进 `publicPaths`**，那等于把 DSH 的接口重新暴露出去。
- 上游是明文 HTTP 且应只监听回环：插件自己不添加 `x-forwarded-*`，客户端的转发头一律剥除，DSH 始终按明文语义运行；请确保 DSH 后端（`upstream.host/port`）只绑 `127.0.0.1`，否则同机其它进程可以绕过登录直接访问它。
- 3080/3081 等 HTTP 入口不受本插件保护；启用登录鉴权后，应在网络层关闭这些端口，或至少不要让它们暴露到公网。
- 证书私钥、ACME 账号密钥、DNS 凭据、访问口令、会话 Cookie 和一次性口令都不会被写入日志；日志只输出路径、域名和脱敏错误。审计日志记录事件、结果与 IP 的 HMAC 假名，不记录口令。

## 开发与验证

```bash
pnpm install
pnpm run check            # node --check
pnpm test                 # 单元测试（config/acme/local-ca/settings/auth）
pnpm test:smoke           # 集成 smoke（HTTP/SSE/WS/大请求体/证书）
pnpm test:auth-smoke      # 鉴权端到端（真实 TLS + 假核心：匿名全拒、换取 Cookie、WS）
pnpm run verify           # 以上全部
pnpm run auth:provision -- --status   # 查看鉴权数据状态
pnpm run pack:check       # 检查发布文件
```

隔离 profile 端到端：

```bash
export DSH_HOME=/tmp/dsh-https-e2e
dsh web --dump-config >/dev/null          # 初始化 web 模板
dsh plugin --profile web add /path/dsh-https
# 在 $DSH_HOME/profiles/web/cordis.patch.yml 里把 listen.port 改成 3098
dsh web --no-open --host 127.0.0.1 --port 3099
curl -k https://127.0.0.1:3098/dsh-https/
```

发布检查：

- `package.json` 的 `files` 必须包含 `lib/`、`locale/`、`icon.svg`、`cordis.patch.yml`、`README.md`、`CHANGELOG.md`。
- `lib/client.js` 必须预构建提交；宿主不会在安装时构建客户端包。
- `__ModuleLoader__.load.id`、包名、patch insert id 三者必须一致。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 端口没起来 | `ss -ltnp \| grep 3088`；看 DSH 日志里的 `[dsh-https]` |
| 403 被 DSH 拒绝 | `Host` 是否在 `trustedHosts`；用域名时检查 `--trusted-host` |
| 证书警告 | `files`/ACME 证书是否覆盖当前访问的主机名；本地 CA 是否已信任 |
| ACME 一直失败 | 域名是否有公网 NS；DNSPod 凭据是否有目标 zone 权限；先看 staging 错误 |
| 设置页不显示 | 客户端 bundle 是否可访问：`/plugins/dsh-https/client.js`；重启 DSH 后刷新页面 |
| 换证书不生效 | `files` 模式看 mtime；ACME 看 `meta.json` 的 `notAfter` 和日志 |

## License

MIT
