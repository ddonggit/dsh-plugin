# dsh-mobile 开发指引（AGENTS.md）

本文件约束在 `dsh-mobile/` 目录内工作的代码智能体。开始改动前先读本文件；它与用户当前指令冲突时，以用户指令为准，并先说明冲突点。

`dsh-mobile` 是 DSH（DeepSeek Harness）Web 的 bundle 插件，做两件互相独立的事：

1. **移动端布局**：小屏下的抽屉侧栏、全屏面板、安全区、触控目标；
2. **任务通知**：任务完成 / 失败 / 等待确认时，走浏览器通知，或由宿主进程推送到飞书、钉钉、企业微信、Telegram、ntfy、Server酱、通用 Webhook。

两件事共享一个插件入口，但**必须能各自独立失败**：布局坏了不能拖累通知，通知坏了不能拖累布局。

---

## 0. 两条硬性要求

### 0.1 每一轮修改：验证通过后，必须提交到本地 git 仓库

“一轮”指一个可独立说明的改动（一个修复、一个功能、一次文档更新）。顺序固定：

1. 修改代码或文档；
2. 在 `dsh-mobile/` 下运行完整验证，退出码必须为 0；
3. 只提交本目录的改动，提交信息写清“改了什么、怎么验证的”。

```bash
cd /opt/dsh-plugins/dsh-mobile
npm run verify          # 客户端 harness + 全量单元测试；当前基线 46 项

cd /opt/dsh-plugins
git status --short
git add dsh-mobile/<本次改动的文件>   # 不要 git add -A / git add .
git diff --cached --name-only          # 只应出现 dsh-mobile/ 下的文件
git commit -m "fix(dsh-mobile): 一句话说明" -m "- 改动点
- 验证：npm run verify（46 项全过）"
git log -1 --stat
```

验证通过的硬标准：

- `npm run check` 输出 `HARNESS OK`；
- `npm test` 输出 `# pass 46`、`# fail 0`、`# cancelled 0`（新增用例后总数会增加，但 `cancelled` 必须为 0）；
- `npm run verify` 退出码 0。

规则：

- **验证失败不提交。** 修到通过为止；修不动就停下来报告，不要先提交再补。
- **不跳过、不弱化、不删除测试来制造通过**；不写 `--no-verify`；不把没跑过的检查写成“已验证”。
- **只提交本地仓库，不 push。** 用户明确要求推送时才推送；永远不要 force push 或改写历史。
- 提交信息用中文，格式 `type(dsh-mobile): 摘要`，类型用 `feat` / `fix` / `docs` / `test` / `chore` / `refactor` / `perf`。正文列改动点，并写明验证命令和结果。
- 纯文档修改也算一轮：同样跑 `npm run verify` 再提交，保持规则一致。
- 验证不能外包给 hook：`dsh-mobile/.githooks/pre-commit` 当前未启用（`core.hooksPath` 未设置），且它假定当前目录是包目录；不要依赖它，也不用为了省事去改它。每轮手动跑 `npm run verify`。

### 0.2 按 DSH 插件规范工作

最低限度必须满足：

