# dsh-plugin

一组面向 DSH（DeepSeek Harness）Web 端的本地插件，全部是标准 **bundle** 形态：宿主半 `apply(ctx, config)` + 浏览器半 `window.__ModuleLoader__.load(...)`，通过 `dsh.bundle.patch` 插进 profile 的层叠配置。

- 适用版本：DSH `>= 0.2.1-rc.2`
- 包形态：ESM npm 包，零/少运行时依赖
- 安装方式：本地目录 `link:` 安装（改代码不必重装）

## 插件一览

| 目录 | 包名 | 版本 | 作用 |
|---|---|---|---|
| [`dsh-https`](dsh-https) | `dsh-https` | 0.3.0 | 独立 HTTPS 入口 + 可选登录鉴权闸门：TLS 终止、透明反向代理、本地 CA / ACME（腾讯云 DNSPod DNS-01）自动证书；开鉴权后 `/plugins/*`、`/api/*`、WebSocket 与插件自有路由（如 `/__bili/*`）都要先登录 |
| [`dsh-mobile`](dsh-mobile) | `dsh-mobile` | 0.6.1 | Web 端移动布局（抽屉侧栏、全屏面板、安全区、触控优化）+ 任意页面全局返回/关闭 + 任务完成/等待确认通知（浏览器通知与宿主端多通道推送） |
| [`dsh-restart`](dsh-restart) | `dsh-restart` | 1.1.0 | 受控重启 dsh web：自动识别 systemd 单元 / 无 systemd 直接重启，HTTPS/具体网卡探测，阶段化进度与失败现场 |
| [`dsh-running-sessions`](dsh-running-sessions) | `dsh-running-sessions` | 0.1.0 | 跨工作区汇总「运行中 / 等待你处理 / 刚完成」的会话，一个入口直达 |
| [`dsh-usage-query`](dsh-usage-query) | `dsh-usage-query` | 0.3.1 | 设置页「用量查询」：DeepSeek 余额、OpenCode Go 配额、OpenDesign 余额与积分 |

有 README 的插件在各自目录里给出配置、接口与排障说明；没有 README 的看 `package.json` 的 `description` 与 `locale/*.json` 的界面文案。

### 可移植的重启（dsh-restart 1.1+）

不再写死 `dsh-web` / `127.0.0.1` / HTTP：单元名从当前进程 cgroup 识别（system 或 user 管理器），没有 systemd 时退化为「停旧进程 + 原 argv 拉起」的直接重启，探测走 TCP + HTTP(S)，支持具体网卡、TLS 与 IPv6。配置项和排障见 [`dsh-restart/README.md`](dsh-restart/README.md)。

### 入口登录鉴权（dsh-https 0.3+）

`dsh-https` 0.3 起可以在代理链路最前面挂一层口令登录闸门，把整个 DSH Web 入口保护起来：

- 覆盖**所有路径**：`/plugins/*`（否则插件清单匿名可读）、`/api/*`、WebSocket，以及插件自己注册的路由（例如 `billion-context` 的 `/__bili/*` 管理面板）。
- 口令只保存加盐派生哈希（落盘文件 0600），会话是 HMAC 签名 Cookie；改密即所有设备下线；登录失败按来源 IP 指数退避；审计日志里的 IP 用 HMAC 假名。
- 登录后由插件在服务端换取 DSH 核心 Cookie，浏览器不用再带 `?token=`；令牌 URL 不再能绕过口令。
- 也可以让插件接管原来对外的端口、让 DSH 退回回环明文（"唯一入口"部署），做法见 [`dsh-https/README.md`](dsh-https/README.md) 的「作为唯一入口部署」。

这样，像 `billion-context` 那种提示"入口需受登录鉴权或反向代理保护"的插件，前提就成立了。

## 安装

### 1. 装入 profile

在 DSH 会话里用插件管理器（若该会话有 `plugin_manager` 工具）：

```text
plugin_manager action=install_bundle target=/path/to/dsh-plugins/dsh-https
```

或用 profile CLI 安装依赖：

```bash
dsh plugin --profile web add /path/to/dsh-plugins/dsh-https
```

### 2. 确认它进了 bundle 列表

不同 DSH 版本行为不同：有的只维护依赖，有的会同时把包写进 `dsh.profile.bundles`（本机当前版本会）。一律按下面方式核对：

```bash
dsh --profile web --dump-config | grep -A4 'id: dsh-https'
```

没有输出时，把包名加到 `$DSH_PROFILE_DIR/package.json` 的 `dsh.profile.bundles`，再重启一次 dsh web。`plugin_manager install_bundle` 会同时处理依赖和 bundle 列表。

要点：

- **包名已存在时**安装会报 `already-installed`，升级要先 `remove` 再 `add`。
- 插件市场/其它安装器可能重写 bundle 列表；装完别的插件后复查一次。
- 不要手改 `cordis.yml`；bundle 列表和 `cordis.patch.yml` 优先交给安装器，手改后务必用 `--dump-config` 复查。
- 宿主半改动必须重启 dsh web 才生效（见“开发”）。
- 卸载只取消加载，**`$DSH_HOME/<name>/` 下的数据不会删除**（凭据、证书、通知配置等），要清理需手动删。

## 目录约定

每个插件都是自包含的 npm 包，三处 id 必须完全一致，否则页面白屏且没有明显报错：

1. `package.json` 的 `name`
2. `cordis.patch.yml` 里 `insert.id`
3. 浏览器半 `client.js` 里 `__ModuleLoader__.load({ id })`

宿主半入口在 `main` / `exports["."]`，浏览器半在 `exports["./client"]`。`files` 是发布白名单，`lib/`、`locale/`、`icon.svg`、`cordis.patch.yml` 必须在内。

## 开发

```bash
cd <name>

npm run check                 # 语法/前端 harness，具体命令见各包 scripts
npm test                      # 单元测试；没有 scripts 的包见其 README
node test/selftest.mjs        # dsh-restart 的自测入口（等价于它的 npm test）

# 可选：装了 dsh-plugin-dev skill 时，检查 bundle 契约
node "$DSH_HOME/skills/dsh-plugin-dev/scripts/check-bundle.mjs" .
```

改动生效方式：

| 改动 | 生效方式 |
|---|---|
| `client.js` / `client.*.js` | 刷新页面（revision 由 mtime + size 推导） |
| `locale/*.json`、`icon.svg` | 刷新页面 |
| 宿主半 `lib/*.js` / `index.js` | **必须重启宿主**，已加载的 ESM 模块不会换新 |
| `cordis.patch.yml` 的 `config` | `patchReload: live` 下热重载 |

只改浏览器半时页面会先变；宿主半没重启就会出现「界面新、接口旧」的混合状态，排查时注意这一点。

## 已知限制

- `dsh-restart` 的 Windows 直接重启未验证；Linux（有/无 systemd）已实测，macOS 依赖 `lsof`/`ps` 尽力支持。
- `dsh-https` 的登录鉴权是**单口令**访问控制：没有多用户、没有二次验证，只能靠"改密让全员下线"；开启后必须让 DSH 自己的监听只绑回环（`--host 127.0.0.1`），否则同机进程或另一个入口可以绕过闸门。
- `dsh-running-sessions/design/` 只保留可重放的 HTML 原型；真实环境截图含个人会话标题，未纳入仓库。
- 各插件以本地自用为主，浏览器半的视觉与交互多靠人工验证，未做自动化 UI 测试。

## 许可

MIT。根目录 [`LICENSE`](LICENSE) 覆盖本仓库；`dsh-https`、`dsh-usage-query` 目录下另有各自的 LICENSE 文件。
