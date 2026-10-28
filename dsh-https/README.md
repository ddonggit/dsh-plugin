# dsh-https

为 DSH Web 提供一个独立的 HTTPS 入口：TLS 终止、透明反向代理、本地 CA 引导和 ACME 自动证书。

它不修改 DSH 核心，也不占用 DSH 自己的 HTTP 端口。插件在 `0.0.0.0:3088`（可配置）监听 HTTPS，把明文请求转发到现有的 `127.0.0.1:3081`；HTTP 的 3080/3081 继续可用。

```
浏览器 ──https:3088──▶ dsh-https（TLS 终止）──http:127.0.0.1:3081──▶ DSH Web
                     └─ 本地 CA / ACME 证书、热加载、SNI
```

## 能力

- **独立入口**：默认 `https://<host>:3088/`，HTTP 3080 完全不动。
- **三种证书来源**：本地 CA、已有 PEM 文件、Let's Encrypt ACME（腾讯云 DNSPod DNS-01）。
- **热加载**：`files` 模式按 mtime 轮询；ACME 签发后通过 `setSecureContext` 直接换证书，不关闭监听端口。
- **SNI**：域名命中 ACME 证书时用公网证书；IP/localhost 用本地 CA 叶子证书。
- **完整代理**：HTTP、SSE、WebSocket upgrade、大请求体；保留 `Host`/`Origin`，去掉 hop-by-hop 头。
- **安全 Cookie**：HTTPS 响应里的 `Set-Cookie` 自动补 `Secure`（可关）。
- **设置页**：DSH 设置 →「HTTPS 接入」，查看监听、证书、到期时间、ACME 状态并手动续期；还能一键切换证书来源、填写 ACME 参数和腾讯云密钥，改完立即生效（无需重启）。
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
```

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

公开（不需要登录，便于装 CA）：

- `GET /dsh-https/`：CA 安装引导页。
- `GET /dsh-https/ca.crt`：下载本地根证书。

## 安全说明

- 插件只做 TLS 终止和反向代理，不做 HSTS、不强制跳转 HTTP→HTTPS，也不改 DSH 的认证逻辑。
- 3080 仍然是明文 HTTP 入口；需要“只允许 HTTPS”时，应在网络层关闭 3080，或另外配置防火墙。
- 证书私钥、ACME 账号密钥、DNS 凭据不会被写入日志；日志只输出路径、域名和脱敏错误。
- 监听 `0.0.0.0:3088` 意味着局域网可访问。只在可信网络使用，或把 `listen.host` 改成 `127.0.0.1` 后由外层代理转发。

## 开发与验证

```bash
pnpm install
pnpm run check        # node --check
pnpm test             # 单元测试
pnpm test:smoke       # 集成 smoke（HTTP/SSE/WS/大请求体）
pnpm run pack:check   # 检查发布文件
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
