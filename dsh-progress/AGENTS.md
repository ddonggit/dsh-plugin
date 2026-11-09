# dsh-progress 开发指引（AGENTS.md）

本文件约束在 `dsh-progress/` 目录内工作的代码智能体。开始改动前先读本文件；它与用户当前指令冲突时，以用户指令为准，并先说明冲突点。

`dsh-progress` 是 DSH（DeepSeek Harness）Web 的 bundle 插件，做三件事：**让模型主动汇报进展**、**在方向跑偏时提醒/拉回**、**在工具用法明显绕远时给一条提示**；0.3.0 起还合并了原来的 `dsh-running-sessions`，在侧栏/标题栏汇总跨工作区的运行中、等待确认、刚完成会话。连续 N 次工具调用没汇报就软提醒，超过硬上限就拦下一次工具调用；方向类只提醒/`agent.steer`，绝不 `deny`；全程不调用任何 LLM。

当前版本 0.3.0，`node --test` 55 条用例。

### 0. 按 DSH 插件规范工作

1. **三处 id 完全一致**：`package.json` 的 `name`、`cordis.patch.yml` 的 `insert.id`、`lib/client.js` 里 `__ModuleLoader__.load({ id })`，都必须是 `dsh-progress`。不一致会白屏或拒绝加载。
2. **两半各司其职**：宿主半 `lib/index.js`（`main` / `exports["."]`）只做工具注册、计数、提醒、拦截、方向判断；浏览器半 `lib/client.js`（`exports["./client"]`）只做展示。不要把渲染塞进宿主半，也不要在浏览器半做拦截。
3. **保持 bundle 形态**：`dsh.bundle.patch` → `cordis.patch.yml`；`dsh.client.platform` = `web`；`files` 白名单覆盖 `lib/**`、`locale/*.json`、`icon.svg`、`cordis.patch.yml`、`README.md`。
4. **无构建、零运行时依赖**：源码即产物；只用 Node 标准库和基座已提供的 `react`。新增依赖前先证明做不到，并征得用户同意。
5. **生命周期可清理**：浏览器半的样式注入用 `ctx.effect(() => { ...; return dispose })` 清理。宿主半的监听都是 `ctx.on`，随插件卸载自动释放。
6. **配置 fail loud**：非法配置直接抛错，宁可装不上也不要静默跑错。配置里不放秘密（本插件没有秘密）。
7. **版本兼容**：`engines.node >= 20`、`engines.dsh >= 0.2.1-rc.2`。用到的 `session/disposed`、`SessionSnapshot.sessionId`、`agent.steer`、`agent/turn-stopping` 等契约都在该基线上。

---

## 1. 运行模型

- 宿主半在 dsh web 进程里 `apply(ctx, input)`：`input` 是 patch 里的 `config`。校验后注册工具；`enforce: true` 时再挂 `tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping`（仅在 `direction: true` 时）和两个状态清理监听。
- 浏览器半注册一个 factory，`inject: ['slots', 'sessions', 'uiSession', 'workspaces', 'uiWorkspace']`，在 `apply(ctx)` 里按入口开关注册五个槽位：进展卡片、输入框 dock、侧栏 `panellist`、整页 `main`、标题栏 utilities；并注入一段 CSS。**不要注册 `settings.section`**——入口开关在插件自己的「入口显示」折叠区里。
- 卡片、状态条和会话列表共享模块级 `latest: Map<sessionId, entry>`：卡片在流式渲染时把最新一条汇报 `publish` 进去，状态条与会话列表经 `useSyncExternalStore` 读出来。**这是纯 UI 状态，不发送给模型**，不影响提示缓存。
- 方向消息走 `user/message` 的 `source.kind`（`方向核对` / `方向纠偏` / `工具提示`），不新增工具、不改 `report_progress` 的 schema、不注册 systemPrompt。

目录职责：

