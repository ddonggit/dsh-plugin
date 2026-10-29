# dsh-restart 开发指引（AGENTS.md）

本文件约束在 `dsh-restart/` 目录内工作的代码智能体。开始改动前先读本文件；它与用户当前指令冲突时，以用户指令为准，并先说明冲突点。

本插件是 DSH（DeepSeek Harness）Web 的 bundle 插件：宿主半负责接口与触发，独立的执行器负责真正重启，浏览器半是设置页里的「服务与重启」。它的核心价值不是“能重启”，而是**在任意部署形态下安全地重启，失败时留下可诊断的现场**。

---

## 0. 两条硬性要求

### 0.1 每一轮修改：验证通过后，必须提交到本地 git 仓库

“一轮”指一个可独立说明的改动（一个修复、一个功能、一次文档更新）。顺序固定，不得颠倒：

1. 修改代码或文档；
2. 在 `dsh-restart/` 下运行完整验证，退出码必须为 0；
3. 只提交本目录的改动，提交信息写清“改了什么、怎么验证的”。

```bash
cd /opt/dsh-plugins/dsh-restart
npm run verify          # 语法检查 + 自测；当前基线 23 项，必须全过

cd /opt/dsh-plugins
git status --short
git add dsh-restart/<本次改动的文件>   # 不要 git add -A / git add .
git diff --cached --name-only          # 只应出现 dsh-restart/ 下的文件
git commit -m "fix(dsh-restart): 一句话说明" -m "- 改动点
- 验证：npm run verify（通过 N 项）"
git log -1 --stat
```

规则：

- **验证失败不提交。** 修到通过为止；修不动就停下来报告，不要先提交再补。
- **不跳过、不弱化、不删除测试来制造通过**；不写 `--no-verify`；不把没跑过的检查写成“已验证”。
- **只提交本地仓库，不 push。** 用户明确要求推送时才推送；永远不要 force push 或改写历史。
- 提交信息用中文，格式 `type(dsh-restart): 摘要`，类型用 `feat` / `fix` / `docs` / `test` / `chore` / `refactor` / `perf`。正文列改动点，并写明验证命令和结果。
- 纯文档修改也算一轮：同样跑一次 `npm run verify` 再提交，保持规则一致。

### 0.2 按 DSH 插件规范工作

最低限度必须满足：