1. **三处 id 完全一致**：`package.json` 的 `name`、`cordis.patch.yml` 的 `insert.id`、`client.js` 里 `__ModuleLoader__.load({ id })` 的值，都必须是 `dsh-mobile`。每个 `client.*.js` chunk 的 `load({ id })` 也必须是 `dsh-mobile`。不一致会导致页面白屏或 chunk 拒绝加载。
2. **两半各司其职**：宿主半入口是 `index.js`（`main` / `exports["."]`），浏览器半入口是 `client.js`（`exports["./client"]`），其余 `client.*.js` 是入口按需拉取的 chunk。
3. **保持 bundle 形态**：`dsh.bundle.patch` 指向 `cordis.patch.yml`；`dsh.client` 为 `{ platform: "web", immediately: true, inject: [] }`；`files` 白名单必须覆盖 `index.js`、`client.js`、`client.*.js`、`lib`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`。
4. **无构建步骤**：源码即产物。不要引入打包器、TypeScript、生成文件或编译宏。
5. **零运行时依赖**：只用 Node 标准库和 DSH 浏览器基座已提供的 `react`。新增依赖前先证明标准库/现有模块做不到，并征得用户同意。
6. **生命周期可清理**：宿主半新增的定时器、监听、订阅、路由用 `ctx.effect(() => { ...; return dispose })` 注册；浏览器半的样式、DOM 监听、interval、Service Worker 消息监听同样通过 `ctx.effect` 清理。
7. **配置与秘密分离**：可提交的默认值放 `cordis.patch.yml` 的 `notify` 块；token、webhook、sendKey 等只放 `$DSH_HOME/dsh-mobile/settings.json`（0600，热重载）。不要把秘密写进 patch、代码、测试、日志或提交信息。
8. **版本兼容**：`engines.dsh >= 0.2.1-rc.2`、Node `>= 20`。不要使用低于该基线的 API。

---

## 1. 运行模型

- 宿主半 `index.js` 在 dsh web 进程里 `apply(ctx, rawConfig)`：提供 Service Worker 脚本、注册通知接口、挂载调度器、监听 `settings.json` 变化。
- 浏览器半 `client.js` 注册一个 factory，注入 `slots, layout, sessions, uiSession, uiWorkspace, locale`，然后在 `apply(ctx)` 里按顺序异步拉起 chunk、安装布局/通知/深链，并注册设置页入口。
- 每个 chunk 是一个独立的浏览器脚本，通过 `require.async('./client.<name>.js')` 拉取；chunk 自己再调用 `window.__ModuleLoader__.load({ id: 'dsh-mobile', chunk: '<file>', factory(require) { ... } })` 注册 factory。chunk 必须自包含：不能同步 `require` 另一个相对路径 chunk，也不能依赖入口闭包里的变量。
- 宿主与浏览器共享通知内容的渲染逻辑（`lib/notify/compose.js`），这样同一个事件无论由宿主推送还是由浏览器补发，卡片内容一致。
- 浏览器通知需要安全上下文（HTTPS）；Android 上不能用 `new Notification()`，所以宿主在 `/plugins/dsh-mobile/sw.js` 提供 Service Worker，并用 `Service-Worker-Allowed: /` 申请根作用域。

目录职责：

| 路径 | 职责 |
|---|---|
| `index.js` | 宿主半入口：SW、通知配置合并、调度器、路由、设置监听 |
| `client.js` | 浏览器半入口：chunk 加载、启动顺序、slots、locale、关键 CSS |
| `client.styles.js` | 移动皮肤与设置页样式（只负责表现） |
| `client.sidebar.js` | 侧栏状态机、DOM 选择器、手势、`data-dshm-*` 标记 |
| `client.back.js` | 手机端全局返回/关闭按钮：body 级浮层，按层退一步 |
| `client.deeplink.js` | `#session=` / `?session=` 深链 |
| `client.notify.js` | 浏览器通知、feed 追赶、宿主设置缓存、SW 消息 |
| `client.resource-compat.js` | 华为浏览器资源协议兼容：按地址前缀把 file / plan 等转发给官方 provider |
| `client.forensics.js` | 只读证据记录：资源订阅、console、预览失败 |
| `client.settings.js` | 「任务通知」设置页（按需加载） |
| `client.diagnostics.js` | 只读诊断页（按需加载） |
| `lib/notify/config.js` | 默认值、归一化、patch 与 settings 的合并 |
| `lib/notify/dispatcher.js` | 事件判定、去抖/节流、投递、宿主端自动回答 |
| `lib/notify/channels.js` | 各渠道适配器：只发请求，不抛异常 |
| `lib/notify/compose.js` | 通知内容渲染（宿主与浏览器共用） |
| `lib/notify/feed.js` | 内存事件环，浏览器追赶用 |
| `lib/notify/routes.js` | 公开与需鉴权的 HTTP 接口 |
| `lib/notify/store.js` | `settings.json` / `feed.key` / `notify.log` 的读写与轮转 |
| `lib/notify/host-settings.js` | 宿主端自动回答四字段与 `browserSettings` 的校验、合并写入 |
| `test/client-harness.mjs` | 离线客户端 harness：假 DOM/React/loader，跑真实入口与 chunk |
| `test/*.test.mjs` | `node --test` 单元/集成测试 |

---

## 2. DSH 插件契约细节

### 宿主半