| 路径 | 职责 |
|---|---|
| `lib/index.js` | 宿主半：配置、工具注册、计数、软提醒、硬拦截、方向/教练接线、状态清理 |
| `lib/text.js` | 纯函数：`truncate`、`createMessageId`、`previewValue` |
| `lib/anchor.js` | 锚点：最新真实用户消息、goal、todos、路径、意图、清晰/模糊模式 |
| `lib/signals.js` | 纯规则：写工具/验证命令/路径范围/bash 包装、收工原因 |
| `lib/messages.js` | 三类上下文行与对齐/核对/纠偏/工具提示文案 |
| `lib/client.js` | 浏览器半：进展卡片、状态条、计数片、整页会话列表、入口开关、样式、`latest` 存储 |
| `test/host.test.mjs` | 宿主半：假 `ctx`/假 exec，覆盖原有计数、提醒、拦截、清理 |
| `test/direction.test.mjs` | 方向/教练：纯规则 + 假 `ctx.get`/`deriveMessages`/`steer` 的行为 |
| `test/client.test.mjs` | 浏览器半：vm + 假 React + 假 ctx + 假 localStorage，覆盖五个槽位、渲染、入口开关与 CSS 回归断言 |
| `cordis.patch.yml` | bundle 插入点与默认配置 |
| `locale/en.json`、`locale/zh.json` | 只有 `meta.title`/`meta.description` |

---

## 2. 宿主半契约

### 配置

`DEFAULTS`：`enabled: true`、`enforce: true`、`softLimit: 7`、`hardLimit: 10`、`failuresBeforeBlock: 3`、`subagents: false`、`exempt: ['ask_user_question']`、`direction: true`、`coach: true`、`maxCorrections: 2`、`noWriteLimit: 8`。未知键、类型错、`hardLimit <= softLimit`、`softLimit < 1`、`hardLimit < 2`、`maxCorrections < 0`、`noWriteLimit < 3` 全部抛错。

`enforce: false` 只注册工具，不挂任何提醒/纠偏/拦截监听；`enabled: false` 直接不注册。

### 状态

每会话一份状态，放在 `states: Map<sessionId, state>`。字段分三组：

- **进展计数**：`sinceReport`、`failuresSinceReport`、`nudged`。`report_progress` 成功 → 前三个清零；`tools/post-execute` 正常完成一次被跟踪的调用 → `sinceReport += 1`，`isError` 时 `failuresSinceReport += 1`。
- **方向锚点/预算**：`anchor`、`alignmentShown`、`notices`、`corrections`、`turnStopSteered`。`notice` 只在工具提示里计数（每回合最多 3 条）；`corrections` 统计所有 steer（每回合最多 `maxCorrections`）。
- **活动事实**：`lastReport`、`toolCalls`、`callsSinceWrite`、`hasWritten`、`lastWriteSeq`、`lastVerificationSeq`、`doneUnverified`、`noWriteNotified`、`noWriteReports`、`noWriteCorrected`、`scopeEscapes`、`scopeNotified`、`scopeCorrected`。

生命周期：

- `turn/start`、`turn/end` → 删除该会话状态（新回合重新给预算；崩掉的回合靠下一次 `turn/start` 兜底）。
- `session/disposed` → 删除该会话状态，别留死会话残渣。
- `ensureAnchor()` 在真实用户消息变化时重置方向预算（`alignmentShown`、`notices`、`corrections`、`turnStopSteered`、no-write/scope 标志）；模型自己改 todo 不重置。

### 两个门禁的调用顺序（改动必须保持）

`tools/pre-execute`：

1. `await next()` 拿下游决策；`deny` 或 `cancel` 直接尊重下游返回。
2. `tracked()` 过滤：无 agent、PTC 内层（`exec.parent !== undefined`）、本工具、`exempt` 命中、`!subagents && isSubagent` 都不计时。
3. 预算检查：`sinceReport >= hardLimit` 或 `failuresSinceReport >= failuresBeforeBlock` 才继续。
4. `reportingVisible()`：`exec.toolSet?.view?.(agent)` 里没有 `report_progress` 就**绝不拦**（否则模型无法汇报，形成死锁）。
5. 记入 `deniedCallIds` 并返回 `{ kind: 'deny', reason }`。

`tools/post-execute`（顺序很重要）：

