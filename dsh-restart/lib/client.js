// 浏览器半：设置页「服务与重启」。
// 契约：__ModuleLoader__.load.id == package.json name == cordis.patch.yml insert.id。
// 颜色直连 --dsw-alias-* 活 token（深色主题教训：不要在 :root 声明别名再引用）。
window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    let createPortal = null
    try {
      const dom = require('react-dom')
      if (dom && typeof dom.createPortal === 'function') createPortal = dom.createPortal
    } catch {}

    const SECTION = { id: 'dsh-restart', label: '服务与重启', order: 90 }
    const API_STATUS = '/api/dsh-restart/status'
    const API_RESTART = '/api/dsh-restart/restart'
    const STORAGE_KEY = 'dsh-restart:pending'
    const ACTIVE = ['queued', 'preflight', 'restarting', 'waiting']
    const RECENT_MS = 10 * 60 * 1000
    const RELOAD_DELAY_MS = 5000

    const STYLE_ID = 'dsh-restart/style'

    function modeLabel(info) {
      if (!info) return '—'
      if (info.mode === 'systemd') return 'systemd' + (info.manager === 'user' ? ' · user' : '')
      return '直接重启'
    }

    

    function diagCommand(info) {
      const unit = info && info.unit
      if (unit) return (info.manager === 'user' ? 'systemctl --user status ' : 'systemctl status ') + unit
      const dataDir = info && info.dataDir
      return dataDir ? 'tail -n 100 ' + dataDir + '/runner.log' : 'journalctl -n 100'
    }

    function endpointLabel(info) {
      if (!info || !info.port) return '—'
      const host = info.bindHost || ''
      return (host.indexOf(':') >= 0 ? '[' + host + ']' : host) + ':' + info.port
    }

    function addressLabel(info) {
      if (!info) return '—'
      return info.advertisedUrl || info.origin || endpointLabel(info)
    }

    const CSS = `
/* 暖灰底色 + 单一青黛强调色。浅色与暗色各自成对，避免冷蓝灰。 */
      .dshr-root,
      .dshr-mask {
        --dshr-card: #fbf9f4;
        --dshr-soft: #f3efe6;
        --dshr-sunk: #ebe5d9;
        --dshr-line: #e3dbcc;
        --dshr-line-strong: #d4c8b4;
        --dshr-text: #2b2620;
        --dshr-sub: #60584b;
        --dshr-mute: #776e60;
        --dshr-accent: #4c4665;
        --dshr-accent-hover: #3e3955;
        --dshr-on-accent: #fbf9f4;
        --dshr-ok: #2c7349;
        --dshr-err: #9c3b45;
        --dshr-warn: #7d5b1f;
        --dshr-radius: 12px;
        --dshr-radius-sm: 8px;
        --dshr-fs-title: 20px;
        --dshr-fs-body: 14px;
        --dshr-fs-small: 13px;
        --dshr-fs-meta: 12px;
        --dshr-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      body[data-ds-dark-theme] .dshr-root,
      body[data-ds-dark-theme] .dshr-mask {
        --dshr-card: #211f1c;
        --dshr-soft: #2b2823;
        --dshr-sunk: #181613;
        --dshr-line: #3b362d;
        --dshr-line-strong: #4d463a;
        --dshr-text: #f1ece3;
        --dshr-sub: #c3baab;
        --dshr-mute: #9c9384;
        --dshr-accent: #cfc6e6;
        --dshr-accent-hover: #ddd6ef;
        --dshr-on-accent: #241f2b;
        --dshr-ok: #82c99f;
        --dshr-err: #e4949b;
        --dshr-warn: #d8b673;
      }

      .dshr-root {
        display: flex;
        flex-direction: column;
        gap: 20px;
        max-width: 920px;
        padding: 4px 0 48px;
        color: var(--dshr-text);
        font-size: var(--dshr-fs-body);
        line-height: 1.6;
      }
      .dshr-root *,
      .dshr-mask *,
      .dshr-root *::before,
      .dshr-root *::after {
        box-sizing: border-box;
      }

      .dshr-head h1 {
        margin: 0;
        font-size: var(--dshr-fs-title);
        font-weight: 600;
        line-height: 1.3;
        letter-spacing: -0.01em;
      }
      .dshr-head p {
        margin: 6px 0 0;
        color: var(--dshr-sub);
        font-size: var(--dshr-fs-small);
      }

      .dshr-card {
        border: 1px solid var(--dshr-line);
        border-radius: var(--dshr-radius);
        background: var(--dshr-card);
      }

      /* 顶部状态 */
      .dshr-status {
        display: flex;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
        padding: 20px;
      }
      .dshr-statusLead {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        flex: 1 1 260px;
        min-width: 0;
      }
      .dshr-beacon {
        width: 10px;
        height: 10px;
        margin-top: 7px;
        border-radius: 50%;
        flex: 0 0 auto;
        background: var(--dshr-ok);
      }
      .dshr-beacon[data-tone="busy"] { background: var(--dshr-accent); }
      .dshr-beacon[data-tone="warn"] { background: var(--dshr-warn); }
      .dshr-beacon[data-tone="down"] { background: var(--dshr-err); }
      .dshr-statusTitle {
        font-size: var(--dshr-fs-title);
        font-weight: 600;
        line-height: 1.3;
        letter-spacing: -0.01em;
      }
      .dshr-statusMeta {
        margin-top: 2px;
        color: var(--dshr-sub);
        font-size: var(--dshr-fs-small);
      }
      .dshr-statusActions { flex: 0 0 auto; }

      /* 按钮：全页仅一种强调色，危险操作不铺红色 */
      .dshr-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 36px;
        padding: 0 14px;
        border: 1px solid var(--dshr-line-strong);
        border-radius: var(--dshr-radius-sm);
        background: var(--dshr-card);
        color: var(--dshr-text);
        font: inherit;
        font-size: var(--dshr-fs-small);
        font-weight: 500;
        white-space: nowrap;
        cursor: pointer;
        transition: background-color .15s ease, border-color .15s ease;
      }
      .dshr-btn:hover { background: var(--dshr-soft); }
      .dshr-btn:active { background: var(--dshr-sunk); }
      .dshr-btn:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 2px; }
      .dshr-btn:disabled { opacity: .5; cursor: not-allowed; }
      .dshr-btn:disabled:hover { background: var(--dshr-card); }
      .dshr-btnPrimary {
        border-color: transparent;
        background: var(--dshr-accent);
        color: var(--dshr-on-accent);
      }
      .dshr-btnPrimary:hover { background: var(--dshr-accent-hover); }
      .dshr-btnPrimary:active { background: var(--dshr-accent-hover); }
      .dshr-btnPrimary:disabled,
      .dshr-btnPrimary:disabled:hover {
        opacity: 1;
        border-color: var(--dshr-line);
        background: var(--dshr-sunk);
        color: var(--dshr-mute);
      }
      .dshr-btnGhost {
        border-color: transparent;
        background: transparent;
        color: var(--dshr-sub);
      }
      .dshr-btnGhost:hover { background: var(--dshr-soft); color: var(--dshr-text); }
      .dshr-btnGhost:disabled:hover { background: transparent; }
      .dshr-btnSm {
        height: 30px;
        padding: 0 10px;
        font-size: var(--dshr-fs-meta);
      }

      /* 提示条：中性底 + 细边，不铺大面积红/橙 */
      .dshr-callout {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 12px 14px;
        border: 1px solid var(--dshr-line);
        border-left: 3px solid var(--dshr-line-strong);
        border-radius: var(--dshr-radius-sm);
        background: var(--dshr-soft);
        color: var(--dshr-sub);
        font-size: var(--dshr-fs-small);
      }
      .dshr-callout[data-tone="err"] { border-left-color: var(--dshr-err); }
      .dshr-callout[data-tone="warn"] { border-left-color: var(--dshr-warn); }
      .dshr-callout[data-tone="busy"] { border-left-color: var(--dshr-accent); }
      .dshr-calloutTitle {
        color: var(--dshr-text);
        font-weight: 600;
      }
      .dshr-calloutBody { flex: 1; min-width: 0; }
      .dshr-calloutHint { margin-top: 2px; }
      .dshr-calloutActions {
        display: flex;
        gap: 8px;
        flex: 0 0 auto;
        align-self: center;
      }
      .dshr-callout .dshr-icon { color: var(--dshr-err); }
      .dshr-callout[data-tone="warn"] .dshr-icon { color: var(--dshr-warn); }
      .dshr-callout[data-tone="busy"] .dshr-icon { color: var(--dshr-accent); }

      /* 重启结果 / 进行中 */
      .dshr-run { padding: 16px 18px; }
      .dshr-runHead {
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }
      .dshr-runIcon {
        display: inline-flex;
        margin-top: 2px;
        color: var(--dshr-ok);
      }
      .dshr-runIcon[data-tone="busy"] { color: var(--dshr-accent); }
      .dshr-runIcon[data-tone="err"] { color: var(--dshr-err); }
      .dshr-runIcon[data-tone="warn"] { color: var(--dshr-warn); }
      .dshr-runText { min-width: 0; }
      .dshr-runTitle {
        font-size: var(--dshr-fs-body);
        font-weight: 600;
        line-height: 1.5;
      }
      .dshr-runMeta {
        margin-top: 2px;
        color: var(--dshr-sub);
        font-size: var(--dshr-fs-small);
      }
      .dshr-runActions { margin-left: auto; flex: 0 0 auto; }
      .dshr-runBody {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-top: 12px;
      }
      .dshr-runBody > p { margin: 0; }
      .dshr-runBody .dshr-hint { color: var(--dshr-sub); font-size: var(--dshr-fs-small); }
      .dshr-runBody .dshr-note { color: var(--dshr-sub); font-size: var(--dshr-fs-small); }

      /* 进度：一条连续的细线，不做嵌套卡片 */
      .dshr-steps {
        display: flex;
        margin: 12px 0 0;
        padding: 0;
        list-style: none;
      }
      .dshr-step {
        flex: 1 1 0;
        min-width: 0;
        padding: 10px 10px 0 0;
        border-top: 2px solid var(--dshr-line);
      }
      .dshr-step:last-child { padding-right: 0; }
      .dshr-step[data-state="done"] { border-color: var(--dshr-ok); }
      .dshr-step[data-state="active"] { border-color: var(--dshr-accent); }
      .dshr-step[data-state="failed"] { border-color: var(--dshr-err); }
      .dshr-stepTop {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--dshr-mute);
        font-size: var(--dshr-fs-meta);
      }
      .dshr-step[data-state="done"] .dshr-stepTop { color: var(--dshr-sub); }
      .dshr-step[data-state="active"] .dshr-stepTop { color: var(--dshr-text); }
      .dshr-step[data-state="failed"] .dshr-stepTop { color: var(--dshr-err); }
      .dshr-stepLabel {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      /* 键值行 */
      .dshr-rows {
        display: flex;
        flex-direction: column;
        margin: 0;
      }
      .dshr-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
        padding: 8px 0;
        border-top: 1px solid var(--dshr-line);
      }
      .dshr-row:first-child { border-top: 0; padding-top: 0; }
      .dshr-row:last-child { padding-bottom: 0; }
      .dshr-row dt {
        flex: 0 0 auto;
        color: var(--dshr-sub);
        font-size: var(--dshr-fs-small);
      }
      .dshr-row dd {
        margin: 0;
        min-width: 0;
        overflow: hidden;
        text-align: right;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--dshr-fs-small);
      }
      .dshr-row dd.mono {
        font-family: var(--dshr-mono);
        font-size: var(--dshr-fs-meta);
      }

      /* 面板 */
      .dshr-cols {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 16px;
        align-items: start;
      }
      .dshr-panel {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px 18px;
      }
      .dshr-panelHead {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
      }
      .dshr-panelHead h2 {
        margin: 0;
        font-size: var(--dshr-fs-body);
        font-weight: 600;
      }
      .dshr-panelHead span {
        color: var(--dshr-mute);
        font-size: var(--dshr-fs-meta);
      }

      /* 历史 */
      .dshr-history {
        display: flex;
        flex-direction: column;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .dshr-hrow {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 9px 0;
        border-top: 1px solid var(--dshr-line);
        font-size: var(--dshr-fs-small);
      }
      .dshr-hrow:first-child { border-top: 0; padding-top: 0; }
      .dshr-hrow:last-child { padding-bottom: 0; }
      .dshr-hwhen {
        color: var(--dshr-sub);
        white-space: nowrap;
      }
      .dshr-hms {
        margin-left: auto;
        color: var(--dshr-mute);
        font-family: var(--dshr-mono);
        font-size: var(--dshr-fs-meta);
        white-space: nowrap;
      }
      .dshr-empty {
        margin: 0;
        color: var(--dshr-mute);
        font-size: var(--dshr-fs-small);
      }

      .dshr-tag {
        display: inline-flex;
        align-items: center;
        height: 22px;
        padding: 0 8px;
        border-radius: 6px;
        background: var(--dshr-soft);
        color: var(--dshr-sub);
        font-size: var(--dshr-fs-meta);
        font-weight: 500;
        white-space: nowrap;
      }
      .dshr-tag[data-tone="ok"] {
        background: color-mix(in srgb, var(--dshr-ok) 12%, var(--dshr-soft));
        color: var(--dshr-ok);
      }
      .dshr-tag[data-tone="warn"] {
        background: color-mix(in srgb, var(--dshr-warn) 12%, var(--dshr-soft));
        color: var(--dshr-warn);
      }
      .dshr-tag[data-tone="err"] {
        background: color-mix(in srgb, var(--dshr-err) 12%, var(--dshr-soft));
        color: var(--dshr-err);
      }

      /* 详情、代码、日志 */
      .dshr-details { margin-top: 2px; }
      .dshr-details > summary {
        color: var(--dshr-sub);
        font-size: var(--dshr-fs-small);
        cursor: pointer;
        list-style-position: inside;
      }
      .dshr-details > summary:hover { color: var(--dshr-text); }
      .dshr-details[open] > summary { margin-bottom: 8px; }
      .dshr-details .dshr-rows { margin-top: 0; }
      .dshr-log {
        margin: 8px 0 0;
        padding: 10px 12px;
        max-height: 200px;
        overflow: auto;
        border-radius: var(--dshr-radius-sm);
        background: var(--dshr-sunk);
        color: var(--dshr-sub);
        font-family: var(--dshr-mono);
        font-size: var(--dshr-fs-meta);
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .dshr-cmd {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
      }
      .dshr-cmd code {
        flex: 1;
        min-width: 0;
        padding: 8px 10px;
        border-radius: var(--dshr-radius-sm);
        background: var(--dshr-sunk);
        font-family: var(--dshr-mono);
        font-size: var(--dshr-fs-meta);
        line-height: 1.5;
        white-space: normal;
        word-break: break-all;
      }
      .dshr-more {
        border-top: 1px solid var(--dshr-line);
        padding-top: 10px;
      }

      .dshr-spin {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid color-mix(in srgb, var(--dshr-accent) 24%, transparent);
        border-top-color: var(--dshr-accent);
        animation: dshr-rotate .8s linear infinite;
        flex: 0 0 auto;
      }
      @keyframes dshr-rotate { to { transform: rotate(360deg) } }
      @media (prefers-reduced-motion: reduce) {
        .dshr-spin, .dshr-beacon { animation: none !important; }
      }

      /* 弹窗：全页唯一使用阴影的浮层 */
      .dshr-mask {
        position: fixed;
        inset: 0;
        z-index: 3000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background: color-mix(in srgb, #2b2620 48%, transparent);
        animation: dshr-fade .12s ease-out;
        font-size: var(--dshr-fs-body);
        line-height: 1.6;
        color: var(--dshr-text);
      }
      @keyframes dshr-fade { from { opacity: 0 } to { opacity: 1 } }
      .dshr-modal {
        width: min(420px, calc(100vw - 32px));
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 20px;
        border: 1px solid var(--dshr-line);
        border-radius: 16px;
        background: var(--dshr-card);
        box-shadow: 0 18px 50px color-mix(in srgb, #2b2620 28%, transparent);
        color: var(--dshr-text);
      }
      .dshr-modal h2 {
        margin: 0;
        font-size: var(--dshr-fs-title);
        font-weight: 600;
        line-height: 1.3;
        letter-spacing: -0.01em;
      }
      .dshr-modal p {
        margin: 0;
        color: var(--dshr-sub);
        font-size: var(--dshr-fs-small);
      }
      .dshr-modalList {
        display: flex;
        flex-direction: column;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .dshr-modalList li {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 0;
        border-top: 1px solid var(--dshr-line);
        font-size: var(--dshr-fs-small);
      }
      .dshr-modalList li:first-child { border-top: 0; padding-top: 0; }
      .dshr-modalList li:last-child { padding-bottom: 0; }
      .dshr-modalList span { color: var(--dshr-sub); flex: 0 0 auto; }
      .dshr-modalList b {
        min-width: 0;
        overflow: hidden;
        text-align: right;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--dshr-mono);
        font-size: var(--dshr-fs-meta);
        font-weight: 500;
      }
      .dshr-modalActions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 2px;
      }

      @media (max-width: 760px) {
        .dshr-root { gap: 16px; padding-bottom: 32px; }
        .dshr-status { padding: 16px; }
        .dshr-statusActions { width: 100%; }
        .dshr-statusActions .dshr-btn { width: 100%; height: 40px; }
        .dshr-run { padding: 14px 16px; }
        .dshr-panel { padding: 14px 16px; }
        .dshr-cols { grid-template-columns: minmax(0, 1fr); }
        .dshr-callout { flex-wrap: wrap; }
        .dshr-calloutActions { width: 100%; justify-content: flex-end; }
        .dshr-btn { height: 38px; }
        .dshr-btnSm { height: 30px; }
        .dshr-hms { display: none; }
      }
      @media (max-width: 560px) {
        .dshr-steps { flex-wrap: wrap; }
        .dshr-step { flex: 1 1 50%; padding-right: 12px; }
        .dshr-step:nth-child(2n) { padding-right: 0; }
        .dshr-step:nth-child(n + 3) { margin-top: 6px; }
      }
    `

    // ── 小工具 ──────────────────────────────────────────────────────────
    function fmtDuration(ms) {
      const n = Number(ms) || 0
      if (n < 1000) return '不到 1 秒'
      const total = Math.round(n / 1000)
      if (total < 60) return total + ' 秒'
      const min = Math.floor(total / 60)
      const sec = total % 60
      if (min < 60) return sec ? min + ' 分 ' + sec + ' 秒' : min + ' 分钟'
      const hour = Math.floor(min / 60)
      const restMin = min % 60
      return restMin ? hour + ' 小时 ' + restMin + ' 分' : hour + ' 小时'
    }

    function fmtUptime(sec) {
      const n = Math.max(0, Math.floor(Number(sec) || 0))
      if (n < 60) return '不到 1 分钟'
      if (n < 3600) return Math.floor(n / 60) + ' 分钟'
      if (n < 86400) {
        const h = Math.floor(n / 3600)
        const m = Math.floor((n % 3600) / 60)
        return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时'
      }
      const d = Math.floor(n / 86400)
      const h = Math.floor((n % 86400) / 3600)
      return h ? d + ' 天 ' + h + ' 小时' : d + ' 天'
    }

    function pad2(n) {
      return n < 10 ? '0' + n : String(n)
    }

    function fmtStamp(iso) {
      if (!iso) return '—'
      const d = new Date(iso)
      if (isNaN(d.getTime())) return '—'
      const now = new Date()
      const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      const days = Math.round((startOfToday - startOfDay) / 86400000)
      if (days === 0) return '今天 ' + time
      if (days === 1) return '昨天 ' + time
      if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + time
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + time
    }

    function noticeText(code, message) {
      const map = {
        BUSY: '已经有一次重启在进行，等它完成后再试。',
        COOLDOWN: '刚完成一次重启，请稍等几秒再试。',
        LAUNCH_TIMEOUT: '没能启动重启程序，服务没有受到影响。'
      }
      return map[code] || message || ''
    }

    async function api(path, options) {
      const opts = options || {}
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), opts.timeout || 5000) : null
      try {
        const res = await fetch(path, {
          method: opts.method || 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: Object.assign({ 'content-type': 'application/json' }, opts.headers || {}),
          body: opts.body,
          signal: controller ? controller.signal : undefined,
        })
        let data = null
        try {
          data = await res.json()
        } catch {}
        return { ok: res.ok, status: res.status, data }
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    function loadPending() {
      try {
        const raw = sessionStorage.getItem(STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || !parsed.at) return null
        if (Date.now() - parsed.at > RECENT_MS) {
          sessionStorage.removeItem(STORAGE_KEY)
          return null
        }
        return parsed
      } catch {
        return null
      }
    }

    function savePending(value) {
      try {
        if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
        else sessionStorage.removeItem(STORAGE_KEY)
      } catch {}
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text)
          return true
        }
      } catch {}
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    // ── 图标 ────────────────────────────────────────────────────────────
    function Icon(props) {
      const size = props.size || 14
      const common = {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flexShrink: 0 },
      }
      const name = props.name
      if (name === 'check') return h('svg', common, h('path', { d: 'M3 8.5l3.2 3.2L13 4.8' }))
      if (name === 'cross') return h('svg', common, h('path', { d: 'M4 4l8 8M12 4l-8 8' }))
      if (name === 'warn') {
        return h(
          'svg',
          common,
          h('path', { d: 'M8 2.2l6 10.6H2L8 2.2z' }),
          h('path', { d: 'M8 6.4v3.1' }),
          h('path', { d: 'M8 11.7v.1' }),
        )
      }
      if (name === 'refresh') {
        return h(
          'svg',
          common,
          h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
          h('path', { d: 'M13 2.6v3.1H9.9' }),
        )
      }
      if (name === 'bolt') return h('svg', common, h('path', { d: 'M8.6 1.8L3.8 9h3.4l-.8 5.2L11.8 7H8.4l.2-5.2z' }))
      if (name === 'clock') return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.4 }), h('path', { d: 'M8 4.8V8l2.2 1.4' }))
      if (name === 'chev') return h('svg', common, h('path', { d: 'M4.5 6.5L8 10l3.5-3.5' }))
      if (name === 'copy') {
        return h(
          'svg',
          common,
          h('rect', { x: 5.5, y: 5.5, width: 7, height: 7, rx: 1.4 }),
          h('path', { d: 'M10.5 3.8H4.6c-.5 0-1 .4-1 1v5.9' }),
        )
      }
      return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5 }))
    }

    function Spinner() {
      return h('span', { className: 'dshr-spin', role: 'status', 'aria-label': '进行中' })
    }