- `index.js` 导出 `inject = ['webServer', 'sessions']` 和 `apply(ctx, rawConfig)`；没有单独的 `name` 导出，插件 id 由 `package.json` 的 `name` 决定。
- Service Worker 通过 `ctx.webServer.register({ kind: 'exact', path: '/plugins/dsh-mobile/sw.js', handler })` 提供，响应头必须保留 `service-worker-allowed: /`；不要改变路径或作用域。
- 公开路由走 `ctx.webServer.register`：`GET/HEAD /plugins/dsh-mobile/meta`、`GET/HEAD /plugins/dsh-mobile/feed?key=…`、`POST /plugins/dsh-mobile/test?key=…`。feed 和 test 必须做 key 校验（常量时间比较）。
- 需鉴权路由走 `connection.fetch.register`：`GET /api/dsh-mobile/feed`、`GET /api/dsh-mobile/notice`、`GET/POST /api/dsh-mobile/host-settings`。`connection` 服务可能在插件 apply 之后才出现，必须用 `ctx.inject(['connection'], cb)` 等待，并在 `connectionCtx.effect` 里注册。
- 通知配置在 `apply` 时合并一次，之后由 `watchSettings` 热重载：`mergeNotifyConfig(rawConfig, settingsNotify)`，`settings.json` 逐字段覆盖 patch 默认值。
- 日志统一用 `ctx.logger`，前缀 `[dsh-mobile]`；`feed.key` 只能打印尾 4 位（`key=****abcd`），任何渠道 token/webhook 不得进入日志。

### 浏览器半与 chunk 契约

- `client.js` 返回 `{ inject: [...], apply(ctx) }`；入口只注册 factory，所有 DOM/副作用都发生在 `apply` 及其异步 `boot()` 内。
- 入口的 `CHUNK` 表是 chunk 路径的唯一来源；新增 chunk 时同时更新 `CHUNK`、文件本身的 `chunk:` 字段和加载顺序。
- chunk 加载失败必须被 `loadChunk` 吞掉并记录到 `chunkStatus`，只让对应功能失效；不要让 `boot()` 抛到全局，否则会拖垮其它 chunk。诊断页读取 `chunkStatus` 展示失败原因。
- chunk 只能 `require('react')`（基座共享模块）；不要 `import` Node 内置模块，不要写顶层 DOM 操作，不要用相对路径同步 import 其它 chunk。
- 启动顺序是有意义的：先关键 CSS → styles → resource-compat → forensics → sidebar/back/notify/deeplink，再注册 header 菜单、设置页和 overlay。改动顺序前先确认依赖关系。
- 关键 CSS 必须在第一个 `await` 之前同步注入，避免手机冷启动先闪一帧桌面布局；侧栏 chunk 失败或安装完成时必须 `settleCritical()` 移除它，不能留下“侧栏被隐藏且没有菜单按钮”的状态。
- 除 `client.back.js` 的全局返回按钮外，只通过官方 slot 注册 UI：`conversation.header.leading`（id `dsh-mobile-menu`）、`settings.section`（id `dsh-mobile-notify`，order 91）、`shell.overlay`（id `dsh-mobile-notify`，order 90）。**不要往 header DOM 里注入节点**，slot 不存在时只损失这个入口。全局返回按钮是唯一的 body 级例外：设置弹窗 portal 在 shell overlay 之上，只有 body 级节点能覆盖所有页面；它只增删自己的一个按钮，不改 DSH 的 React 树或别人的 DOM。
- 侧栏状态以官方 `data-sidebar-collapsed` 属性和 `ctx.layout.toggleSidebar` 为准，不维护自己的展开状态；所有 `data-dshm-*` 标记由 `client.sidebar.js` 写，样式只读。
- 压缩后的 CSS Module 类名只允许出现在 `client.sidebar.js` 的 `SEL` 表里；前端升级换哈希时只改这一处。
- 文案通过 `ctx.locale.register('dsh-mobile', 'en'|'zh', MESSAGES)` 注册，两种语言必须同时补齐；`locale/*.json` 只有 `meta.title/description`，只改它不会改变设置页文案。
- 颜色优先用 `--dsw-alias-*` 活 token；不要在 `:root` 里声明别名再引用。

### 配置、数据与接口