1. `await next()`；无会话 id 直接返回。
2. 如果 `exec.name === 'report_progress'` → `handleReportPost()`，**在 `tracked()` 之前处理**（`tracked()` 会排除本工具）。
3. 否则 `tracked()` 过滤；`deniedCallIds.delete(callId)` 为真 → 直接返回（**被自己拦下的调用也会经过 post-execute，不跳过就会把一次拦截记成一次失败**）。
4. `toolCalls/sinceReport/callsSinceWrite += 1`；`isError` 时 `failuresSinceReport += 1`。
5. `ensureAnchor()`；模糊模式且无计划、未对齐过、且不是纯状态消息 → 追加一次 `方向核对`。
6. 写工具成功 → 更新 `hasWritten/lastWriteSeq/callsSinceWrite/doneUnverified`，做范围检查；验证命令成功 → 更新 `lastVerificationSeq/doneUnverified`。
7. `bashWrapperTip()` 命中 → 追加 `工具提示`（受 `coach` 和每回合 3 条限制）。
8. 进度提醒保持原样：`nudged` 为真或未到 `softLimit` 就直接返回；到点置 `nudged = true`，返回 `{ ...downstream, additionalContexts: [...] }`。只追加，不替换 `content`/`value`。

### 方向规则（0.2.1）

`buildAnchor(ctx, agent, state)` 只取：

- 最新真实用户消息：`deriveMessages()` 里从后往前，`role === 'user'` 且 `source.kind === 'user'`；内部 notice 不算。
- active goal：`ctx.get('goals')?.get(agent)` 且 `phase === 'active'`。
- todos：`ctx.get('sessionProjections')?.snapshot(agent.session, ['todos'])` 的 `values.todos`。
- 路径：从用户请求 + goal 里提取，要求扩展名 2–8 位，跳过版本号和 URL。
- 意图：`change` / `research` / `unknown`。
- 模式：有路径/命令/报错 → `clear`；否则 `vague`。
- 纯状态：`isStatusOnly(request)` 为真时，本轮跳过方向核对/纠偏和工具提示；动作请求、负面状态、问句不算纯状态。

`clear` 模式：

- 意图 `change` 且 `callsSinceWrite >= noWriteLimit`：第一次 `report_progress` 追加 `方向核对`，第二次仍只读 → `agent.steer` 一次 `方向纠偏`。
- 用户点名路径且写入越界：第一次写就追加 `方向核对`，第二次越界 → steer。
- 报 `done` 且 `lastWriteSeq > lastVerificationSeq`：追加 `工具提示`；收工时仍未验证 → steer `方向纠偏`。汇报里写了“手动/没法自动验证/需要你看”就视为已说明，不再提示/拉回。
- 收工时 goal active，或 `intent === 'change' && hasWritten` 且最后汇报不是 done/blocked → steer `方向纠偏`。
- 用户点名路径时，同目录同主名（`auth.ts` ↔ `auth.test.ts`）算在范围内。

`vague` 模式：

- 第一次工具调用时，若没有 goal/todo、也还没对齐过，且不是纯状态消息 → 追加一次 `方向核对`，请模型先写“要什么、第一步、怎么算完成”。
- 不检查只读不写、不检查越界（探索正常）。
- 报 `done` 未验证 → 仍给 `工具提示`；但收工不因此硬拉。
- 收工时模型自己写过计划（goal/pending todo/report next）却没报 done/blocked → steer `方向纠偏` 一次；没有计划且工具调用 `>= 3` → steer 一次轻量 `方向核对`。
- `turnStopReason()` 返回 `null` 表示不打扰；最后一条助手文本是问句（`?/？` 结尾或含“请确认/需要你/要我”等）时也不打扰。

收工监听 `agent/turn-stopping`：

- 仅在 `direction: true` 且 `enforce: true` 时注册。
- 跳过 `signal.aborted`、子 agent（`subagents: false`）、plan mode。
- 每回合最多一次收工 steer（`turnStopSteered`）；总 steer 仍受 `maxCorrections` 限制。
- 已经报 `done` 且 `doneUnverified === false`、或报 `blocked`，不再拉回。

### 提醒消息

