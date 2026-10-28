# Changelog

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