1. **三处 id 完全一致**：`package.json` 的 `name`、`cordis.patch.yml` 的 `insert.id`、`lib/client.js` 里 `__ModuleLoader__.load({ id })` 的值，都必须是 `dsh-restart`。不一致会导致页面白屏且没有明显报错。
2. **两半各司其职**：宿主半入口是 `lib/index.js`（`main` / `exports["."]`），浏览器半是 `lib/client.js`（`exports["./client"]`）。不要在这两个文件之外新增宿主入口或浏览器入口。
3. **保持 bundle 形态**：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh.client.platform` 为 `web`；`files` 白名单必须覆盖 `lib/**`、`locale/*.json`、`icon.svg`、`cordis.patch.yml`、`README.md`。
4. **无构建步骤**：源码即产物。浏览器半由 DSH 客户端模块系统直接提供，不要引入打包器、TypeScript 或生成文件。
5. **零运行时依赖**：只用 Node 标准库和浏览器/DSH 已提供的模块（`react`，可选的 `react-dom`）。新增依赖前先证明标准库做不到，并征得用户同意。
6. **生命周期可清理**：宿主半新增的定时器、监听、订阅用 `ctx.effect(() => { ...; return dispose })` 注册清理；浏览器半新增的样式/DOM 监听同样通过 `ctx.effect` 清理。
7. **配置与秘密分离**：部署差异走 `config` 或环境变量；状态和数据只写 `$DSH_HOME/dsh-restart/data`，绝不写进仓库、workspace 或 profile。日志与接口响应必须脱敏。
8. **版本兼容**：`engines.dsh >= 0.2.1-rc.2`、Node `>= 20`。不要使用低于该基线的 API。

---

## 1. 先弄清运行模型

- `lib/index.js` 运行在 dsh web 宿主进程里。它只做三件事：注册 `/api/dsh-restart/*` 路由、维护状态快照、在确认安全后拉起独立执行器。
- 真正执行重启的是 `lib/restart-runner.mjs`。它被 `systemd-run --scope` 或 `detached` 进程拉起，**宿主进程会在重启时被杀掉，所以执行器不能依赖宿主存活**。它是 `run.json` 活跃阶段的唯一写者。
- 新实例启动、插件 `apply()` 时写 `boot.json`，作为“新进程已经把插件加载起来”的握手标记。执行器靠它判断新实例是否真的就绪。
- 浏览器半只做展示和触发：轮询状态、确认弹窗、阶段进度、失败现场、自动刷新。它不做任何重启判断。

目录职责：

| 路径 | 职责 |
|---|---|
| `lib/index.js` | 宿主半：环境收集、路由、预检、启动执行器、状态快照、冷启动自愈 |
| `lib/restart-runner.mjs` | 独立执行器：systemd / 直接重启、重试、兜底、阶段推进、心跳 |
| `lib/state.mjs` | 宿主与执行器共用的纯逻辑：run 结构、阶段、错误码、原子写 |
| `lib/store.mjs` | 磁盘状态：`run.json` / `boot.json` / `heartbeat.json` / `lock.json` / `history.json` / `runner.log`，以及恢复逻辑 |
| `lib/environment.mjs` | 运行环境探测：cgroup 单元、管理器、模式判定、绑定地址、探测 URL |
| `lib/proc.mjs` | 进程/端口/命令行：只读探测、按端口找 PID、确认目标是 dsh web |
| `lib/probe.mjs` | TCP + HTTP(S) 健康探测 |
| `lib/client.js` | 浏览器半：设置页「服务与重启」 |
| `test/selftest.mjs` | 离线自测入口（`npm test`） |
| `README.md` | 面向用户的安装、配置、接口、排障说明 |

---

## 2. 重启链路的不变量（改动红线）

这些是安全边界，不是“实现细节”。任何改动都不得削弱：

1. **只 kill 能确认是 `dsh web` 的进程。** 先按目标端口找监听 PID，再用 `isDshWebPid()` 校验命令行形态；不匹配就返回 `DIRECT_TARGET_UNSAFE`，绝不“先杀了再说”。不要按进程名扫，不要扩大匹配范围。
2. **执行器必须先脱离目标单元 cgroup。** systemd 模式或“进程在单元里但没有 systemd”时，用 `systemd-run --scope` 搬出去；搬不出去就返回 `NOT_ISOLATED`，不做“点完就失联”的重启。
3. **`run.json` 的写者唯一。** 活跃阶段只由执行器推进；宿主只写 `queued`，以及在心跳消失后补写终态。执行器每次写盘前都要确认 `run.json` 仍是自己这一轮（`runId` 一致），防止晚到/重复执行器覆盖新状态。
4. **原子写。** 所有 JSON 写入走临时文件 + rename；读方永远看到完整 JSON。不要直接 `writeFileSync` 覆盖状态文件。
5. **同一时间只允许一轮。** 有活跃 run 时返回 `BUSY`；终态后 3 秒内返回 `COOLDOWN`；`lastTriggerAt` 再做一层进程内防连点。
6. **启动握手不能省。** 宿主拉起执行器后等待 `lock.json` 里出现存活 PID；8 秒内没有接管就是 `LAUNCH_TIMEOUT`，要停掉 scope、写失败终态，不能假装已受理。
7. **就绪必须同时满足“端口通 + 新实例回报 boot 标记 + 监听 PID 是新 MainPID”。** 只通端口可能连到旧进程；只有 boot 标记但端口不通也不算成功。监听 PID 不匹配返回 `VERIFY_LISTENER_MISMATCH`。
8. **降级要显式。** HTTP 已通但新实例没回报 boot 标记时，允许 `done`，但必须写 `degraded` / `note` 说明“服务恢复了，新实例没加载插件”，不能显示成完全成功。
9. **兜底只用于 systemd 模式。** 多次失败后才尝试直接启动；兜底成功也必须写 `note` 说明当前进程不在单元托管下；兜底失败尝试 `systemctl start` 把单元恢复回来。
10. **不拼 shell 字符串。** 启动命令、systemd 参数、执行器参数一律用 argv 数组（`spawn` / `execFile`）。`startCommand` 从 JSON 数组解析，不要用 `sh -c`。
11. **探测以本机可见地址为准。** 依次尝试 `origin` → `advertised` → `host:port`；公网 URL 只作兜底，不能让 NAT 回环问题决定重启成败。TCP 通但 TLS/HTTP 探测失败时仍算在线，只把方式记为 `tcp`；对 IP 字面量的 HTTPS 允许放宽证书校验。
12. **不假设部署形态。** 单元名从 cgroup 识别，监听地址从 `webServer.host/port` 取，不写死 `dsh-web`、`127.0.0.1` 或 HTTP。

状态模型：`queued` → `preflight` → `restarting` → `waiting` → `done` / `failed`；阶段固定为 `preflight` / `restart` / `ready` / `verify`。新增失败分支时，必须在 `lib/state.mjs` 的 `ERRORS` 里加带 `message` 和 `hint` 的错误码，前端会直接展示它们；不要只返回一个裸字符串。

配置取值以代码为准（`collectRuntime()`）：通常是 `config` → 环境变量 → 自动探测；`DSH_RESTART_DATA_DIR` 只认环境变量；端口优先 `webServer.port`，其次 `--port/-p`，最后 `DSH_RESTART_PORT` / 3081。改配置项时同步更新 `README.md` 的表格。

---

## 3. DSH 插件契约细节

### 宿主半

- 导出 `name`、`inject`、`apply(ctx, config)`。当前 `inject = ['connection']`；缺少 `connection.fetch` 时只警告并退出，不抛异常拖垮宿主。
- 路由通过 `connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })` 注册，返回标准 `Response`。`/api` 走 DSH 的浏览器信任栅栏，不要新增绕过鉴权的公开路由。
- 需要 `webServer` / `webApp` / `dshHomePath` 时用 `ctx.get(name)` 并处理服务不存在的情况，不要假设一定可用。
- 日志用 `ctx.logger`，前缀 `[dsh-restart]`。不要把完整启动命令、token、cookie 写进日志。

### 浏览器半

- 文件形如 `window.__ModuleLoader__.load({ id: 'dsh-restart', factory(require) { ... return { inject: ['slots'], apply } } })`。
- 只 `require('react')`；`react-dom` 只用于可选的 `createPortal`，缺失时要能降级。不要 `import` Node 内置模块，不要用相对路径 import 其它文件。
- 所有副作用放在 `factory` / `apply` 内；不要有顶层 DOM 操作或全局状态。
- 设置页入口：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-restart', label: '服务与重启', order: 90 }, Page))`。改 id/顺序前先确认不会与其它插件冲突。
- 样式通过 `<style id="dsh-restart/style">` 注入，并用 `ctx.effect` 清理；颜色优先用 `--dsw-alias-*` 活 token。
- 界面文案目前是中文，直接写在 `lib/client.js`；`locale/*.json` 只有 `meta.title/description`。只改 locale 不会改变设置页文案。

### 生效方式

- 改 `lib/client.js`：刷新页面即可；客户端 revision 由 mtime/ctime + size 推导。
- 改宿主半（`lib/index.js`、`lib/state.mjs`、`lib/store.mjs`、`lib/environment.mjs`、`lib/proc.mjs`、`lib/probe.mjs`、`lib/restart-runner.mjs`）：必须重启 dsh web 才会加载新代码。**但见下面的安全警告：不要用真实重启来验证。**
- 改 `cordis.patch.yml` 的 `config`：在支持 live reload 的环境下热重载；本插件通常不需要改它。
- 不要为了让改动生效去手改 profile 的 `cordis.yml` 或 bundle 列表；本机是 `link:` 安装，代码改完只差一次宿主重启。

---

## 4. 修改流程（每一轮照做）

1. **看现场**：`git status --short`、`git log --oneline -5`。仓库里可能有其它插件或 worktree 的未提交改动；它们不属于本轮，不要 stage、不要 stash、不要 reset、不要 checkout 覆盖。
2. **读事实**：先读 `README.md` 和相关 `lib/*.mjs`；行为以代码和测试为准，不凭记忆猜。配置优先级、阶段、错误码这类细节尤其要先确认。
3. **最小改动**：优先复用现有模块；不要把宿主逻辑搬进执行器，也不要把执行器逻辑搬进宿主。新增逻辑放对文件（见目录职责表）。
4. **补测试**：行为变化必须在 `test/selftest.mjs` 增加对应用例，断言错误码、阶段或磁盘状态，而不只是“没抛异常”。
5. **更新文档**：用户可见的配置、接口、错误码、行为变化，同步改 `README.md`；版本变化同步改 `package.json` 和仓库根 `README.md` 的插件表。
6. **运行验证**：`npm run verify`，退出码 0。只改文档也要跑。
7. **检查契约**：确认三处 id 没漂移、`files` 白名单完整、没有新增依赖、没有把数据/日志带进仓库。可用的核对命令：

   ```bash
   node -p "require('./package.json').name"
   grep -n "id: dsh-restart" cordis.patch.yml
   grep -n "id: 'dsh-restart'" lib/client.js
   npm pack --dry-run --json >/dev/null   # 可选：确认发布白名单能正常生成
   ```
8. **提交**：只 `git add dsh-restart/...`，检查 `git diff --cached --name-only`，按约定写提交信息，本地 commit。
9. **汇报**：给出提交 hash、验证命令和结果；有未验证的部分（例如真机重启）必须明确写“未验证”。

新增 `lib/*.mjs` 文件时，记得把它加进 `package.json` 的 `scripts.check`；否则 `npm run check` 不会检查它的语法。`files` 里的 `lib/**` 会自动覆盖新文件，不用逐项添加。

---

## 5. 测试规范

`npm test` 等价于 `node test/selftest.mjs`，不是 `node --test`。不要套用其它插件的 `node --test test/*.test.mjs` 命令。

自测的边界：

- **不碰真实服务**：不重启真实 dsh web，不操作真实 systemd 单元，不连生产端口。
- 用假 `systemctl`、假 `dsh web` 进程、临时端口、临时目录；测试结束删除 `/tmp/dshr-selftest-*`。
- 覆盖四层：纯逻辑（state/store/environment/proc/probe）、宿主路由（假 `connection`）、执行器端到端（假 systemd）、失败/兜底路径。
- 用例名用中文，失败时能看出是哪条链路坏了。
- 涉及时间/心跳的用例要控制等待上限，不要留下永久 pending 的定时器或未清理的子进程。
- 不放宽断言来迁就实现；实现错了就改实现。现有 23 项是基线，新增后总数会变，但必须全过。

允许的“真实验证”只有一种：用户明确要求，并且从**另一个终端/另一台机器**操作。当前 agent 本身就运行在 dsh web 进程里，任何真实重启都会终止当前会话——不能拿它当验证手段。

---

## 6. Git 与发布

- 仓库根是 `/opt/dsh-plugins`，`dsh-restart/` 没有自己的 `.git`；所有提交都落在根仓库。
- 分支通常是 `main`，远端是 `origin`。**默认不 push。**
- 只提交 `dsh-restart/` 下的源码、测试、文档、`package.json`、`cordis.patch.yml`、`locale`、`icon`。不提交：
  - `$DSH_HOME/dsh-restart/data` 下的任何状态/日志；
  - `node_modules/`、`*.log`、临时文件、截图；
  - 仓库根目录的发布压缩包（例如 `dsh-restart-*.zip`），除非用户明确要求发布并提交；
  - 其它插件或 worktree 的改动。
- 提交前用 `git diff --cached --name-only` 复核；提交后用 `git status --short` 确认本插件没有遗漏，也没有误带其它文件。
- 不执行 `git checkout -- .`、`git reset --hard`、`git clean -fd` 这类会波及其它改动的命令。
- 用户可见行为变化时按语义化版本升 `package.json` 的 `version`，并同时更新 `README.md` 和仓库根 `README.md` 的版本/描述；纯文档修改不升版本。
- `files` 白名单决定发布内容；不要把 `test/`、`AGENTS.md` 加进去，除非用户明确要求发布开发资料。

---

## 7. 安全与凭据

- 不读取、不打印、不提交任何 token、密钥、cookie、证书或用户隐私数据。
- `startCommand` 的参数可能包含 token；状态快照只按 `token|key|secret|pass` 做脱敏，新增字段时要自己再检查一遍。日志里不要输出完整命令。
- 状态目录 `$DSH_HOME/dsh-restart/data` 以 `0700` 创建，JSON 文件以 `0600` 写入；不要把权限放宽成全局可读。
- 有活跃 run 时不要删除或改写 `run.json` / `lock.json` / `heartbeat.json`；那是正在进行的重启现场。排障时先读 `runner.log` 和 `history.json`。
- 不要关闭鉴权、放宽 `/api` 信任栅栏、跳过 TLS 校验（IP 字面量探测的证书放宽是既有例外，不要扩大到域名）。
- 不要为了“让测试通过”而跳过 cgroup 隔离、进程身份校验或监听 PID 校验。

---

## 8. 已知限制（不要假装已解决）

- Windows 的“直接重启”未验证；macOS 属于尽力支持（依赖 `lsof` / `ps`）。
- 浏览器半的视觉与交互主要靠人工验证，没有自动化 UI 测试；改动 UI 后至少刷新页面看一次，并在汇报里说明“仅人工验证”。
- 自测覆盖的是假 systemd / 假 dsh web，不覆盖真实 systemd 的 `TimeoutStopSec`、`Restart=always` 等边界；真机问题要看 `systemctl status` / `journalctl -u <unit>` 和 `runner.log`。
- README 与代码如有出入，以代码和测试为准；发现文档漂移时在本轮顺手修正文档，不要留到以后。

---

## 9. 完成检查清单

提交前逐项确认：

- [ ] `npm run verify` 退出码 0，自测全过；
- [ ] 行为变化有新增/更新的测试用例；
- [ ] 三处 id 仍一致；`package.json` 的 `files` / `scripts.check` 没有漏项；
- [ ] 没有新增依赖、构建步骤或未清理的 `ctx.effect`；
- [ ] 没有削弱进程校验、cgroup 隔离、握手、监听 PID 校验等安全不变量；
- [ ] 用户可见变化已更新 `README.md`，必要时升版本并更新根 README；
- [ ] 暂存区只有 `dsh-restart/` 下的预期文件，没有数据、日志、压缩包或其它插件改动；
- [ ] 已在本地 git 提交，未 push；提交信息包含验证结果；
- [ ] 汇报中写明提交 hash、实际验证命令和结果，以及未验证的部分。
