# dsh-plugin

一组面向 DSH（DeepSeek Harness）Web 端的本地插件，全部是标准 **bundle** 形态：宿主半 `apply(ctx, config)` + 浏览器半 `window.__ModuleLoader__.load(...)`，通过 `dsh.bundle.patch` 插进 profile 的层叠配置。

- 适用版本：DSH `>= 0.2.1-rc.2`
- 包形态：ESM npm 包，零/少运行时依赖
- 安装方式：本地目录 `link:` 安装（改代码不必重装）

## 插件一览

| 目录 | 包名 | 版本 | 作用 |
|---|---|---|---|
| [`dsh-https`](dsh-https) | `dsh-https` | 0.2.0 | 独立的 HTTPS 入口：TLS 终止、透明反向代理、本地 CA 引导、ACME（腾讯云 DNSPod DNS-01）自动证书 |
| [`dsh-mobile`](dsh-mobile) | `dsh-mobile` | 0.5.6 | Web 端移动布局（抽屉侧栏、全屏面板、安全区、触控优化）+ 任务完成/等待确认通知（浏览器通知与宿主端多通道推送） |
| [`dsh-restart`](dsh-restart) | `dsh-restart` | 1.1.0 | 受控重启 dsh web：自动识别 systemd 单元 / 无 systemd 直接重启，HTTPS/具体网卡探测，阶段化进度与失败现场 |
| [`dsh-running-sessions`](dsh-running-sessions) | `dsh-running-sessions` | 0.1.0 | 跨工作区汇总「运行中 / 等待你处理 / 刚完成」的会话，一个入口直达 |
| [`dsh-usage-query`](dsh-usage-query) | `dsh-usage-query` | 0.3.1 | 设置页「用量查询」：DeepSeek 余额、OpenCode Go 配额、OpenDesign 余额与积分 |

有 README 的插件在各自目录里给出配置、接口与排障说明；没有 README 的看 `package.json` 的 `description` 与 `locale/*.json` 的界面文案。

### 可移植的重启（dsh-restart 1.1+）

不再写死 `dsh-web` / `127.0.0.1` / HTTP：单元名从当前进程 cgroup 识别（system 或 user 管理器），没有 systemd 时退化为「停旧进程 + 原 argv 拉起」的直接重启，探测走 TCP + HTTP(S)，支持具体网卡、TLS 与 IPv6。配置项和排障见 [`dsh-restart/README.md`](dsh-restart/README.md)。

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

`dsh plugin add` 只维护依赖，不会自动把包加进 `dsh.profile.bundles`。检查：

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
- `dsh-running-sessions/design/` 只保留可重放的 HTML 原型；真实环境截图含个人会话标题，未纳入仓库。
- 各插件以本地自用为主，浏览器半的视觉与交互多靠人工验证，未做自动化 UI 测试。

## 许可

MIT。根目录 [`LICENSE`](LICENSE) 覆盖本仓库；`dsh-https`、`dsh-usage-query` 目录下另有各自的 LICENSE 文件。