| 项 | 位置 / 规则 |
|---|---|
| 默认配置 | `cordis.patch.yml` 的 `notify` 块；可提交，不含秘密 |
| 用户配置 / 秘密 | `$DSH_HOME/dsh-mobile/settings.json`，0600，热重载；后加载的字段覆盖 patch |
| feed 读取 key | `$DSH_HOME/dsh-mobile/feed.key`，0600，首次生成后不自动轮换 |
| 投递日志 | `$DSH_HOME/dsh-mobile/notify.log`，0600，1 MiB 轮转 |
| 事件 | `done` / `error` / `ask`；`auto` 是内部“已自动处理”通知 |
| 渠道 | `wecom` / `dingtalk` / `feishu` / `telegram` / `ntfy` / `serverchan` / `webhook` |
| 宿主自动回答 | 默认关闭；四字段：`askAutoAnswer`、`askTimeoutMs`、`approvalAutoAction`、`questionAutoPick` |

设置写入规则：`POST /api/dsh-mobile/host-settings` 只合并上述四个字段和 `browserSettings`，其余键（渠道、秘密、`baseUrl` 等）必须原样保留；读到损坏的 `settings.json` 返回 409 并保持文件不动，不要覆盖重写。

### 生效方式

- 改 `client.js` / `client.*.js`：刷新页面；客户端 revision 由 mtime/ctime + size 推导。
- 改宿主半（`index.js`、`lib/**`）：必须重启 dsh web 才会加载新代码。
- **当前 agent 就跑在 dsh web 进程里，任何真实重启都会终止当前会话。** 不要为了验证宿主半去重启服务；用离线测试覆盖，需要真机生效时在汇报里说明“需用户重启后生效”。
- 不要为了让改动生效去手改 profile 的 `cordis.yml` 或 bundle 列表；本机是 `link:` 安装。

---

## 3. 行为不变量（改动红线）

这些是用户能感知的行为边界，改动时不得悄悄破坏：

1. **独立失败**：布局、全局返回、通知、深链、兼容层、诊断、设置页任一 chunk 失败，只关掉自己的功能；入口继续运行，诊断页能看到失败原因。全局返回按钮失败时，其它页面入口仍按原逻辑工作。
2. **首屏不闪桌面布局**：关键 CSS 同步注入；真实皮肤接管或侧栏 chunk 失败后必须移除，不能把用户困在“没有侧栏也没有按钮”的界面。
3. **通知只来自根会话的真实事件**：只对根会话的完成/失败 turn，或正在等待用户处理的审批/提问发通知；子会话、中止的 turn、被阻塞的前置步骤、崩溃孤儿 turn、以及已有后续 turn 的旧 turn 都不通知。不要扩大触发面。
4. **一个事件只提醒一次**：浏览器前景页的 running→idle watcher 与宿主 feed 追赶不能重复弹同一条；`ask` 不能穿上一轮完成通知的文案。
5. **宿主是设置的唯一事实来源**：浏览器本地缓存只用于宿主未响应时的过渡；`syncHostSettings()` 落地后以宿主为准，迁移失败要保留本地记录而不是写坏。
6. **自动回答默认关闭**：`askAutoAnswer` 打开后是“替用户做决定”，不能在默认值、示例、测试或文档里悄悄打开；审批默认动作保持 `allowed-once`，超时范围保持 15s–24h。
7. **设置写入是合并，不是重写**：只改四个宿主字段和 `browserSettings`，绝不因为一次保存丢掉渠道秘密或 `baseUrl`；损坏文件拒绝写入。
8. **公开与鉴权接口分开**：`/plugins/...` 只放 meta、key-gated feed、key-gated test；`/api/...` 必须走 DSH 的浏览器信任栅栏。不要把需要登录的数据搬到公开路由。
9. **不泄露秘密与隐私**：通知内容来自会话（标题、工作区、结果），只能发到用户显式启用的渠道；日志、错误、诊断报告不得包含 token、webhook、sendKey、完整 feed key。
10. **Service Worker 保持最小**：只做 install/activate/notificationclick 和转交会话 id；不要扩大作用域、不要缓存页面、不要引入远程脚本。
11. **中英文案同步**：新增文案键必须同时写 `en` 和 `zh`；不要只改一种语言或只改 `locale/*.json`。
12. **功能开关有交代**：`NOTIFICATIONS_ENABLED` 是浏览器通知的总开关；改动它等于改变产品行为，必须说明理由，不能为了绕过失败测试而关掉。