- `PROGRESS_KIND = '进度提醒'`，`DIRECTION_CHECK_KIND = '方向核对'`，`DIRECTION_CORRECTION_KIND = '方向纠偏'`，`TOOL_TIP_KIND = '工具提示'`。
- 这些就是 `user/message` 的 `source.kind`；客户端把 `kind` 原样当上下文行标签显示，所以**必须是给人看的中文**。
- `source` 形状：`{ kind, form: 'notice', summary }`；`form: 'notice'` 时 `summary` 必填，显示在标签后。
- 方向纠偏/核对正文必须包含：用户目标、观察到什么、为什么可疑、建议下一步、逃生口（“如果是必要的关联，用一句话说明；如果已回到目标，忽略”），并声明“这是自动提醒，不是用户的新指令”。

### 已知取舍

- 规则只认硬事实，不做语义理解；可能误判或漏判。方向类只提醒，不拦工具，误判成本可控。
- 不调用 LLM：没有“AI 旁观者”，也不花额外 token。
- 同一操作原样重复失败交给基座 `dsh-repeat-tool-reminder`（它默认在 web profile 启用，阈值 3/5/8），本插件不重复。
- 未汇报次数按回合计；跨回合不累计。
- `deniedCallIds` 超过 512 条时整表清空（防止长会话无界增长）。极端并发批次下可能漏记一次“这是被拦的那次”，把拦截计成失败；已知、暂不修。
- 被 steer 的纠正消息会让模型多跑一步；这是“拉回”的代价，已用 `maxCorrections`、每回合一次收工 steer 限流。

---

## 3. 浏览器半契约

### 五个槽位

| 槽位 | 注册参数 | 说明 |
|---|---|---|
| `tool.call.toolview` | `{ key: 'report_progress' }` | 对话里 `report_progress` 的专用卡片，keyed 槽位只认 `key` |
| `conversation.input.dock` | `{ id: 'progress', order: 5, inject: (sessionId) => ({ sessionId }) }` | 输入框上方状态条；运行中显示本会话进展，空闲时显示其他会话活动 |
| `sidebar.panellist` | `{ id: 'running-sessions', order: -5, label: () => '进行中' }` | 侧栏导航入口 |
| `main` | `{ key: 'running-sessions' }` | 侧栏点开的整页会话列表 |
| `conversation.session.header.utilities` | `{ id: 'running-sessions', order: 10 }` | 标题栏计数片 + 弹层 |

槽位的标准 props 都含 `sessionId`、`useSession` 等，所以 `props.sessionId` 与 `props.useSession` 都是合法来源。`sidebar.panellist` 只传 `{ size, active }`，拿不到数据，图标只画形状。

### 入口开关（不注册设置页）

- 模块级 `entries: { nav: boolean, chip: boolean }`，初值读 `dsh-progress.entry.nav` / `.chip`，读不到回退 `dsh-running-sessions.entry.*`，写入只写新键。
- `normalizeEntries()` 保证至少一个为真：两个都关时强开 `chip`；只剩一个时该开关 `disabled`（`title` 说明“至少保留一个入口”），避免把设置入口也关掉。
- `mountEntry(slotKey, options, View, toggleKey)` 在 `setEntry` 后按最新快照注册/注销；`sidebar.panellist` 与 `main` 由同一个 `nav` 开关控制。
- `EntrySettings` 是插件自己的 UI（`<details><summary>入口显示</summary>`），不是在 `settings.section` 里；设置面板里不应出现本插件。

### hook 必须无条件调用

`useSession` 是标准 props，但**不能 `if (typeof useSession === 'function') useSession(...)`**。用 `pickSession(useSession)` 选实现、`selectSessionId` / `selectRunning` 取值的写法保证每次渲染都调用同一个 hook。快照字段是 `sessionId`（**没有 `id`**）和 `running`。

### 卡片

- 参数来源：result 相位读 `block.call.argsRaw`，start/preparing 相位读 `block.argsRaw`；解析失败当作没有参数。
- 失败判定**只看** `block.isError === true`。`block.call === null` 只表示这次调用的记录滑出了已加载窗口，不是汇报失败。
- 流式阶段（`!done`）显示很轻的「正在汇报…」占位。

### 状态条

