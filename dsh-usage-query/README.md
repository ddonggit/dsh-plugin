# dsh-usage-query

DSH 设置页里的「用量查询」：一页看完 **DeepSeek 余额**、**OpenCode Go 三档配额**、**OpenDesign 余额与积分**，并就地管理每个渠道的多个账号。

- 版本：`0.3.1`
- 运行要求：DSH `>= 0.2.1-rc.2`、Node `>= 20`
- 形态：标准 DSH bundle（宿主半 + 浏览器半），**零运行时依赖**
- 位置：设置 → 用量查询（`settings.section`，`order: 41`）

## 界面

| 区域 | 内容 |
|---|---|
| 顶部状态条 | 三个渠道各一枚 chip：DeepSeek 余额、OpenCode 最紧的那档窗口、OpenDesign 主窗口剩余比例；带"多久前更新" |
| DeepSeek 卡 | 总余额（按币种显示 ¥ / $）、充值 / 赠送拆分条与明细、账户是否可用 |
| OpenCode Go 卡 | 4 小时 / 每周 / 每月三档进度条，**按剩余比例填充**，颜色随余量变化（>50% 绿、>20% 黄、其余红），附重置时间 |
| OpenDesign 卡 | 登录账号、计划与订阅状态、编码窗口额度、钱包余额、订阅 / 充值积分、今日与累计消耗 |
| 账号抽屉 | 每渠道支持多账号：添加（保存前先向上游校验）、编辑（只改名或换凭据）、删除（含清空最后一个）、切换当前账号 |
| 刷新 | 单卡「刷新」、页面「刷新全部」；勾选「自动刷新」时每 5 分钟拉一次（仅页面可见时），从后台切回来超过 60 秒也会自动刷新 |

凭据只在宿主侧使用，页面永远只看到掩码（如 `sk-****cdef`）。

## 安装

本地目录安装（当前用法，装出来是 `link:`，改代码不必重装）：

```bash
dsh plugin --profile web add /path/to/dsh-usage-query
```

验证合成树里出现该条目且没有 `disabled`：

```bash
dsh --profile web --dump-config | grep -A4 'id: dsh-usage-query'
```

规则与坑：

- 包名已存在时安装会报 `already-installed` —— 升级要先 `remove` 再 `add`。
- 若会话里有 `plugin_manager` 工具，用 `install_bundle` / `remove_bundle` / `list_bundles` 等价操作。
- 不要手改 `$DSH_PROFILE_DIR/package.json` 或 `cordis.patch.yml`，交给安装命令。
- 卸载只取消加载：**`$DSH_HOME/usage-query/` 里的账号数据不会被删**，要清理需手动删。

## 生效方式

| 改动 | 生效 | 代价 |
|---|---|---|
| `lib/client.js` | 刷新页面即生效（revision 由 mtime + size 推导） | 无 |
| `locale/*.json`、`icon.svg` | 刷新页面 | 无 |
| `lib/index.js`、`lib/api.js`、`lib/store.js`、`lib/providers.js` | **必须重启宿主**：已加载的模块不会换新 | `systemctl restart dsh-web.service` |
| `cordis.patch.yml` 里的 `config` | `patchReload: live` 下热重载 | 无 |

只改浏览器半时，页面会先变；宿主半没重启就会出现"界面新、接口旧"的混合状态，排查时注意这一点。

## 配置

在 patch 条目里写 `config: {}`：

| 键 | 默认值 | 说明 |
|---|---|---|
| `storePath` | `$DSH_HOME/usage-query/accounts.json` | 账号文档路径；也可用环境变量 `DSH_USAGE_QUERY_STORE_PATH` |
| `cacheTtlMs` | `60000` | 上游结果的服务端缓存；`0` 表示不缓存，`?force=1` 可绕过 |
| `fetch` | `globalThis.fetch` | 仅测试注入用，生产不要配 |

`$DSH_HOME` 的解析顺序与 Harness 自身一致：`dshHomePath` 服务 → `$DSH_HOME` → `~/.dsh`。