// ── 弹窗 ────────────────────────────────────────────────────────────
    function ConfirmDialog(props) {
      const cancelRef = useRef(null)
      useEffect(() => {
        const onKey = (e) => {
          if (e.key === 'Escape') props.onCancel()
        }
        document.addEventListener('keydown', onKey)
        const timer = setTimeout(() => {
          const node = cancelRef.current
          if (node) node.focus()
        }, 30)
        return () => {
          document.removeEventListener('keydown', onKey)
          clearTimeout(timer)
        }
      }, [])
      const sys = props.sys || {}
      const run = props.run || {}
      const address = addressLabel(Object.assign({}, sys, run))
      const body = h(
        'div',
        { className: 'dshr-mask', onMouseDown: (e) => { if (e.target === e.currentTarget) props.onCancel() } },
        h(
          'div',
          { className: 'dshr-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dshr-confirm-title' },
          h('h2', { id: 'dshr-confirm-title' }, '要重启服务吗？'),
          h('p', null, '正在生成的回复会被中断。页面会断开几秒，连上新服务后自动刷新。'),
          h(
            'ul',
            { className: 'dshr-modalList' },
            h('li', null, h('span', null, '地址'), h('b', { title: address }, address)),
            h('li', null, h('span', null, '当前进程'), h('b', null, String(sys.pid || run.oldPid || '—'))),
          ),
          h(
            'div',
            { className: 'dshr-modalActions' },
            h('button', { type: 'button', className: 'dshr-btn dshr-btnGhost', ref: cancelRef, onClick: props.onCancel }, '取消'),
            h('button', { type: 'button', className: 'dshr-btn dshr-btnPrimary', onClick: props.onConfirm }, '重启'),
          ),
        ),
      )
      if (createPortal && typeof document !== 'undefined') return createPortal(body, document.body)
      return body
    }

    // ── 进度 ────────────────────────────────────────────────────────────
    const STEP_LABELS = { preflight: '准备', restart: '重启服务', ready: '等待启动', verify: '检查连接' }
    const STEP_TITLES = {
      preflight: '正在检查运行环境',
      restart: '正在启动新服务',
      ready: '正在等待新服务启动',
      verify: '正在确认连接正常',
    }

    function StepList(props) {
      const steps = props.steps || []
      return h(
        'ol',
        { className: 'dshr-steps', 'aria-label': '重启进度' },
        steps.map((step) => {
          const state = step.status === 'done' ? 'done' : step.status === 'active' ? 'active' : step.status === 'failed' ? 'failed' : 'pending'
          const marker =
            state === 'active'
              ? h(Spinner)
              : state === 'done'
                ? h(Icon, { name: 'check', size: 12 })
                : state === 'failed'
                  ? h(Icon, { name: 'cross', size: 12 })
                  : h('span', {
                      style: {
                        width: 12,
                        height: 12,
                        borderRadius: 999,
                        border: '1.5px solid var(--dshr-line-strong)',
                        display: 'inline-block',
                        flexShrink: 0,
                      },
                    })
          return h(
            'li',
            { key: step.id, className: 'dshr-step', 'data-state': state },
            h(
              'div',
              { className: 'dshr-stepTop' },
              marker,
              h('span', { className: 'dshr-stepLabel' }, STEP_LABELS[step.id] || step.label || step.id),
            ),
          )
        }),
      )
    }

    // ── 主页面 ──────────────────────────────────────────────────────────
    function Page() {
      const [snap, setSnap] = useState(null)
      const [notice, setNotice] = useState(null)
      const [connLost, setConnLost] = useState(false)
      const [lostAt, setLostAt] = useState(0)
      const [pending, setPending] = useState(loadPending)
      const [mineRunId, setMineRunId] = useState(function () {
        const restored = loadPending()
        return restored && restored.runId ? restored.runId : ''
      })
      const [confirmOpen, setConfirmOpen] = useState(false)
      const [now, setNow] = useState(Date.now())
      const [reloadAt, setReloadAt] = useState(0)
      const [dismissed, setDismissed] = useState('')
      const [copied, setCopied] = useState('')
      const inflight = useRef(false)

      const refresh = useCallback(async () => {
        if (inflight.current) return
        inflight.current = true
        try {
          const res = await api(API_STATUS, { method: 'GET', timeout: 4500 })
          if (!res.ok || !res.data || res.data.ok !== true) throw new Error('bad status')
          setSnap(res.data)
          setConnLost(false)
          setLostAt(0)
        } catch {
          setConnLost(true)
          setLostAt((t) => t || Date.now())
        } finally {
          inflight.current = false
        }
      }, [])

      useEffect(() => {
        refresh()
        const poll = setInterval(refresh, 1200)
        const tick = setInterval(() => setNow(Date.now()), 500)
        return () => {
          clearInterval(poll)
          clearInterval(tick)
        }
      }, [refresh])

      const sys = snap && snap.sys ? snap.sys : null
      const run = snap && snap.run ? snap.run : null
      const active = !!run && ACTIVE.indexOf(run.status) >= 0
      const isMine = !!mineRunId && !!run && run.runId === mineRunId
      const elapsed = active && run ? Math.max(0, now - (Date.parse(run.startedAt || '') || now)) : 0
      const offlineFor = connLost && lostAt ? Math.max(0, now - lostAt) : 0

      // 认领：POST 的响应可能被重启打断，或者页面在重启中途被刷新；两种情况下都靠轮询接上这轮 run。
      useEffect(() => {
        if (!run) return
        const startedAt = Date.parse(run.startedAt || '') || 0
        if (pending && !pending.runId) {
          const requestMatches = !!pending.requestId && run.clientRequestId === pending.requestId
          // 兼容旧 sessionStorage：没有 requestId 时才退回短时间窗。
          const timeMatches = !pending.requestId && startedAt >= (pending.at || 0) - 5000
          if (requestMatches || (ACTIVE.indexOf(run.status) >= 0 && timeMatches)) {
            setMineRunId(run.runId)
            setPending(null)
            savePending({ runId: run.runId, at: pending.at || Date.now(), requestId: pending.requestId || '' })
          }
          return
        }
        if (pending && pending.runId === run.runId && mineRunId !== run.runId) {
          setMineRunId(run.runId)
          setPending(null)
        }
      }, [run && run.runId, run && run.status, run && run.clientRequestId, pending && pending.runId, pending && pending.requestId, mineRunId])

      // 请求可能在送达前就断了：15 秒内没有出现活跃 run 就提示，而不是永远等待。
      useEffect(() => {
        if (!pending || pending.runId || connLost) return
        const timer = setTimeout(() => {
          setNotice({ code: 'NO_ACK', message: '没有收到受理确认', hint: '请求可能没有送达。稍等片刻再试；如果服务确实重启了，这里会自动显示结果。' })
          setPending(null)
        }, 15000)
        return () => clearTimeout(timer)
      }, [pending && pending.at, pending && pending.runId, connLost])

      // 终态：停掉 pending，保留 mineRunId 让结果卡片留在原地；已连上新实例时启动自动刷新。
      useEffect(() => {
        if (!run || !mineRunId || run.runId !== mineRunId) return
        if (run.status !== 'done' && run.status !== 'failed') return
        setPending(null)
        savePending(null)
        setConnLost(false)
        if (run.status === 'done' && sys && run.newPid && sys.pid === run.newPid) {
          setReloadAt((prev) => prev || Date.now() + RELOAD_DELAY_MS)
        }
      }, [run && run.status, run && run.runId, mineRunId, sys && sys.pid])

      // 倒计时结束刷新；取消则不再刷新（直到下一次重启）。
      useEffect(() => {
        if (!reloadAt) return
        const timer = setInterval(() => {
          if (Date.now() >= reloadAt) {
            clearInterval(timer)
            window.location.reload()
          }
        }, 200)
        return () => clearInterval(timer)
      }, [reloadAt])

      const trigger = useCallback(async () => {
        setConfirmOpen(false)
        setNotice(null)
        setDismissed('')
        setReloadAt(0)
        setMineRunId('')
        const requestId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        const base = { runId: '', at: Date.now(), requestId, beforePid: sys ? sys.pid : 0 }
        setPending(base)
        savePending(base)
        try {
          const res = await api(API_RESTART, {
            method: 'POST',
            body: JSON.stringify({ action: 'restart', requestId }),
            timeout: 15000,
          })
          if (!res.ok) {
            setPending(null)
            savePending(null)
            setNotice(
              (res.data && { code: res.data.code, message: res.data.message, hint: res.data.hint }) || {
                code: 'HTTP_' + res.status,
                message: '触发失败（HTTP ' + res.status + '）',
                hint: '稍后重试；若持续失败请查看宿主日志。',
              },
            )
            return
          }
          const runId = res.data && res.data.runId ? res.data.runId : ''
          const next = Object.assign({}, base, { runId })
          setPending(next)
          if (runId) setMineRunId(runId)
          savePending(runId ? { runId, at: base.at, requestId } : next)
          setTimeout(refresh, 150)
        } catch {
          // 连接被重启打断是预期路径：保持 pending，等轮询确认。
          setConnLost(true)
          setLostAt(Date.now())
        }
      }, [sys, refresh])

      const onCopy = useCallback((text, key) => {
        const ok = copyText(text)
        setCopied(ok ? key : '')
        setTimeout(() => setCopied(''), 1600)
      }, [])

      // 展示状态
      const lastDone = run && run.status === 'done' ? run : null
      const lastFailed = run && run.status === 'failed' ? run : null

      // 执行器没拉起来 ⇒ 服务根本没动，不该展示成一次“重启失败”（服务还好好的）。
      const launchFailed = !!lastFailed && !!(lastFailed.error && lastFailed.error.code === 'LAUNCH_TIMEOUT')
      const showLive = active || (!!pending && !run)
      const showResult = !active && !launchFailed && ((lastDone && (isMine || (sys && lastDone.newPid === sys.pid))) || !!lastFailed)
      const loading = !snap && !connLost
      const heroTone = connLost ? 'down' : active || pending || loading ? 'busy' : 'ok'
      const heroTitle = connLost
        ? '连接已断开'
        : active
          ? '正在重启服务'
          : pending
            ? '正在提交重启请求'
            : loading
              ? '正在读取状态'
              : '运行正常'
      const heroMeta = connLost
        ? active
          ? '重启还在进行，恢复后本页会自动更新。'
          : '正在重试连接，服务恢复后本页会自动更新。'
        : active
          ? '页面会自动刷新，不用手动操作。'
          : pending
            ? '正在等待服务受理。'
            : sys
              ? '已运行 ' + fmtUptime(sys.uptimeSec) + '，占用 ' + sys.rssMB + ' MB 内存'
              : ''
      const currentStep = active && run ? (run.steps || []).find((s) => s.status === 'active') : null
      const liveTitle =
        pending && !run
          ? '请求已发出'
          : run && run.status === 'queued'
            ? '已受理，等待开始'
            : currentStep
              ? STEP_TITLES[currentStep.id] || '正在重启服务'
              : '正在重启服务'
      const busy = active || !!pending
      const restartLabel = active ? '正在重启' : pending ? '正在提交' : '重启服务'
      const noticeTone = notice && ['BUSY', 'COOLDOWN', 'NO_ACK', 'LAUNCH_TIMEOUT'].indexOf(notice.code) >= 0 ? 'warn' : 'err'

      const renderRunCard = () => {
        if (showResult && lastDone) {
          const took = (Date.parse(lastDone.finishedAt) || 0) - (Date.parse(lastDone.startedAt) || 0)
          const secondsLeft = reloadAt ? Math.max(0, Math.ceil((reloadAt - now) / 1000)) : 0
          return h(
            'section',
            { className: 'dshr-card dshr-run', role: 'status' },
            h(
              'div',
              { className: 'dshr-runHead' },
              h('span', { className: 'dshr-runIcon', 'data-tone': 'ok' }, h(Icon, { name: 'check', size: 16 })),
              h('div', { className: 'dshr-runText' }, h('div', { className: 'dshr-runTitle' }, '重启完成')),
              h(
                'div',
                { className: 'dshr-runActions' },
                h('button', { type: 'button', className: 'dshr-btn dshr-btnGhost dshr-btnSm', onClick: () => setDismissed(lastDone.runId) }, '收起'),
              ),
            ),
            h(
              'div',
              { className: 'dshr-runBody' },
              lastDone.degraded
                ? h(
                    'div',
                    { className: 'dshr-callout', 'data-tone': 'warn' },
                    h(Icon, { name: 'warn', size: 15 }),
                    h('div', { className: 'dshr-calloutBody' }, h('div', { className: 'dshr-calloutTitle' }, '服务已恢复，但页面可能还是旧的。')),
                    h(
                      'div',
                      { className: 'dshr-calloutActions' },
                      h('button', { type: 'button', className: 'dshr-btn dshr-btnSm', onClick: () => window.location.reload() }, '刷新页面'),
                    ),
                  )
                : null,
              reloadAt
                ? h(
                    'div',
                    { className: 'dshr-callout', 'data-tone': 'busy', role: 'status' },
                    h(Spinner),
                    h(
                      'div',
                      { className: 'dshr-calloutBody' },
                      h('div', null, secondsLeft > 0 ? '已连上新服务，' + secondsLeft + ' 秒后自动刷新页面。' : '已连上新服务，正在刷新页面…'),
                    ),
                    h(
                      'div',
                      { className: 'dshr-calloutActions' },
                      h('button', { type: 'button', className: 'dshr-btn dshr-btnPrimary dshr-btnSm', onClick: () => window.location.reload() }, '现在刷新'),
                      h('button', { type: 'button', className: 'dshr-btn dshr-btnGhost dshr-btnSm', onClick: () => setReloadAt(0) }, '暂不刷新'),
                    ),
                  )
                : null,
              h(
                'dl',
                { className: 'dshr-rows' },
                row('新进程', lastDone.newPid ? String(lastDone.newPid) : '—', true),
                row('监听端口', lastDone.port ? ':' + lastDone.port : '—', true),
                row('用时', took > 0 ? fmtDuration(took) : '—'),
                row('完成时间', fmtStamp(lastDone.finishedAt)),
                lastDone.attempt > 1 ? row('尝试次数', lastDone.attempt + ' 次') : null,
              ),
              lastDone.fallback ? h('p', { className: 'dshr-hint' }, lastDone.note || '服务已直接启动，没有交给 systemd 管理。') : null,
            ),
          )
        }
        if (showResult && lastFailed) {
          const err = lastFailed.error || {}
          const diag = diagCommand({ unit: lastFailed.unit || (sys && sys.unit), manager: lastFailed.manager || (sys && sys.manager), dataDir: sys && sys.dataDir })
          return h(
            'section',
            { className: 'dshr-card dshr-run', role: 'alert' },
            h(
              'div',
              { className: 'dshr-runHead' },
              h('span', { className: 'dshr-runIcon', 'data-tone': 'err' }, h(Icon, { name: 'cross', size: 16 })),
              h('div', { className: 'dshr-runText' }, h('div', { className: 'dshr-runTitle' }, '重启失败')),
              h(
                'div',
                { className: 'dshr-runActions' },
                h('button', { type: 'button', className: 'dshr-btn dshr-btnGhost dshr-btnSm', onClick: () => setDismissed(lastFailed.runId) }, '收起'),
              ),
            ),
            h(
              'div',
              { className: 'dshr-runBody' },
              h('p', { className: 'dshr-hint', style: { color: 'var(--dshr-text)' } }, err.message || '这次重启没有完成。'),
              err.hint ? h('p', { className: 'dshr-hint' }, err.hint) : null,
              h(
                'div',
                { style: { display: 'flex', gap: 8 } },
                h('button', { type: 'button', className: 'dshr-btn dshr-btnPrimary dshr-btnSm', onClick: () => setConfirmOpen(true) }, '重试'),
              ),
              h(
                'details',
                { className: 'dshr-details' },
                h('summary', null, '技术详情'),
                err.code ? h('dl', { className: 'dshr-rows' }, row('错误码', err.code, true)) : null,
                err.detail ? h('pre', { className: 'dshr-log' }, err.detail) : null,
                h(
                  'div',
                  { className: 'dshr-cmd' },
                  h('code', null, diag),
                  h('button', { type: 'button', className: 'dshr-btn dshr-btnSm', onClick: () => onCopy(diag, 'diag') }, copied === 'diag' ? '已复制' : '复制'),
                ),
                snap && snap.logTail ? h('pre', { className: 'dshr-log' }, snap.logTail) : null,
              ),
            ),
          )
        }
        if (showLive) {
          const metaParts = []
          if (run && run.attempt > 1) metaParts.push('第 ' + run.attempt + ' 次尝试')
          if (connLost) metaParts.push('连接暂时中断')
          else if (elapsed >= 1000) metaParts.push('已用时 ' + fmtDuration(elapsed))
          return h(
            'section',
            { className: 'dshr-card dshr-run', role: 'status' },
            h(
              'div',
              { className: 'dshr-runHead' },
              h(Spinner),
              h(
                'div',
                { className: 'dshr-runText' },
                h('div', { className: 'dshr-runTitle' }, liveTitle),
                metaParts.length ? h('div', { className: 'dshr-runMeta' }, metaParts.join('，')) : null,
              ),
            ),
            h(
              'div',
              { className: 'dshr-runBody' },
              active && run.steps && run.steps.length
                ? h(StepList, { steps: run.steps })
                : h('p', { className: 'dshr-hint' }, '请求已发出，正在等待服务受理。'),
            ),
          )
        }
        return null
      }

      const runCard = renderRunCard()
      const showRunCard = runCard && !(dismissed && run && dismissed === run.runId)

      const history = snap && snap.history ? snap.history.slice(0, 8) : []

      return h(
        'div',
        { className: 'dshr-root' },
        h(
          'header',
          { className: 'dshr-head' },
          h('h1', null, '服务与重启'),
          h('p', null, '查看 dsh web 的运行状态，需要时重启。'),
        ),

        h(
          'section',
          { className: 'dshr-card dshr-status' },
          h(
            'div',
            { className: 'dshr-statusLead' },
            h('span', { className: 'dshr-beacon', 'data-tone': heroTone }),
            h(
              'div',
              { style: { minWidth: 0 } },
              h('div', { className: 'dshr-statusTitle' }, heroTitle),
              heroMeta ? h('div', { className: 'dshr-statusMeta' }, heroMeta) : null,
            ),
          ),
          h(
            'div',
            { className: 'dshr-statusActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshr-btn dshr-btnPrimary',
                disabled: busy || loading || connLost,
                onClick: () => setConfirmOpen(true),
              },
              h(Icon, { name: 'refresh', size: 14 }),
              h('span', null, restartLabel),
            ),
          ),
        ),

        notice
          ? h(
              'section',
              { className: 'dshr-callout', 'data-tone': noticeTone, role: 'alert' },
              h(Icon, { name: 'warn', size: 15 }),
              h(
                'div',
                { className: 'dshr-calloutBody' },
                h('div', { className: 'dshr-calloutTitle' }, noticeText(notice.code, notice.message) || '触发失败'),
                notice.hint ? h('div', { className: 'dshr-calloutHint' }, notice.hint) : null,
              ),
              h(
                'div',
                { className: 'dshr-calloutActions' },
                h('button', { type: 'button', className: 'dshr-btn dshr-btnGhost dshr-btnSm', onClick: () => setNotice(null) }, '关闭'),
              ),
            )
          : null,

        launchFailed && !(dismissed && dismissed === run.runId)
          ? h(
              'section',
              { className: 'dshr-callout', 'data-tone': 'warn', role: 'status' },
              h(Icon, { name: 'warn', size: 15 }),
              h(
                'div',
                { className: 'dshr-calloutBody' },
                h('div', { className: 'dshr-calloutTitle' }, '没能触发重启，服务没有受到影响。'),
                h('div', { className: 'dshr-calloutHint' }, '可以再试一次，或展开详情看看原因。'),
                h(
                  'details',
                  { className: 'dshr-details' },
                  h('summary', null, '技术详情'),
                  h('dl', { className: 'dshr-rows' }, row('错误码', (lastFailed.error && lastFailed.error.code) || 'LAUNCH_TIMEOUT', true)),
                  lastFailed.error && lastFailed.error.detail ? h('pre', { className: 'dshr-log' }, lastFailed.error.detail) : null,
                ),
              ),
              h(
                'div',
                { className: 'dshr-calloutActions' },
                h('button', { type: 'button', className: 'dshr-btn dshr-btnSm', onClick: trigger, disabled: busy }, '重试'),
                h('button', { type: 'button', className: 'dshr-btn dshr-btnGhost dshr-btnSm', onClick: () => setDismissed(run.runId) }, '关闭'),
              ),
            )
          : null,

        showRunCard ? runCard : null,

        sys
          ? h(
              'div',
              { className: 'dshr-cols' },
              h(
                'section',
                { className: 'dshr-card dshr-panel' },
                h(
                  'div',
                  { className: 'dshr-panelHead' },
                  h('h2', null, '服务'),
                  connLost ? h('span', null, '断开前的状态') : null,
                ),
                h(
                  'dl',
                  { className: 'dshr-rows' },
                  row('地址', addressLabel(sys), true),
                  row('进程', String(sys.pid), true),
                  row('版本', sys.dshVersion || '—', true),
                ),
                h(
                  'details',
                  { className: 'dshr-details dshr-more' },
                  h('summary', null, '更多信息'),
                  h(
                    'dl',
                    { className: 'dshr-rows' },
                    row('启动方式', modeLabel(sys)),
                    row('服务单元', sys.unit || '无', true),
                    row('Node', sys.nodeVersion ? String(sys.nodeVersion).replace(/^v/, '') : '—'),
                    row('系统', sys.platform + ' / ' + sys.arch),
                    row('数据目录', sys.dataDir, true),
                  ),
                ),
              ),
              h(
                'section',
                { className: 'dshr-card dshr-panel' },
                h('div', { className: 'dshr-panelHead' }, h('h2', null, '最近重启')),
                history.length
                  ? h(
                      'ul',
                      { className: 'dshr-history' },
                      history.map((item) =>
                        h(
                          'li',
                          { key: item.runId, className: 'dshr-hrow', title: item.code || item.note || '' },
                          h('span', { className: 'dshr-hwhen' }, fmtStamp(item.at)),
                          h(
                            'span',
                            { className: 'dshr-tag', 'data-tone': item.ok ? 'ok' : item.code === 'LAUNCH_TIMEOUT' ? 'warn' : 'err' },
                            item.ok ? '成功' : item.code === 'LAUNCH_TIMEOUT' ? '未触发' : '失败',
                          ),
                          h('span', { className: 'dshr-hms' }, item.ms ? fmtDuration(item.ms) : '—'),
                        ),
                      ),
                    )
                  : h('p', { className: 'dshr-empty' }, '还没有重启记录。'),
              ),
            )
          : null,

        confirmOpen ? h(ConfirmDialog, { sys, run, onCancel: () => setConfirmOpen(false), onConfirm: trigger }) : null,
      )
    }

    function row(label, value, mono) {
      return h(
        'div',
        { className: 'dshr-row' },
        h('dt', null, label),
        h('dd', { className: mono ? 'mono' : '', title: String(value) }, value),
      )
    }

    function apply(ctx) {
      ctx.effect(() => {
        const previous = document.getElementById(STYLE_ID)
        if (previous && previous.parentNode) previous.parentNode.removeChild(previous)
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          if (style.parentNode) style.parentNode.removeChild(style)
        }
      }, 'dsh-restart: styles')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: SECTION.id, label: SECTION.label, order: SECTION.order },
          Page,
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
})
