# dsh-compact-memory（压缩接力 · 工作记忆）

> 压缩前把“工作现场”保存成一张交接卡，压缩成功后自动放回对话；需要细节时还能查回原始日志。
> **默认不改变 dsh 原生压缩的阈值**：只在回合结束、agent 空闲时做同一件事。

---

## 它解决什么，不解决什么

**解决**

- 长会话被压缩后，模型仍知道：目标、关键决定及原因、约束与偏好、踩过的坑、进度、下一步、关键文件与目录。
- 压缩发生在安全边界（回合结束），而不是写到一半、工具调用没配对时。
- 压缩前的经验有两层保险：模型主动写的卡片 + 插件自动生成的事实快照。
- 压缩后**自动回注一次**，不靠模型“想起来去读文件”。
- 原始事件仍在 session log；卡片里给出 `worklog_read` / `session_query` 的回查入口。

**不解决**

- 不替换 dsh 的 `compaction-basic`，不改摘要 prompt，不改 session 日志格式。
- 不保证“零信息损失”；它把关键经验前置，原始日志仍是最终兜底。
- **不能让原生压缩变晚**。要变晚只能改 dsh 的 `maxTokens`/headroom 配置。
- 本轮不安装、不重启、不改现有 profile；安装是下一步。

---

## 默认触发点：多少百分比？

这台机器：`W=1,048,576`、`O=384,000`（输出预留）、`B=65,536`（headroom）。

dsh 原生公式：

```text
native = floor(min(W × 0.8, W − O − B))
       = min(838,860, 599,040)
       = 599,040 tokens = 57.13%
```

所以 **80% 只是名义上限，本机真正触发点是 57.13%**。

| 模式 | 触发点 | 占 1M 窗口 | 说明 |
|---|---|---|---|
| **`boundary`（默认）** | **599,040** | **57.13%** | 与原生同阈值，只在回合结束、agent 空闲时执行；**绝不更早** |
| `native` | 599,040 | 57.13% | 插件不调 `/compact`，只做记忆卡；压缩完全交给原生 |
| `early` + `0.9` | 539,136 | 51.42% | 显式选择才启用；更早、压缩更频繁 |
| `window` + `0.5` | 524,288 | 50.00% | 显式选择才启用；按窗口百分比思考的人用 |
| `window` + `0.7` | 599,040 | 57.13% | 高于原生阈值会被截断，**不会更晚** |

**硬保证：任何模式下 `trigger <= native`。** 想完全不干预时机，用 `mode: native`。

如果觉得 57% 太早：那是 dsh 原生为了 384K 输出预留 + 64K headroom 得出的，不是插件提前。把模型 `maxTokens` 调小（例如 64K），原生阈值会变成约 80%；这是 dsh 模型配置的取舍。

---

## 安装（需要重启宿主）

```bash
dsh plugin --profile web add /opt/dsh-plugins/dsh-compact-memory
dsh --profile web --dump-config | grep -A10 dsh-compact-memory
```

然后重启 `dsh web`（可用现有 `dsh-restart` 插件或服务管理器）。宿主半改动必须重启才生效。

确认 bundle 列表里有它；若没有，按本仓库 README 的说明把它加进 `dsh.profile.bundles`，或重新用 `plugin_manager install_bundle` 安装。

---

## 验证

1. 新开一个测试会话，输入 `/handoff`：应返回当前交接卡和文件路径。
2. 看文件：
   ```bash
   ls -l ~/.dsh/compact-memory/
   ```
   每个会话一个目录，里面有 `card.json`、`card.md`、`history/`。
3. 让会话长到触发压缩（或临时把 `mode` 设为 `early`、`triggerAtNativeRatio` 设为 `0.3` 做快速验证），压缩后的下一条消息里应出现 `【工作交接卡·自动】`。
4. 用 `compact_status` 工具看当前的 W/O/B、原生阈值、插件触发点和压力。

---

## 配置

