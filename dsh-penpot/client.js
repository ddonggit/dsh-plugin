window.__ModuleLoader__.load({
  id: 'dsh-penpot',

  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'penpot'
    const API = '/plugins/dsh-penpot/api'
    const STATE_LABEL = {
      loading: '检查中',
      running: '可用',
      starting: '启动中',
      stopping: '停止中',
      stopped: '未启动',
      error: '异常',
    }

    const CSS = `
.dsh-penpot-panel{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsh-bg,#0f1115);color:var(--dsh-fg,#e7e9ee);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.dsh-penpot-bar{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid rgba(127,127,127,.22);background:linear-gradient(180deg,rgba(127,127,127,.08),transparent);flex:0 0 auto}
.dsh-penpot-brand{display:flex;align-items:center;gap:7px;font-weight:700;letter-spacing:.2px;white-space:nowrap}
.dsh-penpot-dot{width:8px;height:8px;border-radius:50%;background:#8b949e;box-shadow:0 0 0 3px rgba(139,148,158,.12)}
.dsh-penpot-dot.running{background:#3fb950;box-shadow:0 0 0 3px rgba(63,185,80,.14)}
.dsh-penpot-dot.starting,.dsh-penpot-dot.stopping{background:#d29922;box-shadow:0 0 0 3px rgba(210,153,34,.14);animation:dsh-penpot-pulse 1.4s ease-in-out infinite}
.dsh-penpot-dot.error{background:#f85149;box-shadow:0 0 0 3px rgba(248,81,73,.14)}
@keyframes dsh-penpot-pulse{50%{opacity:.35}}
.dsh-penpot-state{color:var(--dsh-muted,#9aa4b2);font-size:12px;white-space:nowrap}
.dsh-penpot-spacer{flex:1}
.dsh-penpot-btn{appearance:none;border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.10);color:inherit;border-radius:7px;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.dsh-penpot-btn:hover{background:rgba(127,127,127,.18)}
.dsh-penpot-btn:disabled{opacity:.45;cursor:default}
.dsh-penpot-btn.primary{background:#2f81f7;border-color:#2f81f7;color:#fff}
.dsh-penpot-btn.primary:hover{background:#4b8ff8}
.dsh-penpot-btn.danger{color:#ffb4ae;border-color:rgba(248,81,73,.35)}
.dsh-penpot-link{color:#6cb6ff;text-decoration:none;font-size:12px}
.dsh-penpot-link:hover{text-decoration:underline}
.dsh-penpot-body{flex:1;min-height:0;position:relative;display:flex;flex-direction:column}
.dsh-penpot-landing{flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:28px;overflow:auto}
.dsh-penpot-landing h2{font-size:20px;line-height:1.3;margin:0}
.dsh-penpot-landing p{margin:0;color:var(--dsh-muted,#9aa4b2);line-height:1.7;max-width:580px}
.dsh-penpot-url-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:100%}
.dsh-penpot-url{display:inline-block;max-width:100%;padding:7px 10px;border:1px solid rgba(127,127,127,.28);border-radius:7px;background:rgba(0,0,0,.16);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:#9ecbff}
.dsh-penpot-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto}
.dsh-penpot-card{width:min(560px,100%);border:1px solid rgba(127,127,127,.22);background:rgba(127,127,127,.06);border-radius:14px;padding:24px}
.dsh-penpot-card h1{font-size:19px;line-height:1.3;margin:0 0 8px}
.dsh-penpot-card p{margin:0 0 12px;color:var(--dsh-muted,#9aa4b2);line-height:1.65}
.dsh-penpot-card ul{margin:0 0 18px;padding-left:18px;color:var(--dsh-muted,#9aa4b2);line-height:1.75}
.dsh-penpot-card li b{color:var(--dsh-fg,#e7e9ee);font-weight:600}
.dsh-penpot-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsh-penpot-error{margin-top:12px;padding:10px 12px;border:1px solid rgba(248,81,73,.35);background:rgba(248,81,73,.08);border-radius:9px;color:#ffb4ae;white-space:pre-wrap;font-size:12px;max-height:180px;overflow:auto}
.dsh-penpot-logs{flex:0 0 auto;max-height:32%;overflow:auto;margin:0;padding:10px 12px;border-top:1px solid rgba(127,127,127,.22);background:#0b0d11;color:#b7c0cc;font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
.dsh-penpot-settings{display:grid;gap:9px;margin-top:12px;padding-top:12px;border-top:1px solid rgba(127,127,127,.18)}
.dsh-penpot-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-penpot-row label{min-width:84px;color:var(--dsh-muted,#9aa4b2);font-size:12px}
.dsh-penpot-input{flex:1;min-width:220px;border:1px solid rgba(127,127,127,.28);background:rgba(0,0,0,.16);color:inherit;border-radius:7px;padding:6px 9px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-penpot-note{color:var(--dsh-muted,#9aa4b2);font-size:12px;margin:0}
.dsh-penpot-ok{color:#3fb950;font-size:12px}
.dsh-penpot-settings-section{display:grid;gap:10px;padding:4px 0}
.dsh-penpot-settings-section h3{margin:0;font-size:14px}
.dsh-penpot-settings-section p{margin:0;color:var(--dsh-muted,#9aa4b2);font-size:12px;line-height:1.6}
`

    async function api(path, options) {
      const res = await fetch(`${API}${path}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...options,
      })
      const raw = await res.text()
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = { error: raw }
      }
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      return body
    }

    function post(path) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    }

    function formatUptime(ms) {
      if (!ms || ms < 0) return ''
      const mins = Math.floor(ms / 60000)
      if (mins < 1) return '刚刚启动'
      if (mins < 60) return `已运行 ${mins} 分钟`
      const hours = Math.floor(mins / 60)
      return `已运行 ${hours} 小时 ${mins % 60} 分钟`
    }

    function Icon({ size = 18 }) {
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 18.5z' }),
        React.createElement('path', { d: 'M8 7h8M8 11h5M8 15h7' }),
        React.createElement('path', { d: 'M17.8 13.2 20 15.4 17.4 18l-2.3-.1-.1-2.3z' }),
      )
    }

    function StateDot({ state }) {
      return React.createElement('span', { className: `dsh-penpot-dot ${state || ''}` })
    }

    function StatusBar({ status, busy, onStart, onStop, onRestart, onLogs, logsOpen, onRefresh }) {
      const state = status?.state || 'loading'
      const canStart = state === 'stopped' || state === 'error'
      const canStop = state === 'running' || state === 'starting'
      return React.createElement(
        'div',
        { className: 'dsh-penpot-bar' },
        React.createElement('span', { className: 'dsh-penpot-brand' }, React.createElement(Icon, null), 'Penpot 设计'),
        React.createElement(StateDot, { state }),
        React.createElement('span', { className: 'dsh-penpot-state' }, STATE_LABEL[state] || state),
        status?.uptimeMs && state === 'running'
          ? React.createElement('span', { className: 'dsh-penpot-state' }, formatUptime(status.uptimeMs))
          : null,
        React.createElement('span', { className: 'dsh-penpot-spacer' }),
        status?.publicUri
          ? React.createElement(
              'a',
              {
                className: 'dsh-penpot-link',
                href: status.publicUri,
                target: '_blank',
                rel: 'noreferrer',
                title: `在独立标签页打开（${status.publicUri}）`,
              },
              '新窗口',
            )
          : null,
        React.createElement(
          'button',
          { className: 'dsh-penpot-btn', onClick: onRefresh, disabled: busy === 'refresh', title: '刷新状态' },
          busy === 'refresh' ? '刷新中' : '刷新',
        ),
        canStart
          ? React.createElement(
              'button',
              { className: 'dsh-penpot-btn primary', onClick: onStart, disabled: Boolean(busy) },
              busy === 'start' ? '启动中…' : '启动 Penpot',
            )
          : null,
        canStop
          ? React.createElement(
              'button',
              { className: 'dsh-penpot-btn danger', onClick: onStop, disabled: Boolean(busy) },
              busy === 'stop' ? '停止中…' : '停止',
            )
          : null,
        state === 'running'
          ? React.createElement(
              'button',
              { className: 'dsh-penpot-btn', onClick: onRestart, disabled: Boolean(busy) },
              busy === 'restart' ? '重启中…' : '重启',
            )
          : null,
        React.createElement(
          'button',
          { className: 'dsh-penpot-btn', onClick: onLogs, disabled: busy === 'logs', title: '查看最近日志' },
          logsOpen ? '收起日志' : '日志',
        ),
      )
    }

    function EmptyState({ status, busy, error, onStart, onLogs }) {
      const state = status?.state || 'loading'
      return React.createElement(
        'div',
        { className: 'dsh-penpot-empty' },
        React.createElement(
          'div',
          { className: 'dsh-penpot-card' },
          React.createElement('h1', null, state === 'starting' ? 'Penpot 正在启动' : '用 Penpot 做可编辑海报'),
          React.createElement(
            'p',
            null,
            state === 'starting'
              ? '容器已开始启动，首次启动通常需要 1–3 分钟；状态变成“可用”后会出现打开地址。不要重复点启动。'
              : state === 'error'
                ? 'Penpot 没有正常就绪。先看日志定位问题，再点启动重试。'
                : '启动后在这个面板拿独立地址，用浏览器打开并登录 Penpot；AI 生成的是可编辑的文字、形状和渐变图层。',
          ),
          React.createElement(
            'ul',
            null,
            React.createElement('li', null, React.createElement('b', null, '海报/促销图：'), '文字、色块、价格、按钮都是原生图层，可继续改字改色。'),
            React.createElement('li', null, '导出 PNG 预览，或 SVG/PDF 交给 CorelDRAW 做印刷。'),
            React.createElement('li', null, '中文/印刷字体需在 Penpot 团队设置里上传；CMYK 和出血最后在 CorelDRAW 完成。'),
          ),
          React.createElement(
            'div',
            { className: 'dsh-penpot-actions' },
            React.createElement(
              'button',
              { className: 'dsh-penpot-btn primary', onClick: onStart, disabled: Boolean(busy) },
              busy === 'start' ? '启动中…' : state === 'error' ? '重试启动' : '启动 Penpot',
            ),
            React.createElement('button', { className: 'dsh-penpot-btn', onClick: onLogs }, '查看日志'),
            status?.publicUri
              ? React.createElement(
                  'a',
                  { className: 'dsh-penpot-link', href: status.publicUri, target: '_blank', rel: 'noreferrer' },
                  '已在运行？打开新窗口',
                )
              : null,
          ),
          error ? React.createElement('div', { className: 'dsh-penpot-error' }, error) : null,
        ),
      )
    }

    function PenpotPanel() {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [logs, setLogs] = useState(null)
      const [logsOpen, setLogsOpen] = useState(false)
      const [copied, setCopied] = useState(false)
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      const load = useCallback(async (quiet = false) => {
        if (!quiet) setBusy((value) => value || 'refresh')
        try {
          const next = await api('/status')
          if (!mounted.current) return
          setStatus(next)
          if (next.state === 'running') setError('')
        } catch (cause) {
          if (!mounted.current) return
          setStatus((current) => current || { state: 'error' })
          setError(String(cause?.message || cause))
        } finally {
          if (!quiet && mounted.current) setBusy('')
        }
      }, [])

      useEffect(() => {
        load(true)
        const timer = setInterval(() => load(true), 4000)
        return () => clearInterval(timer)
      }, [load])

      const run = useCallback(
        async (name, path) => {
          setBusy(name)
          setError('')
          try {
            await post(path)
            await load(true)
          } catch (cause) {
            setError(String(cause?.message || cause))
            await load(true)
          } finally {
            if (mounted.current) setBusy('')
          }
        },
        [load],
      )

      const toggleLogs = useCallback(async () => {
        if (logsOpen) {
          setLogsOpen(false)
          return
        }
        setBusy('logs')
        try {
          const res = await fetch(`${API}/logs?tail=200`, { cache: 'no-store', credentials: 'same-origin' })
          const text = await res.text()
          if (!res.ok) throw new Error(text || `HTTP ${res.status}`)
          setLogs(text)
          setLogsOpen(true)
        } catch (cause) {
          setError(String(cause?.message || cause))
        } finally {
          setBusy('')
        }
      }, [logsOpen])

      const copyUrl = useCallback(async () => {
        const url = status?.publicUri || ''
        if (!url) return
        try {
          await navigator.clipboard.writeText(url)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        } catch {
          setError('复制失败，请手动选中地址复制。')
        }
      }, [status?.publicUri])

      const state = status?.state || 'loading'
      const running = state === 'running'

      return React.createElement(
        'div',
        { className: 'dsh-penpot-panel' },
        React.createElement(StatusBar, {
          status,
          busy,
          onStart: () => run('start', '/start'),
          onStop: () => run('stop', '/stop'),
          onRestart: () => run('restart', '/restart'),
          onLogs: toggleLogs,
          logsOpen,
          onRefresh: () => load(false),
        }),
        React.createElement(
          'div',
          { className: 'dsh-penpot-body' },
          running
            ? React.createElement(
                'div',
                { className: 'dsh-penpot-landing' },
                React.createElement('h2', null, 'Penpot 已就绪'),
                React.createElement(
                  'p',
                  null,
                  '用户在浏览器里打开下面的地址，用 Penpot 账号手动登录即可。这个面板不再嵌入画布，也不经过 DSH 的登录 Cookie。',
                ),
                React.createElement(
                  'a',
                  {
                    className: 'dsh-penpot-btn primary',
                    href: status.publicUri,
                    target: '_blank',
                    rel: 'noreferrer',
                  },
                  '打开 Penpot',
                ),
                React.createElement(
                  'div',
                  { className: 'dsh-penpot-url-row' },
                  React.createElement('code', { className: 'dsh-penpot-url' }, status.publicUri),
                  React.createElement('button', { className: 'dsh-penpot-btn', onClick: copyUrl }, copied ? '已复制' : '复制地址'),
                ),
                React.createElement('p', { className: 'dsh-penpot-note' }, `本机直连：${status.localUrl || ''}`),
                React.createElement(
                  'p',
                  { className: 'dsh-penpot-note' },
                  status.mcpListening
                    ? 'MCP 端口正常；agent 用 127.0.0.1:4401 操作。'
                    : 'MCP 端口未监听，检查 penpot-mcp 容器日志。',
                ),
              )
            : React.createElement(EmptyState, {
                status,
                busy,
                error,
                onStart: () => run('start', '/start'),
                onLogs: toggleLogs,
              }),
          running && error
            ? React.createElement('div', { className: 'dsh-penpot-error', style: { margin: '10px 12px 0' } }, error)
            : null,
          logsOpen
            ? React.createElement('pre', { className: 'dsh-penpot-logs' }, logs || '（暂无日志）')
            : null,
        ),
      )
    }

    function PenpotSettings({ compact = false }) {
      const [form, setForm] = useState({ autoStart: true, publicUri: '', version: '', frontendPort: '', mcpPort: '' })
      const [state, setState] = useState('loading')
      const [message, setMessage] = useState('')
      const [error, setError] = useState('')

      const load = useCallback(async () => {
        try {
          const data = await api('/settings')
          setForm((current) => ({ ...current, ...data }))
          setState('ready')
        } catch (cause) {
          setError(String(cause?.message || cause))
          setState('error')
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const save = useCallback(async () => {
        setState('saving')
        setMessage('')
        setError('')
        try {
          const data = await api('/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autoStart: Boolean(form.autoStart), publicUri: form.publicUri }),
          })
          setState('ready')
          setMessage(data.restartRequired ? '已保存。公开地址变更需要重启 DSH 后生效。' : '已保存。')
        } catch (cause) {
          setState('ready')
          setError(String(cause?.message || cause))
        }
      }, [form.autoStart, form.publicUri])

      const content = React.createElement(
        React.Fragment,
        null,
        React.createElement('p', { className: 'dsh-penpot-note' }, compact
          ? 'Penpot 的启动方式和公开地址。'
          : '这些设置保存在本机，不会上传。端口的修改需要编辑插件配置并重启 DSH。'),
        React.createElement(
          'div',
          { className: 'dsh-penpot-row' },
          React.createElement('label', { htmlFor: 'dsh-penpot-autostart' }, '自动启动'),
          React.createElement('input', {
            id: 'dsh-penpot-autostart',
            type: 'checkbox',
            checked: Boolean(form.autoStart),
            onChange: (event) => setForm((current) => ({ ...current, autoStart: event.target.checked })),
          }),
          React.createElement('span', { className: 'dsh-penpot-note' }, 'DSH 启动时自动拉起 Penpot'),
        ),
        React.createElement(
          'div',
          { className: 'dsh-penpot-row' },
          React.createElement('label', { htmlFor: 'dsh-penpot-uri' }, '公开地址'),
          React.createElement('input', {
            id: 'dsh-penpot-uri',
            className: 'dsh-penpot-input',
            value: form.publicUri || '',
            placeholder: 'http://your-host:3300/',
            onChange: (event) => setForm((current) => ({ ...current, publicUri: event.target.value })),
          }),
        ),
        React.createElement(
          'p',
          { className: 'dsh-penpot-note' },
          `版本 ${form.version || '2.18.6'} · 前端直连端口 ${form.frontendPort || 3300} · MCP 端口 ${form.mcpPort || 4401}`,
        ),
        React.createElement(
          'div',
          { className: 'dsh-penpot-actions' },
          React.createElement(
            'button',
            { className: 'dsh-penpot-btn primary', onClick: save, disabled: state === 'saving' },
            state === 'saving' ? '保存中…' : '保存设置',
          ),
          React.createElement('button', { className: 'dsh-penpot-btn', onClick: load, disabled: state === 'saving' }, '重新读取'),
        ),
        error ? React.createElement('div', { className: 'dsh-penpot-error' }, error) : null,
        message ? React.createElement('div', { className: 'dsh-penpot-ok' }, message) : null,
      )

      if (compact) {
        return React.createElement(
          'div',
          { className: 'dsh-penpot-settings-section' },
          React.createElement('h3', null, 'Penpot 设计'),
          content,
        )
      }
      return React.createElement('div', { className: 'dsh-penpot-settings' }, content)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshPenpot = '1'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        })

        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, PenpotPanel),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 7, label: () => '设计' },
              Icon,
            ),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'dsh-penpot-settings', label: () => 'Penpot', order: 42 },
              PenpotSettings,
            ),
          ),
        )
      },
    }
  },
})