- 运行中且最近一条汇报不是 `done` 时显示本会话进展；空闲时若别处有 `run`/`wait` 会话，显示「其他会话 N 个运行中 · M 个等你确认」；会话 id 未知（既无 `sessionId` prop 也无快照）时不显示，避免把本会话算成“其他”。
- **宽度必须自己算**：dock 的父容器是整列 flex 拉伸（没有 width），输入框卡片靠 `calc(100% - 2*side-clearance - 4*dock-inset)` + `max-width` + `margin:0 auto` 自居中。状态条不这样写就会横贯整屏。现有规则：

  ```css
  width: calc(100% - 2 * var(--dsh-composer-side-clearance, 16px) - 4 * var(--dsh-composer-dock-inset, 8px));
  max-width: calc(var(--dsh-composer-card-max-width, 100%) - 4 * var(--dsh-composer-dock-inset, 8px));
  margin: 0 auto 6px;
  ```

  验收标准：任意视口下状态条与输入框卡片**同宽同居中**（1621px 下实测都是 768px，390px 下都是 326px）。
- 长文本：摘要 `flex:1 1 auto;min-width:0` 截断；「下一步」`flex:none;max-width:38%` 截断并带 `title` 悬停看全文。不要再把 next 改成可收缩，那会把摘要挤没。
- 颜色只用 `--dsw-alias-*` 活 token。

### 会话列表

- 数据来自 `ctx.sessions.list`、`ctx.uiSession.sessionStatus`、`ctx.workspaces.list`；点击行走 `ctx.uiWorkspace.openSession`。
- 过滤：`blank`、`origin === 'subagent'`、`workspaces.list.archivedSessionIds` 不出现；`pendingInteraction != null` 归 `wait`，否则运行中归 `run`，窗口内刚结束归 `done`；同一会话只出现一次，`wait` 优先。
- 排序固定 `wait → run → done`；行副标题优先显示 `latest` 里该会话的最新进展（`done` 只认 `done` 汇报，运行中不认上一轮 `done`），没有时退回「工作区 · 等待确认/正在执行/已完成」。
- `latest` 与 `progressVersion` 是模块级 UI 记忆，不写盘、不发给模型；卡片 `publish`，列表 `useSyncExternalStore(subscribeProgress, getProgressVersion, getProgressVersion)` 重渲染。
- 窗口 `dsh-progress.window` 默认 30 分钟，可选 15/30/60/120；用 `useFeed` 的 `now` 每 30 秒重算一次。

---

## 4. 生效方式

- 改 `lib/client.js`：刷新页面即可。客户端 revision 由 mtime/ctime + size 推导，不需要改配置。
- 改 `lib/index.js` 或 `lib/*.js` 宿主模块：**必须重启 dsh web**（ESM 缓存按进程）。
- 本机是 `link:` 安装，web profile 已包含 `dsh-progress`，**不再包含** `dsh-running-sessions`；不要为了让改动生效去手改 profile 的 `cordis.yml` 或 bundle 列表。
- 校验加载：`/opt/dsh-0.2.2/bin/dsh --profile web --dump-config | grep -A4 dsh-progress`，以及 `systemctl status dsh-web` 的启动时间晚于文件 mtime。

---

## 5. 测试

```bash
npm test          # node --test，当前 55 条
node --check lib/index.js lib/text.js lib/anchor.js lib/signals.js lib/messages.js lib/client.js
```

- 测试必须离线：假 `ctx`、假 React、vm 跑真实 `client.js`，不连真实 DSH。
- 宿主测试覆盖：软提醒恰好一次、硬拦一次、被拦调用不计失败、ask 也要过预算、`exempt`/子会话/PTC 不计数、会话销毁清理、`enforce: false` 不拦。
- 方向测试覆盖：清晰/模糊分类、路径提取与范围、bash 包装、收工原因；纯状态/确认消息识别与“不提醒”行为；模糊对齐、只读不写、越界、完成未验证、goal 未收口、自己计划、无计划轻核对、问句跳过；子 agent/PTC/plan mode/`direction: false`；配置报错；不访问 `systemPrompt`/`llm`。
- 客户端测试覆盖：五个槽位（且没有 `settings.section`）、卡片三态、`call: null` 不算失败、无 `sessionId` prop 时靠快照兜底、状态条在运行中/空闲/无其他会话时的分支、计数片与整页列表的过滤/排序/进展副标题、入口开关的锁定逻辑、缺时间戳/未来时间戳/工作区计数回归、`.dpg-strip` 的宽度/居中 CSS 回归。
- 不为通过而放宽断言或删用例；实现错了改实现。
- 视觉改动没有自动化像素测试：用无头浏览器量一下真实宽高（playwright + 抓取插件 CSS 拼页面），并在汇报里写「已测量」或「仅人工验证」。