```yaml
- id: dsh-compact-memory
  name: dsh-compact-memory
  config:
    autoCompact:
      mode: boundary          # native | boundary | early | window
      triggerAtNativeRatio: 1.0
    maxCardChars: 6000
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `memoryDir` | `''` | 空 = `$DSH_HOME/compact-memory` |
| `maxCardChars` | `6000` | 卡片硬上限，超出按优先级裁剪 |
| `language` | `'zh'` | 卡片语言（`zh` / `en`） |
| `injectAfterCompaction` | `true` | 压缩成功后自动回注 |
| `injectOnResume` | `true` | 重启/恢复后若上次压缩还没回注，补一次 |
| `nudge.enabled` | `true` | 压力到 0.7×原生阈值时提醒写卡 |
| `nudge.atNativeRatio` | `0.7` | 软提醒的压力比例（相对原生阈值） |
| `nudge.cooldownTurns` | `3` | 两次提醒至少隔几轮 |
| `autoCompact.mode` | `boundary` | 见上表 |
| `autoCompact.triggerAtNativeRatio` | `1.0` | 仅 `early` 用；>1 截断为 1 |
| `autoCompact.atWindowRatio` | `0.7` | 仅 `window` 用；有效值 = `min(该值×W, native)` |
| `autoCompact.nativeThresholdRatio` | `0.8` | 原生公式里的 0.8 |
| `autoCompact.nativeHeadroomTokens` | `65536` | 原生公式里的 headroom |
| `autoCompact.minNewSurfaceTokens` | `20000` | 自上次压缩新增面至少多少 token |
| `autoCompact.minTurnsSinceLast` | `2` | 冷却轮数 |
| `autoCompact.idleGraceMs` | `2000` | 等 agent 空闲的宽限 |
| `autoCompact.timeoutMs` | `180000` | `/compact` 超时 |
| `autoCompact.skipSubagents` | `true` | 子会话不自动压 |
| `snapshotOnCompactionStart` | `true` | `compaction/start` 冻结快照 |
| `mirrorMarkdown` | `true` | 额外写 `card.md` |
| `historyLimit` | `10` | 保留最近 10 个历史版本 |
| `staleAfterTurns` | `2` | 卡片多少轮没更新算过期 |
| `staleAfterMs` | `21600000` | 卡片多少毫秒没更新算过期（6 小时） |
| `sourceKind` | `'compact-memory'` | 注入消息的 source.kind；可回退 `'user'` |
| `debug` | `false` | 详细日志 |

未知键、非法比例、越界路径会在加载时直接报错，不会静默忽略。

---

## 工具与命令

| 名称 | 作用 |
|---|---|
| `worklog_read` | 读完整卡片或指定小节 |
| `worklog_write` | 更新目标/决定/约束/坑/文件/下一步/待确认 |
| `compact_request` | 请求在下一个安全回合边界压缩（不是立即压） |
| `compact_status` | 查看 W/O/B、原生阈值、插件触发点、当前压力 |
| `/handoff` | 查看/刷新卡片；`/handoff refresh` 强制从事件重建 |

---

## 数据与隐私

- 默认目录：`$DSH_HOME/compact-memory/<safeSessionId>/`。
- 目录 `0700`，文件 `0600`；临时文件 + `rename` 原子写。
- 不联网、不引入第三方依赖、不读 `.env`。
- 卡片写入前会脱敏常见密钥形状（`sk-…`、`Bearer …`、`*_KEY=…`、私钥块），但**不要主动把密钥写进对话**。
- 删除目录即可清除卡片；卸载插件不会删除该目录。

---

## 与 billion-context 共存

`billion-context` 启用时会关掉原生压缩，自己接管压缩；此时本插件的 `/compact` 调度可能不可用。建议：

```yaml
autoCompact:
  mode: native
```

这样插件只保留“卡片 + 手动/其压缩后的接力”，不参与时机。两者不要同时自动压缩。

---

## 回滚

```bash
dsh plugin --profile web remove dsh-compact-memory
```

重启宿主。数据目录保留，可手动删：

```bash
rm -rf ~/.dsh/compact-memory
```

---

## 开发

```bash
cd /opt/dsh-plugins/dsh-compact-memory
npm test          # node --test
npm run check     # 逐文件 node --check
```

本插件是外部 bundle：**不 import 任何 `@deepseek-ai/*` 包**，只用 `ctx` 服务和 `node:*`。原因见 `docs/方案.md` 的“外部插件边界”。

---

## 许可

MIT。
