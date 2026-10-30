# Changelog

## 0.3.1

- 安全修复：`?next=` 在 URL 归一化后再校验一次 pathname，堵住 `/a/..//evil.com` 这类绕过（归一化后会变成协议相对地址 `//evil.com`）造成的开放重定向。
- 安全修复：登录闸门自身抛异常时改为直接拒绝（HTTP 500、WebSocket 1006/500 响应），不再落回未认证转发；符合“开启鉴权即 fail-closed”。
- 安全修复：换不到核心 Cookie 时的回退跳转一律使用 `https://`，并只接受裸 `Host`（拒绝带路径/用户信息/查询串的伪造 Host），避免把 `?token=` 明文泄露或发到错误主机。
- `provision-auth.mjs` 的改密 / `--rotate-only` / `--clear` 现在会被运行中的插件在几秒内自动感知（会话密钥热加载，无需重启 DSH）；`--clear` 也会真正轮换会话密钥，删口令后旧会话立即失效。
- 新增 `test/https-server.test.mjs`（闸门异常 fail-closed）并补充开放重定向、Host 校验、CLI 轮换的回归测试；`auth-smoke` 增加构造 `next` 的断言。

## 0.3.0

- 新增**登录鉴权闸门**（`auth.enabled`，默认关闭，保持 0.2.0 行为）：在插件自己的监听端口上拦下所有未登录请求——插件自有路由（如 billion-context 的 `/__bili/*`）、`/plugins/*`、`/api/*`、WebSocket 升级、静态资源一并覆盖；未登录时页面请求 302 到登录页，非 GET 的接口请求返回 401 JSON。
- 登录成功后由插件在服务端向 DSH 核心换取 `dsh-auth-*` 会话 Cookie 并 303 回原地址，浏览器不再需要 `?token=`；换取不可用时自动退回核心的令牌跳转，不会形成重定向循环。
- 口令以 scrypt（N=16384, r=8, p=1）加盐哈希存于 `<dataDir>/auth/password.hash`（0600），与 `@fonlan/dsh-web-auth` 的哈希格式互通；会话是 HMAC-SHA256 签名 Cookie（HttpOnly、SameSite=Lax、HTTPS 下 Secure）。
- 首次启用支持一次性口令（`<dataDir>/auth/setup-token`，0600，设置成功后删除）；也可用 `scripts/provision-auth.mjs` 预置口令或一键轮换/清除（`--password-file`、`--print`、`--stdin`、`--rotate-only`、`--clear`、`--status`），明文口令不进日志、不进对话记录。
- 登录限流按来源 IP（默认 5 次/分钟，超过后 1、2、4…分钟指数退避，上限 30 分钟，进程内存级）；审计日志 `<dataDir>/auth/audit.jsonl`（0600，IP 用 HMAC 假名，>5MB 自动轮转）。
- 退出登录会同时清除 `dsh-auth-*` 核心 Cookie，避免关闭鉴权后旧 Cookie 仍可直入；改密即轮换会话密钥并让所有浏览器下线。
- 插件设置页新增「登录鉴权」面板：启用状态、是否已设密码、会话有效期、限流阈值、核心 Cookie 换取是否可用，并可在此直接修改访问密码、打开登录/改密/登出页面。
- 新增 `GET /api/dsh-https/auth/status`、`POST /api/dsh-https/auth/password`，以及插件自有页面路由 `/dsh-https/auth/{login,logout,password,status}`（另接受 `/dsh-https/{login,logout,password}` 短别名）。
- 新增 `test/auth.test.mjs`（18 个用例，含闸门集成矩阵）与 `tests/auth-smoke.mjs`（真实 TLS 端到端 41 项断言：匿名全拒、登录换取核心 Cookie、插件路由与 WS 放行、会话跨重启存活、登出与改密失效）；`npm run verify` 串起 check + 单元测试 + 两个 smoke。
- 登录鉴权只用 Node 标准库；`@peculiar/x509`、`acme-client` 仍只服务于本地 CA 与 ACME。

## 0.2.0

- 设置页新增「证书来源」面板：一键在「证书文件」与「自动证书（ACME）」之间切换，立即生效，无需改 `cordis.patch.yml` 或重启。
- 切换结果持久化到 `dataDir/settings.json`（权限 0600），重启后保持上次选择。
- 设置页可直接填写 ACME 参数（邮箱、域名、DNS 区域、Staging）并保存；参数不完整时拒绝切换到自动证书并说明原因。
- 设置页可手工保存腾讯云 DNSPod 的 SecretId / SecretKey，写入 `dataDir/tencent-credentials.json`（0600），页面只显示掩码；SecretKey 留空表示不修改。
- 凭据优先级：设置页保存的密钥 → `acme.dns.credentialsFile` → DSH credentials 服务 → 环境变量。
- 新增接口 `POST /api/dsh-https/settings`、`POST /api/dsh-https/credentials`，返回最新状态。
- 切换到自动证书时继续使用当前证书，直到首次签发成功，切换过程不会中断 HTTPS；保存密钥后自动重试一次签发。
- 证书文件热加载监听改为可启停，跟随模式切换，ACME 模式下不再空转。
- 新增 `test/settings.test.mjs`（模式合并、域名解析、密钥掩码）。

## 0.1.1

- 上游端口迟绑定修复：插件加载时 DSH Web 监听可能尚未绑定，`upstream.port` 留空时会在启动阶段重新读取实际端口；非 3081 端口不再转发到错误目标。
- WebSocket upgrade 跟随 `upstream.protocol`：上游为 HTTPS 时改用 TLS 连接，不再发送明文握手；upgrade 请求同样过滤 `x-forwarded-*` / `forwarded` / `x-real-ip`。
- ACME 失败改为真正的指数退避（5/10/20… 分钟，上限 `checkIntervalHours`），与 README 描述一致。
- `publicCert.mode: 'files'` 时禁用 ACME，避免文件证书与 ACME 证书反复互相覆盖。
- `localCa.leafDays` 超过 397 时收敛并告警；`renewBeforeDays >= leafDays` 时提示每次启动都会重签。
- 过期证书在设置页显示“证书已过期”，不再误报“未配置”；ACME 徽标按真实状态（待机/签发中/有效/错误）显示中文。
- 腾讯云 DNS 非 2xx 响应也优先透出 API 错误码与信息。
- 运行时警告去重并限长，设置页不再堆积重复条目。
- 文档修正：CA 私钥文件名、证书相对路径基准、客户端 bundle 地址。

## 0.1.0

- 首个版本：独立 HTTPS 入口（默认 `0.0.0.0:3088`），透明代理到 DSH Web 的 loopback HTTP 监听。
- 本地 CA：ECDSA P-256 根证书、叶子证书、SAN 自动收集、到期自动重签、CA 引导页与下载。
- `files` 证书模式：PEM 校验、权限提示、按 mtime 热加载。
- ACME：Let's Encrypt DNS-01、腾讯云 DNSPod TC3 签名、TXT 传播校验、staging/production、自动续期与手动续期。
- SNI 选择公网/本地证书；HTTP、SSE、WebSocket upgrade 透明转发；Cookie 自动补 `Secure`。
- 设置页「HTTPS 接入」：状态、证书、ACME、续期。
- 修复 `files` 证书来源标签与热加载生命周期；卸载/HMR 时可靠关闭 TLS 监听。
- 标准 DSH bundle：`cordis.patch.yml`、`dsh.bundle.patch`、`dsh.client`、中英文 locale、图标。
