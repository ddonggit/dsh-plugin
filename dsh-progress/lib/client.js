// Browser half. 纯工厂函数：无构建、无第二份 React。
// 契约：load.id == package.json name == cordis.patch.yml insert.id
//
// 一个插件，四个展示位（原 dsh-running-sessions 已并入）：
//   A 对话里 report_progress 的专用卡片（tool.call.toolview，key = 工具名）
//   B 输入框上方的活动条（conversation.input.dock）：
//     本会话在跑 → 当前进展；本会话空闲 → 其他会话的活动计数
//   C 侧栏「进行中」图标 + 整页列表（sidebar.panellist / main）
//   D 会话标题栏计数片 + 弹层（conversation.session.header.utilities）
//
// 列表行会显示该会话在本标签页里见过的最新一条进展（来自 A 写进 latest 的内容）。
// 入口开关不再占用「设置」页，改在插件自己的「入口显示」折叠区里（C、D 内各有一处）。
// 只读模型给出的参数，不参与模型输入，所以不影响上下文缓存。
window.__ModuleLoader__.load({
  id: 'dsh-progress',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef, useSyncExternalStore } = React

    const STYLE_ID = 'dsh-progress/style'
    const TOOL_NAME = 'report_progress'
    const PANEL_ID = 'running-sessions'
    const MINUTE = 60_000
    const WINDOW_CHOICES = [15, 30, 60, 120]
    /** 默认窗口：本浏览器没有选过时间窗口时用它。 */
    const DEFAULT_WINDOW = 30

    // 键名从旧插件迁到本插件；旧键只读不写，升级后用户的选择不会丢。
    const WINDOW_KEY = 'dsh-progress.window'
    const LEGACY_WINDOW_KEY = 'dsh-running-sessions.window'
    const ENTRY_KEYS = { nav: 'dsh-progress.entry.nav', chip: 'dsh-progress.entry.chip' }
    const LEGACY_ENTRY_KEYS = { nav: 'dsh-running-sessions.entry.nav', chip: 'dsh-running-sessions.entry.chip' }

    /** 图标路径：波形。"正在活动"里唯一不歧义的形状，18px 仍清楚。 */
    const WAVE = 'M2.2 12h3.9l2.3-6.6 4 13 2.2-6.4h5.2'

    /** 相位到中文标签与配色。（配色只映射到 --dsw-alias-* 主题变量） */
    const PHASES = {
      start: { label: '开始', tone: 'brand' },
      working: { label: '进行中', tone: 'brand' },
      problem: { label: '遇到问题', tone: 'warn' },
      blocked: { label: '卡住了', tone: 'error' },
      done: { label: '已完成', tone: 'success' },
    }

    /* ---------------- 会话级“最近一次汇报” ---------------- */
    // 卡片是流式渲染的，最新那张挂载时把内容写进这里；状态条与跨会话列表都读它。
    // 这是纯 UI 状态，不发送给模型，不影响提示缓存。
    const progressListeners = new Set()
    const latest = new Map()
    let progressVersion = 0

    function subscribeProgress(listener) {
      progressListeners.add(listener)
      return () => progressListeners.delete(listener)
    }

    function getProgressVersion() {
      return progressVersion
    }

    function publish(sessionId, value) {
      latest.set(sessionId, value)
      progressVersion += 1
      for (const listener of [...progressListeners]) listener()
    }

    function readProgress(sessionId) {
      return sessionId === undefined ? null : latest.get(sessionId) ?? null
    }

    // 槽位框架一定会传 useSession；万一哪天没传，就用一个“同样只调用一次 hook”的空实现顶上，
    // 这样 hook 永远无条件调用，不会因为 props 变化把调用顺序弄乱。
    const subscribeNothing = () => () => {}
    function useNoSessionSnapshot() {
      useSyncExternalStore(subscribeNothing, () => null)
    }
    const pickSession = (useSession) => (typeof useSession === 'function' ? useSession : useNoSessionSnapshot)
    const selectSessionId = (useSession) => pickSession(useSession)((snapshot) => snapshot?.sessionId ?? undefined)
    const selectRunning = (useSession) => pickSession(useSession)((snapshot) => snapshot?.running === true)

    /* ---------------- 参数读取 ---------------- */

    /** result 相位参数在 block.call.argsRaw；start/preparing 相位在 block.argsRaw。 */
    function readArgs(block) {
      const raw = typeof block?.call?.argsRaw === 'string'
        ? block.call.argsRaw
        : typeof block?.argsRaw === 'string'
          ? block.argsRaw
          : ''
      if (raw === '') return null
      try {
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
      } catch {
        return null
      }
    }

    function textOf(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join('\n').trim()
    }

    function stringOf(value) {
      return typeof value === 'string' ? value.trim() : ''
    }

    /* ---------------- 本地设置：入口开关与时间窗口 ---------------- */

    function readStored(key, legacyKey) {
      try {
        const value = window.localStorage.getItem(key)
        if (value !== null) return value
        return legacyKey === undefined ? null : window.localStorage.getItem(legacyKey)
      } catch {
        return null
      }
    }

    function writeStored(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        // 只影响持久化，不影响本次生效
      }
    }

    function readWindow() {
      const stored = Number(readStored(WINDOW_KEY, LEGACY_WINDOW_KEY))
      return WINDOW_CHOICES.includes(stored) ? stored : DEFAULT_WINDOW
    }

    function readEntry(key) {
      const raw = readStored(ENTRY_KEYS[key], LEGACY_ENTRY_KEYS[key])
      if (raw === '0') return false
      return true
    }

    /** 两个入口至少保留一个：都关掉就会连「入口显示」都找不到。 */
    function normalizeEntries(next) {
      return next.nav || next.chip ? next : { ...next, chip: true }
    }

    let entrySnapshot = normalizeEntries({ nav: readEntry('nav'), chip: readEntry('chip') })
    const entryListeners = new Set()

    function subscribeEntries(listener) {
      entryListeners.add(listener)
      return () => entryListeners.delete(listener)
    }

    function getEntrySnapshot() {
      return entrySnapshot
    }

    function setEntry(key, on) {
      const next = normalizeEntries({ ...entrySnapshot, [key]: on })
      entrySnapshot = next
      writeStored(ENTRY_KEYS[key], next[key] ? '1' : '0')
      for (const listener of entryListeners) listener()
    }

    function useEntries() {
      return useSyncExternalStore(subscribeEntries, getEntrySnapshot, getEntrySnapshot)
    }

    /* ---------------- 跨工作区会话数据 ---------------- */

    function baseName(path) {
      if (typeof path !== 'string' || path.length === 0) return ''
      const parts = path.split(/[\\/]/).filter(Boolean)
      return parts.length === 0 ? path : parts[parts.length - 1]
    }

    function toSet(value) {
      if (Array.isArray(value)) return new Set(value)
      if (value != null && typeof value === 'object') return new Set(Object.keys(value))
      return new Set()
    }

    /** 相对时间：刚刚 / N 分钟 / N 小时 / N 天。 */
    function relativeTime(ts, now) {
      const diff = Math.max(0, now - ts)
      if (diff < MINUTE) return '刚刚'
      if (diff < 60 * MINUTE) return `${Math.floor(diff / MINUTE)} 分钟`
      if (diff < 24 * 60 * MINUTE) return `${Math.floor(diff / (60 * MINUTE))} 小时`
      return `${Math.floor(diff / (24 * 60 * MINUTE))} 天`
    }

    /**
     * 把所有工作区的会话摊成三组。
     * 运行中的会话不受时间窗口淘汰；只有非运行会话按 updatedAt 淡出。
     */
    function collect(sessions, statuses, workspaces, windowMinutes, now) {
      const windowMs = windowMinutes * MINUTE
      const archived = toSet(workspaces?.archivedSessionIds)
      const workspaceName = new Map()
      /** 会话 → 真实工作区 id，用于「N 个工作区」计数；cwd 目录名不是工作区。 */
      const workspaceOf = new Map()
      for (const view of workspaces?.items ?? []) {
        for (const sessionId of view.sessionIds ?? []) {
          workspaceName.set(sessionId, view.title)
          workspaceOf.set(sessionId, view.workspaceId)
        }
      }
      const entries = []
      for (const id of sessions?.ids ?? []) {
        const row = sessions.byId?.[id]
        if (row === undefined) continue
        if (row.blank === true) continue
        if (row.origin === 'subagent') continue
        if (archived.has(id)) continue
        const status = statuses?.get?.(id) ?? statuses?.[id]
        const pending = status?.pendingInteraction != null
        const running = row.running === true || status?.running === true
        // 缺失时间戳记为 0：运行中的会话仍然保留（不受窗口淘汰），其余视为已淡出。
        const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0
        // 取绝对值：时钟跳变可能把 updatedAt 推到未来，单向比较会让它在窗口里永远新鲜。
        const fresh = updatedAt > 0 && Math.abs(now - updatedAt) <= windowMs
        if (!pending && !running && !fresh) continue
        entries.push({
          id,
          title: row.displayTitle || String(id),
          group: pending ? 'wait' : running ? 'run' : 'done',
          updatedAt,
          // 归属看它在不在某个工作区的 sessionIds 里；cwd 目录名只是兜底显示，不参与工作区计数。
          workspace: workspaceName.get(id) ?? baseName(row.cwd),
          workspaceId: workspaceOf.get(id) ?? null,
        })
      }
      entries.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || b.updatedAt - a.updatedAt)
      const counts = { all: entries.length, wait: 0, run: 0, done: 0 }
      for (const entry of entries) counts[entry.group] += 1
      return { entries, counts }
    }

    /**
     * 这条会话在本标签页里最新的、与当前分组一致的进展。
     * 已经收工的会话只认 done 汇报；正在跑的会话不认上一轮的 done。
     */
    function progressOf(entry) {
      const item = latest.get(entry.id)
      if (item === undefined) return null
      if (entry.group === 'done') return item.phase === 'done' ? item : null
      return item.phase === 'done' ? null : item
    }

    /** 每行的第二行：工作区名 + 最新进展（没有进展时退回状态短语）。 */
    function subtitleOf(entry) {
      const where = entry.workspace
      const phrase = entry.group === 'wait' ? '等你确认' : entry.group === 'run' ? '正在执行' : '已完成'
      const item = entry.group === 'wait' ? null : progressOf(entry)
      const state = item !== null && item.summary !== '' ? item.summary : phrase
      return where ? `${where} · ${state}` : state
    }

    /** 订阅任意 `{ getSnapshot, subscribe }` 数据源。 */
    function useSource(source) {
      const subscribe = useCallback((fn) => source.subscribe(fn), [source])
      const read = useCallback(() => source.getSnapshot(), [source])
      return useSyncExternalStore(subscribe, read, read)
    }

    /** 一次取数：所有入口共用同一套推导。 */
    function useFeed(ctx) {
      const sessions = useSource(ctx.sessions.list)
      const statuses = useSource(ctx.uiSession.sessionStatus)
      const workspaces = useSource(ctx.workspaces.list)
      // 进展变化也要让列表重渲染，否则行里那句“正在做什么”会停在旧内容上。
      useSyncExternalStore(subscribeProgress, getProgressVersion, getProgressVersion)
      const [windowMinutes, setWindowMinutes] = useState(readWindow)
      const [now, setNow] = useState(() => Date.now())

      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000)
        return () => clearInterval(timer)
      }, [])

      const { entries, counts } = useMemo(
        () => collect(sessions, statuses, workspaces, windowMinutes, now),
        [sessions, statuses, workspaces, windowMinutes, now],
      )
      // 只数真实工作区 id：同一个 cwd 目录名可能属于不同工作区，也不能拿目录名冒充工作区。
      const workspaceCount = useMemo(
        () => new Set(entries.map((entry) => entry.workspaceId).filter((id) => id != null)).size,
        [entries],
      )
      const cycleWindow = useCallback(() => {
        setWindowMinutes((current) => {
          const next = WINDOW_CHOICES[(WINDOW_CHOICES.indexOf(current) + 1) % WINDOW_CHOICES.length]
          writeStored(WINDOW_KEY, String(next))
          return next
        })
      }, [])
      return { entries, counts, workspaceCount, now, windowMinutes, cycleWindow }
    }

    /* ---------------- A：对话里的卡片 ---------------- */

    function ProgressCard(props) {
      const { phase, block, sessionId, useSession } = props
      // 会话 id 一般是标准 prop；拿不到时退回会话快照，避免状态条永远空着。
      const sid = sessionId ?? selectSessionId(useSession)

      const args = readArgs(block)
      const done = phase === 'result'

      useEffect(() => {
        if (!done || args === null || sid === undefined) return
        publish(sid, {
          phase: typeof args.phase === 'string' ? args.phase : 'working',
          summary: stringOf(args.summary),
          next: stringOf(args.next),
          at: Date.now(),
        })
      }, [done, sid, block])

      // 流式阶段：工具调用还没落地，只给一个很轻的占位。
      if (!done) {
        return h(
          'div',
          { className: 'dpg-card dpg-card--pending' },
          h('span', { className: 'dpg-dot' }),
          h('span', { className: 'dpg-title' }, '正在汇报…'),
        )
      }

      // call === null 只说明这次调用的记录滑出了已加载的历史窗口，不是汇报失败。
      const failed = block?.isError === true
      if (failed) {
        const reason = textOf(block?.content)
        return h(
          'div',
          { className: 'dpg-card dpg-card--error' },
          h('div', { className: 'dpg-head' },
            h('span', { className: 'dpg-dot' }),
            h('span', { className: 'dpg-title' }, '汇报失败'),
          ),
          reason === '' ? null : h('div', { className: 'dpg-detail' }, reason),
        )
      }

      if (args === null) {
        return h(
          'div',
          { className: 'dpg-card dpg-card--success' },
          h('div', { className: 'dpg-head' },
            h('span', { className: 'dpg-dot' }),
            h('span', { className: 'dpg-title' }, '已汇报'),
          ),
        )
      }

      const meta = PHASES[args.phase] ?? PHASES.working
      const summary = stringOf(args.summary)
      const detail = stringOf(args.detail)
      const next = stringOf(args.next)

      return h(
        'section',
        { className: `dpg-card dpg-card--${meta.tone}` },
        h(
          'div',
          { className: 'dpg-head' },
          h('span', { className: 'dpg-dot' }),
          h('span', { className: 'dpg-title' }, meta.label),
          h('span', { className: 'dpg-summary' }, summary === '' ? '（没写说明）' : summary),
        ),
        detail === '' ? null : h('div', { className: 'dpg-detail' }, detail),
        next === '' ? null : h('div', { className: 'dpg-next' },
          h('span', { className: 'dpg-next-key' }, '下一步'),
          next,
        ),
      )
    }

    /* ---------------- 图标 ---------------- */

    function Wave(props) {
      const { live = true, size = 16 } = props
      return h(
        'svg',
        {
          className: 'rs-glyph rs-wave',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          'aria-hidden': 'true',
          style: { width: size, height: size, display: 'block' },
        },
        h('path', { className: 'rs-trail', d: WAVE }),
        live ? h('path', { className: 'rs-live', d: WAVE }) : h('path', { d: WAVE }),
      )
    }

    function Spinner() {
      return h(
        'svg',
        { className: 'rs-spin', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: 6, opacity: 0.2 }),
        h('circle', { className: 'rs-arc', cx: 8, cy: 8, r: 6 }),
      )
    }

    /* ---------------- B：输入框上方的活动条 ---------------- */

    /**
     * 一个槽位，两种内容：
     *   本会话在跑 → 当前进展（原 progress 状态条）；
     *   本会话空闲 → 其他会话的活动计数（原 running-sessions 的“别处还在忙”）。
     * 两者不会同时出现，避免输入框上方堆两条。
     */
    function ComposerDock(props) {
      const { ctx, sessionId, useSession } = props
      const sid = sessionId ?? selectSessionId(useSession)
      const running = selectRunning(useSession) ?? false
      const entry = useSyncExternalStore(
        subscribeProgress,
        () => readProgress(sid),
        () => readProgress(sid),
      )
      const feed = useFeed(ctx)

      if (running) {
        // 闲了、没汇报过、或者已经收尾，就不占位置。
        if (entry === null || entry.phase === 'done') return null
        const meta = PHASES[entry.phase] ?? PHASES.working
        return h(
          'div',
          { className: `dpg-strip dpg-strip--${meta.tone}`, title: entry.summary },
          h('span', { className: 'dpg-strip-dot' }),
          h('span', { className: 'dpg-strip-label' }, meta.label),
          h('span', { className: 'dpg-strip-text' }, entry.summary),
          entry.next === '' ? null : h('span', { className: 'dpg-strip-next', title: `下一步：${entry.next}` }, `下一步：${entry.next}`),
        )
      }

      // 本会话空闲时，提醒别处还有活；不显示本会话自己（它就在眼前）。
      // 连会话 id 都拿不到时也无法把自己排除在外，宁可不显示，避免把当前会话算成“其他”。
      if (sid === undefined) return null
      const others = feed.entries.filter(
        (item) => item.id !== sid && (item.group === 'run' || item.group === 'wait'),
      )
      if (others.length === 0) return null

      const runningOthers = others.filter((item) => item.group === 'run').length
      const waitingOthers = others.length - runningOthers
      const parts = []
      if (runningOthers > 0) parts.push(`${runningOthers} 个运行中`)
      if (waitingOthers > 0) parts.push(`${waitingOthers} 个等你确认`)
      const names = others.map((item) => item.title).join('、')

      return h(
        'div',
        { className: 'dpg-strip dpg-strip--other', title: `其他会话：${names}` },
        h(Wave, { live: runningOthers > 0, size: 14 }),
        h('span', { className: 'dpg-strip-label' }, '其他会话'),
        h('span', { className: 'dpg-strip-text' }, parts.join(' · ')),
      )
    }

    /* ---------------- C/D：会话列表 ---------------- */

    /** 侧栏图标的数据：只算「有没有人等我 / 有没有在跑」，不跑整条 feed。 */
    function usePulse(ctx) {
      const sessions = useSource(ctx.sessions.list)
      const statuses = useSource(ctx.uiSession.sessionStatus)
      const workspaces = useSource(ctx.workspaces.list)
      return useMemo(() => {
        const archived = toSet(workspaces?.archivedSessionIds)
        let wait = 0
        let run = 0
        for (const id of sessions?.ids ?? []) {
          const row = sessions.byId?.[id]
          if (row === undefined || row.blank === true || row.origin === 'subagent') continue
          if (archived.has(id)) continue
          const status = statuses?.get?.(id) ?? statuses?.[id]
          if (status?.pendingInteraction != null) wait += 1
          else if (row.running === true || status?.running === true) run += 1
        }
        return { wait, run }
      }, [sessions, statuses, workspaces])
    }

    /**
     * 侧栏导航图标：波形。侧栏只传 `{ size, active }`，不给数据，
     * 所以这里只画形状——数量在中间面板与标题栏计数片里体现。
     */
    function PanelIcon(props) {
      const { ctx } = props
      const size = typeof props.size === 'number' ? props.size : 18
      const pulse = usePulse(ctx)
      // 侧栏把 icon 当行的直接子节点来排版，外面套 span 会把图标顶出行基线（官方注释同样提醒过），
      // 所以「有人等你」的琥珀点画在 svg 里，而不是另起一个绝对定位元素。
      return h(
        'svg',
        {
          className: 'rs-glyph',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          'aria-hidden': 'true',
          style: { width: size, height: size, display: 'block' },
        },
        h('path', { d: WAVE }),
        pulse.wait > 0 ? h('circle', { className: 'rs-sidedot', cx: 20.4, cy: 3.6, r: 2.7 }) : null,
      )
    }

    function Row(props) {
      const { entry, now, onOpen } = props
      const subtitle = subtitleOf(entry)
      return h(
        'button',
        {
          type: 'button',
          className: 'rs-row',
          'data-group': entry.group,
          onClick: () => onOpen(entry.id),
          title: entry.title,
        },
        entry.group === 'wait'
          ? h('span', { className: 'rs-tag' }, '待确认')
          : entry.group === 'run'
            ? h(Spinner, null)
            : h('span', { className: 'rs-dot' }),
        h(
          'span',
          { className: 'rs-main' },
          h('span', { className: 'rs-title' }, entry.title),
          h('span', { className: 'rs-sub', title: subtitle }, subtitle),
        ),
        h('span', { className: 'rs-time' }, entry.updatedAt > 0 ? relativeTime(entry.updatedAt, now) : '—'),
      )
    }

    /** 分组列表：浮层与整页面板共用。 */
    function Groups(props) {
      const { feed, filter, onOpen } = props
      const visible = filter === 'all' ? feed.entries : feed.entries.filter((entry) => entry.group === filter)
      if (visible.length === 0) return h('div', { className: 'rs-blank' }, '这里没有会话')
      return h(
        React.Fragment,
        null,
        ...['wait', 'run', 'done'].map((group) => {
          const rows = visible.filter((entry) => entry.group === group)
          if (rows.length === 0) return null
          return h(
            'div',
            { key: group, className: 'rs-sec' },
            h(
              'div',
              { className: 'rs-group' },
              h('span', null, GROUP_LABEL[group]),
              h('span', { className: 'rs-line' }),
              h('i', { className: 'rs-count' }, String(rows.length)),
            ),
            ...rows.map((entry) => h(Row, { key: entry.id, entry, now: feed.now, onOpen })),
          )
        }),
      )
    }

    function Chips(props) {
      const { counts, filter, onFilter } = props
      return h(
        'div',
        { className: 'rs-chips' },
        ...FILTERS.map((item) =>
          h(
            'button',
            {
              type: 'button',
              key: item.id,
              className: 'rs-chip',
              'data-on': filter === item.id ? '' : undefined,
              onClick: () => onFilter(item.id),
            },
            item.label,
            h('span', { className: 'rs-n' }, String(counts[item.id])),
          ),
        ),
      )
    }

    function WindowFooter(props) {
      const { feed } = props
      return h(
        'div',
        { className: 'rs-foot' },
        h('span', null, `刚完成会话保留 ${feed.windowMinutes} 分钟`),
        h(
          'button',
          { type: 'button', className: 'rs-win', onClick: feed.cycleWindow, title: '切换时间窗口' },
          '切换',
        ),
      )
    }

    /* ---------------- 入口显示（不再是设置页） ---------------- */

    /**
     * 两个入口的开关，放在插件自己的界面里（标题栏弹层与整页列表各一处）。
     * 只存本浏览器；至少保留一个入口，否则连这块设置都找不到了。
     */
    function EntrySettings() {
      const entries = useEntries()
      const enabled = (entries.nav ? 1 : 0) + (entries.chip ? 1 : 0)
      const rows = [
        {
          key: 'nav',
          title: '侧栏「进行中」入口',
          hint: '左边栏的波形图标与整页列表。',
        },
        {
          key: 'chip',
          title: '标题栏计数片',
          hint: '会话标题右侧的计数与弹层。',
        },
      ]
      return h(
        'div',
        { className: 'rs-set' },
        h(
          'div',
          { className: 'rs-set-list' },
          ...rows.map((row) => {
            const on = entries[row.key] === true
            const locked = on && enabled === 1
            return h(
              'div',
              { className: 'rs-set-row', key: row.key },
              h(
                'div',
                { className: 'rs-set-copy' },
                h('div', { className: 'rs-set-title' }, row.title),
                h('div', { className: 'rs-set-sub' }, row.hint),
              ),
              h('button', {
                type: 'button',
                className: 'rs-switch',
                role: 'switch',
                'aria-checked': on ? 'true' : 'false',
                'aria-label': row.title,
                disabled: locked,
                title: locked ? '至少保留一个入口' : on ? '已开启，点击关闭' : '已关闭，点击开启',
                onClick: () => setEntry(row.key, !on),
              }),
            )
          }),
        ),
        h('div', { className: 'rs-set-note' }, '只保存在这台浏览器；两个入口至少保留一个。'),
      )
    }

    /** 用原生 details 做折叠，不额外占一个 React state。 */
    function EntryDisclosure(props) {
      return h(
        'details',
        { className: `rs-setd ${props.className ?? ''}` },
        h('summary', { className: 'rs-setd-sum' }, '入口显示'),
        h(EntrySettings, null),
      )
    }

    /* ---------------- D：标题栏计数片 + 弹层 ---------------- */

    function HeaderChip(props) {
      const { ctx } = props
      const feed = useFeed(ctx)
      const [open, setOpen] = useState(false)
      const [filter, setFilter] = useState('all')
      const anchorRef = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onDown = (event) => {
          if (anchorRef.current !== null && anchorRef.current.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown)
        }
      }, [open])

      const openSession = useCallback(
        (id) => {
          setOpen(false)
          ctx.uiWorkspace.openSession(id)
        },
        [ctx],
      )

      const { counts } = feed
      const idle = counts.run === 0 && counts.wait === 0

      const trigger = h(
        'button',
        {
          type: 'button',
          className: 'rs-trigger',
          'data-idle': idle ? '' : undefined,
          'data-open': open ? '' : undefined,
          'aria-expanded': open,
          'aria-label':
            counts.run > 0 || counts.wait > 0
              ? `进行中的会话：${counts.run} 个运行中${counts.wait > 0 ? `，${counts.wait} 个待确认` : ''}`
              : '进行中的会话：暂无',
          title: counts.all > 0 ? `${counts.all} 个会话有动静` : '暂无进行中的会话',
          onClick: () => setOpen((value) => !value),
        },
        idle ? h(Wave, { live: false, size: 16 }) : h(Wave, { size: 18 }),
        idle ? h('span', { className: 'rs-now' }, '无进行中') : null,
        counts.run > 0
          ? h(
              React.Fragment,
              null,
              h('span', { className: 'rs-now' }, String(counts.run)),
              h('span', { className: 'rs-lbl' }, '运行中'),
            )
          : null,
        counts.wait > 0 && counts.run > 0 ? h('span', { className: 'rs-tsep' }) : null,
        counts.wait > 0
          ? h(
              'span',
              { className: 'rs-wait' },
              h('span', { className: 'rs-wdot' }),
              h('span', { className: 'rs-now' }, String(counts.wait)),
              h('span', { className: 'rs-lbl' }, '待确认'),
            )
          : null,
      )

      const popover = open
        ? h(
            'div',
            { className: 'rs-pop', role: 'dialog', 'aria-label': '进行中的会话' },
            h('div', { className: 'rs-grab' }),
            h(
              'div',
              { className: 'rs-pophead' },
              h('span', { className: 'rs-h' }, '进行中'),
              h('span', { className: 'rs-meta' }, `${counts.all} 个${feed.workspaceCount > 0 ? ` · ${feed.workspaceCount} 个工作区` : ''}`),
              h(
                'button',
                { type: 'button', className: 'rs-x', 'aria-label': '关闭', onClick: () => setOpen(false) },
                '✕',
              ),
            ),
            h(Chips, { counts, filter, onFilter: setFilter }),
            h('div', { className: 'rs-list' }, h(Groups, { feed, filter, onOpen: openSession })),
            h(EntryDisclosure, { className: 'rs-setd--pop' }),
            h(WindowFooter, { feed }),
          )
        : null

      return h(
        'span',
        { className: 'rs-root rs-anchor', ref: anchorRef },
        trigger,
        ...(open ? [h('div', { key: 'scrim', className: 'rs-scrim', onClick: () => setOpen(false) }), popover] : []),
      )
    }

    /* ---------------- C：整页面板 ---------------- */

    function MainPanel(props) {
      const { ctx } = props
      const feed = useFeed(ctx)
      const [filter, setFilter] = useState('all')
      const openSession = useCallback((id) => ctx.uiWorkspace.openSession(id), [ctx])
      return h(
        'div',
        { className: 'rs-root rs-page' },
        h(
          'div',
          { className: 'rs-pagescroll' },
          h(
            'div',
            { className: 'rs-pagecontent' },
            h(
              'div',
              { className: 'rs-pagehead' },
              h('h1', null, '进行中的会话'),
              h(
                'span',
                { className: 'rs-meta' },
                `${feed.counts.all} 个${feed.workspaceCount > 0 ? ` · ${feed.workspaceCount} 个工作区` : ''}`,
              ),
              h(Chips, { counts: feed.counts, filter, onFilter: setFilter }),
            ),
            feed.counts.all === 0
              ? h('div', { className: 'rs-empty' }, '没有进行中的会话。开始一个任务后，这里会跨工作区汇总所有正在跑和等你的会话。')
              : h(Groups, { feed, filter, onOpen: openSession }),
            h(WindowFooter, { feed }),
            h(EntryDisclosure, { className: 'rs-setd--page' }),
          ),
        ),
      )
    }

    /* ---------------- 分组与筛选常量 ---------------- */

    const GROUP_LABEL = { wait: '待我处理', run: '运行中', done: '刚完成' }
    const GROUP_ORDER = { wait: 0, run: 1, done: 2 }
    const FILTERS = [
      { id: 'all', label: '全部' },
      { id: 'wait', label: '待我处理' },
      { id: 'run', label: '运行中' },
      { id: 'done', label: '刚完成' },
    ]

    /* ---------------- 样式 ---------------- */

    const CSS = `
/* ===== 进展卡片 / 活动条 ===== */
.dpg-card{--dpg-tone:var(--dsw-alias-brand-primary);margin:2px 0;padding:8px 10px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dpg-tone);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font:400 13px/1.5 var(--dsw-font-family,system-ui,-apple-system,"PingFang SC",sans-serif)}
.dpg-card--warn{--dpg-tone:var(--dsw-alias-state-warn-primary)}
.dpg-card--error{--dpg-tone:var(--dsw-alias-state-error-primary)}
.dpg-card--success{--dpg-tone:var(--dsw-alias-state-success-primary)}
.dpg-card--pending{opacity:.6;display:flex;align-items:center;gap:7px}
.dpg-head{display:flex;align-items:baseline;gap:7px;min-width:0}
.dpg-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dpg-tone);align-self:center}
.dpg-title{flex:none;font-weight:600;font-size:12px;color:var(--dpg-tone);letter-spacing:.02em}
.dpg-summary{min-width:0;overflow-wrap:anywhere}
.dpg-detail{margin-top:5px;padding-left:14px;font-size:12px;color:var(--dsw-alias-label-secondary);
  white-space:pre-wrap;overflow-wrap:anywhere}
.dpg-next{margin-top:5px;padding-left:14px;font-size:12px;color:var(--dsw-alias-label-secondary);
  overflow-wrap:anywhere}
.dpg-next-key{margin-right:6px;font-weight:500;color:var(--dsw-alias-label-primary)}

.dpg-strip{--dpg-tone:var(--dsw-alias-brand-primary);box-sizing:border-box;display:flex;align-items:baseline;gap:7px;
  width:calc(100% - 2 * var(--dsh-composer-side-clearance, 16px) - 4 * var(--dsh-composer-dock-inset, 8px));
  max-width:calc(var(--dsh-composer-card-max-width, 100%) - 4 * var(--dsh-composer-dock-inset, 8px));
  margin:0 auto 6px;padding:5px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  font:400 12px/1.45 var(--dsw-font-family,system-ui,-apple-system,"PingFang SC",sans-serif);
  white-space:nowrap;overflow:hidden}
.dpg-strip--warn{--dpg-tone:var(--dsw-alias-state-warn-primary)}
.dpg-strip--error{--dpg-tone:var(--dsw-alias-state-error-primary)}
.dpg-strip--other{--dpg-tone:var(--dsw-alias-label-tertiary)}
.dpg-strip--other .dpg-strip-label{color:var(--dsw-alias-label-tertiary)}
.dpg-strip-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dpg-tone);align-self:center}
.dpg-strip-label{flex:none;font-weight:600;color:var(--dpg-tone)}
.dpg-strip-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dpg-strip-next{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis}
.dpg-strip--other .dpg-strip-text{color:var(--dsw-alias-label-secondary)}
.dpg-strip--other .rs-glyph{flex:none;align-self:center;color:var(--dpg-tone)}

/* ===== 会话列表 ===== */
.rs-root{--rs-title:12.5px;--rs-sub:11px;--rs-time:10.5px;--rs-gap:9px;--rs-pad:9px 10px;
  color:var(--dsw-alias-label-primary);font:400 13px/1.45 var(--dsw-font-family,system-ui,-apple-system,"PingFang SC",sans-serif)}
.rs-sidedot{fill:var(--dsw-alias-state-warn-primary);stroke:none}
.rs-glyph{stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}

.rs-row{display:flex;align-items:flex-start;gap:var(--rs-gap);padding:var(--rs-pad);border-radius:8px;
  cursor:pointer;background:transparent;border:0;width:100%;text-align:left;color:inherit;font-family:inherit}
.rs-row:hover,.rs-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.rs-main{min-width:0;flex:1}
.rs-title{font-size:var(--rs-title);font-weight:550;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.rs-row[data-group=done] .rs-title{color:var(--dsw-alias-label-secondary);font-weight:450}
.rs-sub{font-size:var(--rs-sub);line-height:1.4;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;margin-top:1px}
.rs-time{font-size:var(--rs-time);color:var(--dsw-alias-label-tertiary);flex:none;padding-top:2px;
  font-variant-numeric:tabular-nums}
.rs-tag{font-size:10px;line-height:15px;padding:0 5px;border-radius:5px;font-weight:650;flex:none;margin-top:1px;
  white-space:nowrap;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label)}
.rs-dot{width:7px;height:7px;border-radius:50%;flex:none;margin-top:5px;background:var(--dsw-alias-state-success-primary)}
.rs-spin{width:15px;height:15px;flex:none;margin-top:1px;color:var(--dsw-alias-label-tertiary);
  animation:rs-rot 1.5s linear infinite}
.rs-spin circle{fill:none;stroke:currentColor;stroke-width:2}
.rs-spin .rs-arc{stroke-dasharray:13 42;stroke-linecap:round}
@keyframes rs-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.rs-spin{animation:none}}

.rs-group{display:flex;align-items:center;gap:7px;padding:1px 8px 3px;font-size:10px;font-weight:700;
  color:var(--dsw-alias-label-tertiary);letter-spacing:.08em}
.rs-group .rs-line{flex:1;height:1px;background:var(--dsw-alias-border-l1)}
.rs-group .rs-count{font-style:normal;font-variant-numeric:tabular-nums}
.rs-sec{padding:8px 6px 1px}

.rs-chips{display:flex;gap:6px;flex-wrap:wrap}
.rs-chip{font:inherit;font-size:11px;line-height:1.45;padding:3px 9px;border-radius:11px;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);
  background:transparent;cursor:pointer;white-space:nowrap}
.rs-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rs-chip[data-on]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:transparent}
.rs-chip .rs-n{font-variant-numeric:tabular-nums;opacity:.6;margin-left:3px}
.rs-chip[data-on] .rs-n{opacity:.8}

.rs-anchor{position:relative;display:inline-flex}
.rs-trigger{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 10px 0 8px;border-radius:14px;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;
  font-variant-numeric:tabular-nums;transition:background .15s,color .15s}
.rs-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rs-trigger[data-open]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rs-trigger[data-idle]{color:var(--dsw-alias-label-tertiary);font-weight:500;border-style:dashed}
.rs-trigger svg{flex:none;display:block}
.rs-trigger .rs-tsep{width:1px;height:12px;background:var(--dsw-alias-border-l2);flex:none}
.rs-trigger .rs-wait{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-state-warn-label);font-weight:700}
.rs-trigger .rs-now,.rs-trigger .rs-wnum{font-variant-numeric:tabular-nums}
.rs-trigger .rs-lbl{margin-left:3px}
.rs-trigger[data-idle] .rs-lbl{margin-left:0}
.rs-trigger .rs-wdot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:none}
.rs-wave{overflow:visible}
.rs-wave .rs-trail{opacity:.5}
.rs-wave .rs-live{stroke-dasharray:7 30;animation:rs-flow 1.6s linear infinite}
@keyframes rs-flow{to{stroke-dashoffset:-37}}
@media (prefers-reduced-motion:reduce){.rs-wave .rs-live{animation:none}}
.rs-pop{position:absolute;top:calc(100% + 8px);right:0;width:352px;max-height:min(64vh,560px);z-index:40;
  display:flex;flex-direction:column;overflow:hidden;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent)}
.rs-pophead{display:flex;align-items:center;gap:8px;padding:11px 12px 8px}
.rs-pophead .rs-h{font-size:13px;font-weight:700}
.rs-pophead .rs-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.rs-x{margin-left:auto;width:24px;height:24px;border:0;border-radius:12px;background:transparent;
  color:var(--dsw-alias-label-tertiary);cursor:pointer;display:grid;place-items:center;font-size:13px;line-height:1;padding:0}
.rs-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rs-pop .rs-chips{padding:0 12px 8px}
.rs-list{overflow:auto;padding:0 6px 6px;flex:1;min-height:0}
.rs-foot{display:flex;align-items:center;gap:6px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1);
  font-size:10.5px;color:var(--dsw-alias-label-tertiary);flex:none}
.rs-win{margin-left:auto;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;
  border-radius:9px;padding:2px 7px;font:inherit;font-size:10.5px;cursor:pointer}
.rs-win:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rs-blank{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.rs-scrim{position:fixed;inset:0;z-index:39;background:transparent}

/* ===== 整页面板 ===== */
.rs-page{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;background:var(--dsw-alias-bg-base);width:100%}
.rs-pagescroll{flex:1;min-height:0;overflow:auto;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}
.rs-pagecontent{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
.rs-pagehead{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:28px 0 0;margin-bottom:18px}
[data-platform=darwin] .rs-pagehead{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.rs-pagehead h1{margin:0;font-size:20px;font-weight:500;line-height:28px}
.rs-pagehead .rs-meta{font-size:13px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.rs-pagehead .rs-chips{margin-left:auto}
.rs-pagesec{padding:18px 0 4px;border-top:.5px solid var(--dsw-alias-border-l1)}
.rs-pagesec:first-of-type{border-top:0}
.rs-pagesec>.rs-group{padding:0 8px 6px}
.rs-pagesec .rs-row{padding:9px 8px}
.rs-page .rs-title{font-size:14px;font-weight:500}
.rs-page .rs-sub{font-size:12px}
.rs-page .rs-time{font-size:11.5px}
.rs-page .rs-empty{padding:56px 8px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}

/* ===== 入口显示（插件内，不占设置页） ===== */
.rs-setd{flex:none;border-top:1px solid var(--dsw-alias-border-l1);padding:0 12px}
.rs-setd-sum{list-style:none;cursor:pointer;display:flex;align-items:center;gap:5px;padding:7px 0;
  font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.rs-setd-sum::-webkit-details-marker{display:none}
.rs-setd-sum::after{content:"展开";margin-left:auto;font-size:10.5px}
.rs-setd[open] .rs-setd-sum::after{content:"收起"}
.rs-set{padding:0 0 10px}
.rs-set-list{display:flex;flex-direction:column;gap:6px}
.rs-set-row{display:flex;align-items:center;gap:14px;padding:8px 10px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l1,transparent)}
.rs-set-copy{flex:1;min-width:0}
.rs-set-title{font-size:12px;font-weight:550;color:var(--dsw-alias-label-primary)}
.rs-set-sub{margin-top:2px;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}
.rs-switch{position:relative;flex:none;width:40px;height:23px;border-radius:12px;border:0;padding:0;cursor:pointer;
  background:var(--dsw-alias-border-l3,#c9ccd4);transition:background .16s}
.rs-switch[aria-checked=true]{background:var(--dsw-alias-label-primary,#1c1d21)}
.rs-switch:disabled{opacity:.55;cursor:not-allowed}
.rs-switch::after{content:"";position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;
  background:var(--dsw-alias-bg-base,#fff);box-shadow:0 1px 2px rgba(0,0,0,.28);
  border:1px solid var(--dsw-alias-border-l2,transparent);transition:transform .16s}
.rs-switch[aria-checked=true]::after{transform:translateX(17px)}
.rs-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a6cf7);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.rs-switch,.rs-switch::after{transition:none}}
.rs-set-note{margin-top:8px;font-size:10.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}
.rs-setd--page{border-top:0;padding:8px 0 0;margin-top:6px}
.rs-setd--page .rs-set{max-width:640px}

/* ===== 移动端：弹层改为底部抽屉 ===== */
@media (max-width:560px){
  .rs-trigger .rs-lbl,.rs-trigger .rs-wtxt{display:none}
  .rs-trigger{padding:0 8px;gap:5px}
}
@media (max-width:640px){
  .rs-trigger{height:26px;padding:0 8px;font-size:11.5px;gap:6px}
  .rs-scrim{background:var(--dsw-alias-bg-mask-1)}
  .rs-pop{position:fixed;left:0;right:0;bottom:0;top:auto;width:auto;border-radius:16px 16px 0 0;
    border-bottom:0;max-height:min(72vh,620px);z-index:41;padding-bottom:env(safe-area-inset-bottom)}
  .rs-grab{width:34px;height:4px;border-radius:2px;background:var(--dsw-alias-border-l3);margin:7px auto 0;flex:none}
  .rs-row{padding:11px 10px}
  .rs-title{font-size:13px}
}
`

    /* ---------------- 挂载 ---------------- */

    function apply(ctx) {
      ctx.effect(() => {
        const previous = document.getElementById(STYLE_ID)
        if (previous?.parentNode) previous.parentNode.removeChild(previous)
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.parentNode?.removeChild(style)
      }, 'dsh-progress: styles')

      // 入口组件都要读 ctx 里的服务；注册时闭包捕获，不把 ctx 塞进 props。
      const withCtx = (View) => function ProgressEntry(props) {
        return h(View, { ...props, ctx })
      }

      // A：keyed 槽位，命中 report_progress 时替换掉通用工具行。
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME }, ProgressCard),
      )

      // B：list 槽位，插在输入框上方最前面（todo 面板是 0，这里 5）。
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'progress',
            order: 5,
            inject: (sessionId) => ({ sessionId }),
          },
          withCtx(ComposerDock),
        ),
      )

      /**
       * 按开关挂载一个入口：开启时注册，关闭时注销。
       * inject 的 effect 归本插件 fiber，卸载时一并清掉。
       */
      const mountEntry = (slotKey, options, View, toggleKey) => {
        ctx.slots.inject(slotKey, () => {
          let dispose = null
          const sync = () => {
            const want = entrySnapshot[toggleKey] === true
            if (want && dispose === null) {
              dispose = ctx.slots.register(options, View)
            } else if (!want && dispose !== null) {
              dispose()
              dispose = null
            }
          }
          const unsubscribe = subscribeEntries(sync)
          sync()
          return () => {
            unsubscribe()
            if (dispose !== null) {
              dispose()
              dispose = null
            }
          }
        })
      }

      // C：侧栏导航行 + 它的整页面板，一起受「侧栏入口」开关控制。
      mountEntry(
        'sidebar.panellist',
        { name: 'sidebar.panellist', id: PANEL_ID, order: -5, label: () => '进行中' },
        withCtx(PanelIcon),
        'nav',
      )
      mountEntry('main', { name: 'main', key: PANEL_ID }, withCtx(MainPanel), 'nav')

      // D：会话标题行右侧的计数片 + 弹层，受「标题栏计数片」开关控制。
      mountEntry(
        'conversation.session.header.utilities',
        { name: 'conversation.session.header.utilities', id: 'running-sessions', order: 10 },
        withCtx(HeaderChip),
        'chip',
      )
    }

    return {
      inject: ['slots', 'sessions', 'uiSession', 'workspaces', 'uiWorkspace'],
      apply,
    }
  },
})