## HTTP 接口

全部是精确路由，注册在 `connection.fetch` 上，因此自动继承 `/api` 的 Host/Origin 围栏与会话校验（实测：无会话 `401`、跨站 Origin `403`、伪造 Host `403`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/usage-query/accounts` | 三渠道账号列表（凭据已掩码）+ 当前账号 |
| `POST` | `/api/usage-query/accounts` | 新增账号；先向上游校验，失败不落盘；`activate: true` 可设为当前 |
| `POST` | `/api/usage-query/accounts/switch` | 切换当前账号 |
| `POST` | `/api/usage-query/accounts/update` | 改名 / 换凭据（换凭据会同时失效该账号缓存） |
| `POST` | `/api/usage-query/accounts/delete` | 删除账号；删最后一个即清空该渠道 |
| `GET` | `/api/usage-query/deepseek` | 余额；未配账号时返回空态 `account: null` |
| `GET` | `/api/usage-query/opencode` | 三档窗口用量 |
| `GET` | `/api/usage-query/opendesign` | 账户 / 账单摘要 / 钱包 |

错误约定：客户端问题 `400`/`404`/`413`（请求体上限 64 KB），上游问题 `502`，本地仓库写入失败 `500`。响应体固定 `{ ok: false, error, code? }`，`code` 取值：`CREDENTIAL_REJECTED`、`OPENDESIGN_AUTH_INVALID`、`OPENDESIGN_NO_CONTROL_KEY`、`STORE_WRITE_FAILED`。上游响应正文只进宿主日志，不会返回给页面。

## 数据与凭据

- 文档：`$DSH_HOME/usage-query/accounts.json`，文件 `0600`、目录 `0700`。
- 写入：临时文件 + `rename` 原子替换，崩溃不会留下半个 JSON。
- 并发：所有改走 `AccountStore.update()` —— 读、改、写在同一个同步 tick 内完成，`await` 只允许出现在它之前。两个标签页同时操作不会互相覆盖（有回归测试覆盖"更新凭据期间并发删除账号"）。
- 损坏：文件解析失败时先改名成 `accounts.json.corrupt-<时间戳>` 再以空态启动，**不会**用空文档覆盖掉用户唯一的一份凭据。
- 首次启动会从这三个旧位置导入（存在才导）：`<DSH_HOME>/plugins/usage-query/data/accounts.json`、`<DSH_HOME>/plugins/deepseek-balance/data/accounts.json`、`~/.config/opencode/opencode-usage-config.json`。

## 上游依赖

| 渠道 | 接口 | 凭据 | 校验 |
|---|---|---|---|
| DeepSeek | `GET https://api.deepseek.com/user/balance` | API Key（`Bearer`） | 保存前探测一次，401/403 视为无效 |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | API Key（`Bearer`） | 同上 |
| OpenDesign | `GET https://amr-api.open-design.ai/api/v1/{me,billing/summary,wallet/balance}` | `controlKey`（`Bearer`） | 粘贴 `~/.amr/config.json` 或裸 key，最多试 6 个候选，账单接口认哪个用哪个 |

单次上游请求超时 10 秒；OpenDesign 三个端点并行，所以最坏等待约 10 秒而不是 30 秒。`/me` 与钱包失败只会降级（相应字段留空），不影响账单主体；账单摘要或钱包返回 401/403 则整体判定为登录态失效（`OPENDESIGN_AUTH_INVALID`）。

## 开发

```bash
npm test                                                  # 54 个测试
npm run check                                             # node --check 五个入口
node ~/.dsh/skills/dsh-plugin-dev/scripts/check-bundle.mjs .
```

`node --test test/*.test.mjs`，没有额外依赖：

