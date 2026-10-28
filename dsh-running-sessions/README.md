# dsh-running-sessions

跨工作区汇总「进行中」的会话：运行中、等你确认、刚完成，一个入口直达，不用先切工作区。

## 入口

| 入口 | 槽位 | 位置 |
| --- | --- | --- |
| 侧栏「运行中」 | `sidebar.panellist` | 工作区列表上方，波形图标 |
| 整页面板 | `main`（key `running-sessions`） | 点侧栏那一行切过去 |
| 标题栏计数片 | `conversation.session.header.utilities` | 会话标题右侧，`∿ 2 运行中 │ ● 1 待确认` |

计数片在标题行里，不是屏幕角上的悬浮按钮：移动端不会被底部抽屉和输入框压住。

## 开关

两个入口各自一个独立开关，「设置 → 进行中的会话」：

| 开关 | 控制 | localStorage 键 |
| --- | --- | --- |
| 侧栏「运行中」入口 | `sidebar.panellist` 导航行 + 对应的 `main` 整页面板 | `dsh-running-sessions.entry.nav` |
| 标题栏「运行中」计数片 | `conversation.session.header.utilities` 计数片与浮层 | `dsh-running-sessions.entry.chip` |

- 默认都开；互不影响，可同时开或同时关。
- 关 = 真的注销槽位注册（不是渲染 null），侧栏不会留空行。
- 开关只存本浏览器（localStorage），不写配置、不落盘。
- 两个都关后插件界面上不可见，设置页那一项仍在，随时可开回来。

## 行为

- 分组固定顺序：待我处理 → 运行中 → 刚完成；组内按最近活动排。
- 等你确认的会话只计一次「待确认」，不重复计进「运行中」。
- **运行中的会话永不因超时消失**；只有非运行（刚完成）的按 `updatedAt` 淡出，默认 30 分钟，弹层底部可切 15/30/60/120，存 localStorage。
- 点任意一行 `openSession` 直达，不经过工作区。
- 计数片：`∿ N 运行中 │ ● M 待确认`，没有等待时第二段不出现；全空闲变虚线「无进行中」（仍可点开看窗口内刚结束的）。
- 窄屏（<560px）计数片只留 `∿ N`，靠 `aria-label` 说明。
- 过滤 `blank`、归档、`origin: 'subagent'` 的会话。

## 数据来源

全部来自浏览器端已有服务，不新增路由、不落盘：

- `ctx.sessions.list` — 会话清单与 `running` / `updatedAt` / `displayTitle` / `cwd`
- `ctx.uiSession.sessionStatus` — `pendingInteraction`、`completionUnread`
- `ctx.workspaces.list` — 工作区归属与归档集合
- `ctx.uiWorkspace.openSession` — 跳转

## 配置

`cordis.patch.yml` 的 `activeWindowMinutes`（分钟）为默认窗口，客户端可临时覆盖。

## 开发

```bash
node --check lib/client.js
node test/smoke.test.mjs                 # 无浏览器、无真 React
node "$DSH_HOME/skills/dsh-plugin-dev/scripts/check-bundle.mjs" .
```

改 `lib/client.js` 后刷新页面即可（HMR 也会带）；改 `lib/index.js` 需要重启 `dsh-web.service`。