---

## 4. 修改流程（每一轮照做）

1. **看现场**：`git status --short`、`git log --oneline -5`。仓库里可能有其它插件或 worktree 的未提交改动；它们不属于本轮，不要 stage、不要 stash、不要 reset、不要 checkout 覆盖。
2. **读事实**：先读相关入口/chunk/测试；行为以代码和测试为准。`lib/notify` 的配置合并、去抖/节流、路由签名尤其要先确认。
3. **选对层**：样式只进 `client.styles.js`；DOM 契约只进 `client.sidebar.js`；全局返回逻辑只进 `client.back.js`；浏览器通知逻辑进 `client.notify.js`；宿主事件判定进 `lib/notify/dispatcher.js`；渠道适配进 `lib/notify/channels.js`。不要把宿主逻辑塞进浏览器半。
4. **补测试**：宿主逻辑改动用 `test/*.test.mjs` 覆盖路由、合并、调度、自动回答；客户端行为改动优先加进 `test/client-notify.test.mjs` 或 `client-harness.mjs` 能覆盖的路径。断言具体状态/文案/调用次数，不只断言“没抛异常”。
5. **更新文档**：用户可见行为变化同步改根 `README.md` 的插件表/说明、`package.json` 的 `description` 和版本（`dsh-mobile` 没有独立 README）；纯文档修改不升版本。
6. **运行验证**：`npm run verify`，确认 `HARNESS OK`、46+ 通过、0 失败、0 取消。
7. **检查契约**：三处 id、chunk 的 `id/chunk`、`files` 白名单、无新增依赖、无未清理的 effect。可用：

   ```bash
   node -p "require('./package.json').name"
   grep -n "id: dsh-mobile" cordis.patch.yml
   grep -n "id: 'dsh-mobile'" client.js client.*.js
   npm pack --dry-run --json >/dev/null   # 可选：确认发布白名单
   ```
8. **提交**：只 `git add dsh-mobile/...`，检查 `git diff --cached --name-only`，按约定写提交信息，本地 commit。
9. **汇报**：给出提交 hash、验证命令和结果；未验证的部分（例如真机通知、真实重启）明确写“未验证”。

新增 chunk 时，除了 `CHUNK` 表和 `load()` 的 `chunk:` 字段，还要确认 harness 能通过 `require.async` 找到它；如果 chunk 在启动路径上，更新 `test/client-harness.mjs` 的期望，避免“只在真机上炸”。

---

## 5. 测试规范

```bash
npm run check   # timeout 60 node test/client-harness.mjs
npm test        # timeout 300 node --test --test-timeout=300000 test/*.test.mjs
npm run verify  # check + test
```

- `npm run check` 不是语法检查，而是离线客户端集成 harness：它复刻 module loader、React、DOM 和官方 layout 服务，然后运行真实 `client.js` 与 chunk。它失败通常意味着 chunk 路径、导出、DOM 契约或状态机漂移。
- `npm test` 是 `node --test`，当前 46 项。**0 cancelled 是硬要求**：调度器的计时器刻意 `unref()`（避免 24h 自动回答拖住宿主），测试必须用带引用的超时守卫等待这类 promise，不能靠事件循环“碰巧还活着”。
- 测试必须离线：不连真实 webhook、不发真实通知、不读真实 `settings.json`、不依赖真实浏览器。用 fake `fetch`、临时目录、假 DOM、假 ctx。
- 客户端测试在 import chunk 之前安装 DOM/storage stub；chunk 是浏览器脚本，不能直接当模块 import。
- 渠道测试只验证请求形状和成功/失败解析；不要在测试里放真实 token 或 URL。
- 不为通过而放宽断言、删除用例、缩短超时掩盖竞态。实现错了改实现。
- 浏览器通知/UI 的视觉效果没有自动化测试；手动验证前先征得同意，避免给真实渠道发测试消息。改动 UI 至少刷新页面看一次，并在汇报里写“仅人工验证”。

---

## 6. Git 与发布