---

## 6. 修改流程

1. 看现场：`git status --short`、`git log --oneline -5`。
2. 读事实：行为以代码和测试为准；两个门禁的调用顺序、`deniedCallIds` 去重、`reportingVisible` 防死锁、`ensureAnchor` 的预算重置是最容易改坏的地方。
3. 选对层：计数/拦截/文案/方向规则进 `lib/index.js` 或 `lib/*.js`；卡片/状态条/样式进 `lib/client.js`。
4. 补测试：行为变化必须有断言，断言具体状态、文案、调用次数，不只断言「没抛异常」。
5. 更新文档：`README.md` 的「用户看到什么」「模型怎么被管住」「已知边界」和 `## 变更记录`；用户可见变化升 `package.json` 版本，并同步根仓库 `README.md` 的插件表。
6. 跑 `npm test`，确认 55 条全过；再跑 `node --check`。
7. 提交：只 `git add dsh-progress/...`，在父仓库 `/opt/dsh-plugins` 提交；中文 Conventional Commits（如 `feat: 增加双模式方向纠偏`）。默认不 push，用户明确要求时才推送；不 force push、不改写历史。

---

## 7. Git 与发布

- 本插件源码随父仓库 `/opt/dsh-plugins` 管理，分支 `main`，远端 `origin`（GitHub `ddonggit/dsh-plugin`）。原来的独立 `.git` 已迁出并备份，**不要在 `dsh-progress/` 下重新初始化仓库**。
- 只 `git add dsh-progress/...`，用 `git diff --cached --name-only` 复核只出现本目录；默认不 push，用户明确要求时才推送，且只允许快进，不 force push、不改写历史。
- 只提交源码、测试、文档、`package.json`、`cordis.patch.yml`、`locale`、`icon`；不提交 `node_modules/`、`*.log`、截图、临时文件。
- `files` 白名单决定发布内容：`AGENTS.md`、`test/` 不进包。
- 用户可见变化按语义化版本升 `package.json` 的 `version`，同步根仓库 `README.md` 的插件表（那文件在父仓库，提交信息里写清是文档同步）。

---

## 8. 已知限制（不要假装已解决）

- 浏览器半的视觉没有自动化测试，靠无头测量 + 人工确认。
- 宿主半改动要重启 dsh web 才生效；当前会话可能就是那个进程，不要为了验证去重启。
- 方向规则没有语义理解，模糊目标/反讽/多目标时可能误判；已用“模糊模式只对齐、不硬拉”和“只提醒不拦截”降低影响。
- 纯状态识别是保守的关键词/句式规则；拿不准会按正常任务处理，不会为了“安静”而跳过真正的工作。
- `agent.steer` 不保证模型服从；它只是把纠正消息放到下一步。
- 不会自动回滚文件、不会自动创建/修改 goal/todo。
- 「未汇报次数」按回合计，跨回合不累计。
- `deniedCallIds` 的 512 上限是已知取舍（见 2. 已知取舍）。
- 极端情况下客户端既拿不到 `sessionId` prop 也拿不到会话快照时，状态条会退化成「不显示」，不会报错。
- 会话总览是本标签页的只读视图：不后台轮询、不推送通知、不跨浏览器同步；`latest` 刷新即失，入口开关与窗口选择只存在这台浏览器。
- 两个入口至少保留一个；这是有意的限制，不是 bug。
- 根仓库 `README.md` 与代码如有出入，以代码和测试为准，发现漂移顺手修正。