| 文件 | 覆盖 |
|---|---|
| `test/harness.mjs` | 假 ctx（`connection.fetch` 注册表 + `dshHomePath`）、脚本化 fetcher、临时 `$DSH_HOME` |
| `test/api.test.mjs` | 掩码、校验后落盘、错误码、缓存与 `force=1`、删改切换 |
| `test/store.test.mjs` | 路径解析、权限、legacy 迁移、下线渠道清理 |
| `test/providers.test.mjs` | controlKey 挖掘、401 与网络失败的区分、错误文案不泄漏上游正文 |
| `test/hardening.test.mjs` | 并发写、损坏文档隔离、请求体上限、OpenDesign 降级 |
| `test/client.test.mjs` | loader id 三处一致、`inject` 面、样式注册与清理 |

代码约定（照 DSH 插件规范）：

- id 三处必须一致：`package.json` 的 `name`、`cordis.patch.yml` 的 `insert.id`、`client.js` 的 `load({ id })`。任一处不一致就是白屏。
- 宿主半 `apply(ctx, config)`，每个资源都挂 `ctx.effect` 并返回清理函数；可选服务用 `export const inject`。
- 浏览器半不 import 任何 Harness Client 包，React 从 `require("react")` 取，样式只用 `--dsw-alias-*` token 并加 `.dsh-uq-` 前缀。
- 代码里零绝对路径：home 一律走 `dshHomePath` → `$DSH_HOME` → `~/.dsh`。

加一个新渠道要动三处：`lib/store.js` 的 `PROVIDERS`（存储与路由）、`lib/providers.js` 的 `FETCHERS`（上游抓取）、`lib/client.js` 的 `META` 与对应 Body 组件（文案与呈现）；再加一份 `test/*.test.mjs`。

## 排障

宿主日志（本机 unit 把 stdout/stderr 追加到该文件）：

```bash
grep dsh-usage-query /tmp/dsh-web.log
```

| 现象 | 原因与处理 |
|---|---|
| 设置里没有「用量查询」 | `dsh --profile web --dump-config \| grep -A4 'id: dsh-usage-query'` 查不到就是没装或被 `disabled`；查得到但页面空白，多半是 id 三处不一致（前端只会报 `slot entry crashed`，不会说原因） |
| 卡片红字「当前账号凭据可能已失效」 | 上游对已保存的 Key 返回了 401/403，去账号管理里换凭据 |
| 卡片红字「OpenDesign 登录态已失效」 | controlKey 过期：桌面端重新 `vela login`，再粘贴新的 `~/.amr/config.json` |
| 保存时提示「凭据无效…未保存」 | 探测就失败了，磁盘上什么都没写；换一把 Key 重试即可 |
| 「账号仓库写入失败（Exxx）」 | `$DSH_HOME/usage-query/` 不可写（权限 / 只读挂载 / 磁盘满），按括号里的错误码查 |
| 账号列表突然空了 | 目录里找 `accounts.json.corrupt-*`：原文件解析失败被隔离了，修好 JSON 后改回 `accounts.json` 即可恢复 |
| 改了 `lib/*.js` 但行为没变 | 宿主半没重启；只改了 `lib/client.js` 的话刷新页面就够 |
| 点保存后一直「正在校验…」 | 宿主在探测上游：单次请求 10 秒超时，OpenDesign 最多依次试 6 个候选，最坏约 1 分钟；GET 侧另有 45 秒总超时，POST 故意不设超时以免重复提交 |

## 已知限制

- `maskKey` 只藏中间部分：9–15 个字符的短凭据会露出 7 个字符（实际 key 都远长于此，故未改）。
- 同一账号的并发 `GET` 不做单飞去重，可能多打一次上游，靠 60 秒缓存兜底。
- 没有 `export const Config`（schemastery）：本包是零依赖的 `link:` 安装，从自身目录解析不到该依赖，因此配置项由 `apply` 侧容错。
- `requestBody: 'buffered'` 意味着连接服务会先缓冲请求体，宿主侧 `maxRequestBodyBytes`（默认 300 MB）才是外限；插件内部只能保证超过 64 KB 的包不被解析、读取在上限处中止。
- 浏览器半的视觉与交互只做过结构与逻辑验证，没有自动化 UI 测试。

## 许可

MIT，见 [LICENSE](./LICENSE)。