- 仓库根是 `/opt/dsh-plugins`，`dsh-mobile/` 没有自己的 `.git`；所有提交都落在根仓库。
- 分支通常是 `main`，远端是 `origin`。**默认不 push。**
- 只提交 `dsh-mobile/` 下的源码、测试、文档、`package.json`、`cordis.patch.yml`、`locale`、`icon`。不提交：
  - `$DSH_HOME/dsh-mobile/` 下的 `settings.json`、`feed.key`、`notify.log`；
  - `node_modules/`、`*.log`、临时文件、截图；
  - 仓库根的发布压缩包（例如 `dsh-restart-*.zip`），除非用户明确要求；
  - 其它插件或 worktree 的改动。
- 提交前用 `git diff --cached --name-only` 复核；提交后用 `git status --short` 确认本插件没有遗漏，也没有误带其它文件。
- 不执行 `git checkout -- .`、`git reset --hard`、`git clean -fd` 这类会波及其它改动的命令。
- 用户可见行为变化时按语义化版本升 `package.json` 的 `version`，同步更新根 `README.md` 的插件表（版本 + 描述）；纯文档修改不升版本。
- `files` 白名单决定发布内容；`AGENTS.md`、`test/` 不在其中，不要为了“带上文档”把它们加进去，除非用户明确要求。

---

## 7. 安全与隐私

- 不读取、不打印、不提交任何 token、webhook、sendKey、cookie、证书或用户隐私数据。
- 渠道秘密只在 `$DSH_HOME/dsh-mobile/settings.json`（0600）；`settings.json`、`feed.key`、`notify.log` 都以 0600 写入，不要放宽权限。
- 通知内容包含会话标题、工作区、结果片段；只在用户显式启用并配置的渠道发送，不要在日志/诊断里整段倾倒。
- `feed.key` 是长期有效的读取凭据：日志只留尾 4 位；不要在 URL 示例、测试快照或提交信息里写完整 key。
- 自动回答是高风险功能：默认关闭，打开后会在用户不在场时放行/回答问题；不要把它设为默认，不要在没有明确同意时用真实会话测试。
- 不要绕过 DSH 的浏览器信任栅栏、cookie 校验或 Service Worker 作用域限制；不要为了“方便调试”新增公开的无鉴权接口。
- 测试消息会真的发到群里：`/plugins/dsh-mobile/test` 或手动“发一条测试”只能对用户确认过的测试渠道使用。

---

## 8. 已知限制（不要假装已解决）

- 浏览器半的视觉、手势和真机通知主要靠人工验证；没有自动化 UI/设备矩阵测试。
- 浏览器通知需要 HTTPS 安全上下文；HTTP 下只能提示用户切换，不能伪造通知能力。
- 宿主半改动需要重启 dsh web 才生效；当前会话内不能重启验证，只能靠离线测试 + 用户重启后反馈。
- 华为浏览器的资源协议兼容层（按地址前缀转发到官方 provider）是针对空 host 解析的 workaround；没有该环境时只能保证不干扰正常浏览器。
- 不同 Android WebView 对 Service Worker / 通知的支持有差异；诊断页能收集证据，但不能替代真机验证。
- 发布包以 `files` 白名单为准；`test/`、`AGENTS.md` 不进入包内。
- 根 README 与代码如有出入，以代码和测试为准；发现文档漂移时在本轮顺手修正。

---

## 9. 完成检查清单

提交前逐项确认：

- [ ] `npm run verify` 退出码 0；`HARNESS OK`；`# fail 0`、`# cancelled 0`；
- [ ] 行为变化有新增/更新的测试用例，断言具体行为而不只是“没抛异常”；
- [ ] 宿主/浏览器两半没有互相越界；新增 chunk 已进 `CHUNK` 表且能独立失败；
- [ ] 三处 id + 每个 chunk 的 `id/chunk` 一致；`files` 白名单没有漏项；
- [ ] 没有新增依赖、构建步骤或未清理的 `ctx.effect`；
- [ ] 没有削弱独立失败、首屏关键 CSS 清理、通知语义、设置合并、鉴权与秘密边界；
- [ ] 中英文案同步；用户可见变化已更新根 README，必要时升版本；
- [ ] 暂存区只有 `dsh-mobile/` 下的预期文件，没有数据、日志、密钥或其它插件改动；
- [ ] 已在本地 git 提交，未 push；提交信息包含验证结果；
- [ ] 汇报中写明提交 hash、实际验证命令和结果，以及未验证的部分。
