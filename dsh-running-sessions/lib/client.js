// Browser half. 纯工厂函数：无构建、无第二份 React。
// 契约：load.id == package.json name == cordis.patch.yml insert.id
//
// 两个入口，都按 design/mockup.html 的规格实现：
//   A 侧栏导航行（sidebar.panellist）+ 中间面板（main）
//   B 会话标题栏里的计数片（conversation.session.header.utilities），点开浮层
// 不再有贴住右下角的悬浮胶囊（移动端会挡住按钮）。
window.__ModuleLoader__.load({
  id: 'dsh-running-sessions',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useSyncExternalStore } = React

    const STYLE_ID = 'dsh-running-sessions/style'
    const WINDOW_KEY = 'dsh-running-sessions.window'
    const PANEL_ID = 'running-sessions'
    /** 两个入口各自独立的开关（localStorage），键名分开，互不影响。 */
    const ENTRY_KEYS = {
      nav: 'dsh-running-sessions.entry.nav',
      chip: 'dsh-running-sessions.entry.chip',
    }
    const MINUTE = 60_000
    const WINDOW_CHOICES = [15, 30, 60, 120]
    /** 默认窗口：来自 cordis.patch.yml 的 activeWindowMinutes，被 localStorage 覆盖。 */
    let configWindow = 30

    /** 图标路径：波形。"正在活动"里唯一不歧义的形状，18px 仍清楚。 */
    const WAVE = 'M2.2 12h3.9l2.3-6.6 4 13 2.2-6.4h5.2'

    const CSS = `
.rs-root{--rs-title:12.5px;--rs-sub:11px;--rs-time:10.5px;--rs-gap:9px;--rs-pad:9px 10px;
  color:var(--dsw-alias-label-primary);font:400 13px/1.45 var(--dsw-font-family,system-ui,-apple-system,"PingFang SC",sans-serif)}
.rs-sidedot{fill:var(--dsw-alias-state-warn-primary);stroke:none}
.rs-glyph{stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}

/* ---------- 行 ---------- */
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

/* ---------- 分组 ---------- */
.rs-group{display:flex;align-items:center;gap:7px;padding:1px 8px 3px;font-size:10px;font-weight:700;
  color:var(--dsw-alias-label-tertiary);letter-spacing:.08em}
.rs-group .rs-line{flex:1;height:1px;background:var(--dsw-alias-border-l1)}
.rs-group .rs-count{font-style:normal;font-variant-numeric:tabular-nums}
.rs-sec{padding:8px 6px 1px}

/* ---------- 筛选片 ---------- */
.rs-chips{display:flex;gap:6px;flex-wrap:wrap}
.rs-chip{font:inherit;font-size:11px;line-height:1.45;padding:3px 9px;border-radius:11px;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);
  background:transparent;cursor:pointer;white-space:nowrap}
.rs-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rs-chip[data-on]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:transparent}
.rs-chip .rs-n{font-variant-numeric:tabular-nums;opacity:.6;margin-left:3px}
.rs-chip[data-on] .rs-n{opacity:.8}

/* ---------- 浮层（标题栏计数片 + 弹层） ---------- */
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

/* ---------- 中间面板（main 槽位，整页） ---------- */
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

/* ---------- 设置页：两个入口的独立开关 ---------- */
.rs-set{max-width:640px;padding:2px 0 8px}
.rs-set-head h2{margin:0 0 6px;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.rs-set-head p{margin:0 0 14px;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.rs-set-list{display:flex;flex-direction:column;gap:8px}
.rs-set-row{display:flex;align-items:center;gap:16px;padding:12px 14px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l1,transparent)}
.rs-set-copy{flex:1;min-width:0}
.rs-set-title{font-size:13px;font-weight:550;color:var(--dsw-alias-label-primary)}
.rs-set-sub{margin-top:3px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
/* 轨道用 label-primary（浅色主题黑 / 深色主题白），旋钮用 bg-base 互为反色，两种主题都清楚。 */
.rs-switch{position:relative;flex:none;width:40px;height:23px;border-radius:12px;border:0;padding:0;cursor:pointer;
  background:var(--dsw-alias-border-l3,#c9ccd4);transition:background .16s}
.rs-switch[aria-checked=true]{background:var(--dsw-alias-label-primary,#1c1d21)}
.rs-switch::after{content:"";position:absolute;top:2.5px;left:2.5px;width:18px;height:18px;border-radius:50%;
  background:var(--dsw-alias-bg-base,#fff);box-shadow:0 1px 2px rgba(0,0,0,.28);
  border:1px solid var(--dsw-alias-border-l2,transparent);transition:transform .16s}
.rs-switch[aria-checked=true]::after{transform:translateX(17px)}
.rs-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a6cf7);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.rs-switch,.rs-switch::after{transition:none}}
.rs-set-note{margin-top:12px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}

/* ---------- 移动端：弹层改为底部抽屉 ---------- */
/* 窄屏：标题行空间紧张，计数片只留数字，靠 aria-label 说明 */
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

    const GROUP_LABEL = { wait: '待我处理', run: '运行中', done: '刚完成' }
    const GROUP_ORDER = { wait: 0, run: 1, done: 2 }
    const FILTERS = [
      { id: 'all', label: '全部' },
      { id: 'wait', label: '待我处理' },
      { id: 'run', label: '运行中' },
      { id: 'done', label: '刚完成' },
    ]

    /** 订阅任意 `{ getSnapshot, subscribe }` 数据源。 */
    function useSource(source) {
      const subscribe = useCallback((fn) => source.subscribe(fn), [source])
      const read = useCallback(() => source.getSnapshot(), [source])
      return useSyncExternalStore(subscribe, read, read)
    }

    function readWindow() {
      try {
        const stored = Number(window.localStorage.getItem(WINDOW_KEY))
        if (WINDOW_CHOICES.includes(stored)) return stored
      } catch {
        // 存储不可用时退回默认窗口
      }
      return WINDOW_CHOICES.includes(configWindow) ? configWindow : 30
    }

    /* ---------- 入口开关：两个键各存各的，默认都开 ---------- */
    function readEntry(key) {
      try {
        const raw = window.localStorage.getItem(ENTRY_KEYS[key])
        if (raw === '0') return false
        if (raw === '1') return true
      } catch {
        // 存储不可用时按默认开处理
      }
      return true
    }

    let entrySnapshot = { nav: readEntry('nav'), chip: readEntry('chip') }
    const entryListeners = new Set()

    function subscribeEntries(listener) {
      entryListeners.add(listener)
      return () => entryListeners.delete(listener)
    }

    function getEntrySnapshot() {
      return entrySnapshot
    }

    function setEntry(key, on) {
      entrySnapshot = { ...entrySnapshot, [key]: on }
      try {
        window.localStorage.setItem(ENTRY_KEYS[key], on ? '1' : '0')
      } catch {
        // 只影响持久化，不影响本次生效
      }
      for (const listener of entryListeners) listener()
    }

    function useEntries() {
      return useSyncExternalStore(subscribeEntries, getEntrySnapshot, getEntrySnapshot)
    }

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
      for (const view of workspaces?.items ?? []) {
        for (const sessionId of view.sessionIds ?? []) workspaceName.set(sessionId, view.title)
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
        const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : 0
        const fresh = now - updatedAt <= windowMs
        if (!pending && !running && !fresh) continue
        entries.push({
          id,
          title: row.displayTitle || String(id),
          group: pending ? 'wait' : running ? 'run' : 'done',
          updatedAt,
          workspace: workspaceName.get(id) ?? baseName(row.cwd),
        })
      }
      entries.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || b.updatedAt - a.updatedAt)
      const counts = { all: entries.length, wait: 0, run: 0, done: 0 }
      for (const entry of entries) counts[entry.group] += 1
      return { entries, counts }
    }

    /** 每行的第二行：工作区名 + 状态短语（设计稿的 `工作区 · 状态` 形态）。 */
    function subtitleOf(entry) {
      const where = entry.workspace
      const phrase = entry.group === 'wait' ? '等你确认' : entry.group === 'run' ? '正在执行' : '已完成'
      return where ? `${where} · ${phrase}` : phrase
    }

    /** 一次取数：所有入口共用同一套推导。 */
    function useFeed(ctx) {
      const sessions = useSource(ctx.sessions.list)
      const statuses = useSource(ctx.uiSession.sessionStatus)
      const workspaces = useSource(ctx.workspaces.list)
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
      const workspaceCount = useMemo(
        () => new Set(entries.map((entry) => entry.workspace).filter(Boolean)).size,
        [entries],
      )
      const cycleWindow = useCallback(() => {
        setWindowMinutes((current) => {
          const next = WINDOW_CHOICES[(WINDOW_CHOICES.indexOf(current) + 1) % WINDOW_CHOICES.length]
          try {
            window.localStorage.setItem(WINDOW_KEY, String(next))
          } catch {
            // 仅影响持久化
          }
          return next
        })
      }, [])
      return { entries, counts, workspaceCount, now, windowMinutes, cycleWindow }
    }

    function Wave(props) {
      const { live = true, size = 16 } = props
      const d = WAVE
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
        h('path', { className: 'rs-trail', d }),
        live ? h('path', { className: 'rs-live', d }) : h('path', { d }),
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
          h('span', { className: 'rs-sub' }, subtitleOf(entry)),
        ),
        h('span', { className: 'rs-time' }, entry.updatedAt > 0 ? relativeTime(entry.updatedAt, now) : ''),
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
        h('span', null, `非运行会话保留 ${feed.windowMinutes} 分钟`),
        h(
          'button',
          { type: 'button', className: 'rs-win', onClick: feed.cycleWindow, title: '切换时间窗口' },
          '切换',
        ),
      )
    }

    /**
     * B：标题栏计数片 + 弹层。
     * 放在会话标题行（眼睛停留的位置），不贴在屏幕角落。
     */
    function HeaderChip(props) {
      const { ctx } = props
      const feed = useFeed(ctx)
      const [open, setOpen] = useState(false)
      const [filter, setFilter] = useState('all')
      const anchorRef = React.useRef(null)

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

    /**
     * 设置页：两个入口各自的开关。
     * 开关只 control 该入口的注册/注销，另一个入口完全不受影响。
     */
    function SettingsPanel(props) {
      const { ctx } = props
      const entries = useEntries()
      const rows = [
        {
          key: 'nav',
          title: '侧栏「运行中」入口',
          sub: '左边栏里的波形图标与整页汇总面板。关掉后侧栏不再出现这一行。',
        },
        {
          key: 'chip',
          title: '标题栏「运行中」计数片',
          sub: '会话标题行右侧的计数片与浮层。关掉后只看得到侧栏入口。',
        },
      ]
      return h(
        'div',
        { className: 'rs-root rs-set' },
        h(
          'div',
          { className: 'rs-set-head' },
          h('h2', null, '入口开关'),
          h('p', null, '两个入口独立开关，互不影响，可以同时打开或同时关闭。选择只保存在这台浏览器上。'),
        ),
        h(
          'div',
          { className: 'rs-set-list' },
          ...rows.map((row) =>
            h(
              'div',
              { className: 'rs-set-row', key: row.key },
              h(
                'div',
                { className: 'rs-set-copy' },
                h('div', { className: 'rs-set-title' }, row.title),
                h('div', { className: 'rs-set-sub' }, row.sub),
              ),
              h('button', {
                type: 'button',
                className: 'rs-switch',
                role: 'switch',
                'aria-checked': entries[row.key] ? 'true' : 'false',
                'aria-label': row.title,
                title: entries[row.key] ? '已开启，点击关闭' : '已关闭，点击开启',
                onClick: () => setEntry(row.key, !entries[row.key]),
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'rs-set-note' },
          '提示：两个都关掉后，本插件在界面上完全不可见；这一页仍在「设置 → 进行中的会话」，随时可以重新打开。',
        ),
      )
    }

    /** A：中间面板（整页），侧栏导航行的目标。 */
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
          ),
        ),
      )
    }

    function apply(ctx, config) {
      const configured = Number(config?.activeWindowMinutes)
      if (WINDOW_CHOICES.includes(configured)) configWindow = configured

      ctx.effect(() => {
        const previous = document.getElementById(STYLE_ID)
        if (previous?.parentNode) previous.parentNode.removeChild(previous)
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.parentNode?.removeChild(style)
      }, 'dsh-running-sessions: styles')

      // 入口组件都需要 ctx 读服务；注册时闭包捕获，不把 ctx 塞进 props。
      const withCtx = (View) => function RunningSessionsEntry(props) {
        return h(View, { ...props, ctx })
      }

      /**
       * 按开关挂载一个入口：开启时注册，关闭时注销。
       * inject 的 effect 归本插件 fiber，卸载时一并清掉。
       */
      const mountEntry = (slotKey, options, View, toggleKey) => {
        ctx.slots.inject(slotKey, () => {
          let dispose = null
          const sync = () => {
            const want = readEntry(toggleKey)
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

      // A：侧栏导航行 + 它的整页面板，一起受「侧栏入口」开关控制。
      mountEntry(
        'sidebar.panellist',
        { name: 'sidebar.panellist', id: PANEL_ID, order: -5, label: () => '运行中' },
        withCtx(PanelIcon),
        'nav',
      )
      mountEntry('main', { name: 'main', key: PANEL_ID }, withCtx(MainPanel), 'nav')

      // B：会话标题行右侧的计数片 + 弹层，受「标题栏计数片」开关控制。
      mountEntry(
        'conversation.session.header.utilities',
        { name: 'conversation.session.header.utilities', id: 'running-sessions', order: 10 },
        withCtx(HeaderChip),
        'chip',
      )

      // 设置页：两个开关永远在（否则关掉入口后就找不到地方打开）。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'running-sessions', label: '进行中的会话', order: 92 },
          withCtx(SettingsPanel),
        ),
      )
    }

    return {
      inject: ['slots', 'sessions', 'uiSession', 'workspaces', 'uiWorkspace'],
      apply,
    }
  },
})
