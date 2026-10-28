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

    function targetLabel(info) {
      if (!info) return '—'
      if (info.mode === 'direct' || !info.unit) return '直接重启（无 systemd 单元）'
      return info.unit
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

    const CSS = `
      .dshr-root {
        --dshr-card: var(--dsw-alias-bg-layer-1, #ffffff);
        --dshr-soft: var(--dsw-alias-bg-layer-2, #f4f5f7);
        --dshr-sunk: var(--dsw-alias-bg-layer-3, #eceef2);
        --dshr-line: var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 12%, transparent));
        --dshr-line-strong: var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 20%, transparent));
        --dshr-text: var(--dsw-alias-label-primary, #111827);
        --dshr-sub: var(--dsw-alias-label-secondary, #4b5563);
        --dshr-mute: var(--dsw-alias-label-tertiary, #6b7280);
        --dshr-accent: var(--dsw-alias-brand-primary, #4f7cff);
        --dshr-ok: var(--dsw-alias-state-success-primary, #12b76a);
        --dshr-warn: var(--dsw-alias-state-warn-primary, #f79009);
        --dshr-err: var(--dsw-alias-state-error-primary, #ef4444);
        --dshr-radius: var(--dsw-radius-panel, 14px);
        --dshr-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        display: flex;
        flex-direction: column;
        gap: 16px;
        max-width: 1080px;
        padding: 4px 0 40px;
        color: var(--dshr-text);
        font-size: 13px;
        line-height: 1.55;
      }
      .dshr-root *, .dshr-root *::before, .dshr-root *::after { box-sizing: border-box; }
      .dshr-head { display: flex; flex-direction: column; gap: 2px; }
      .dshr-head h1 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -0.01em; }
      .dshr-head p { margin: 0; color: var(--dshr-mute); font-size: 12.5px; }

      .dshr-card {
        border: 1px solid var(--dshr-line);
        border-radius: var(--dshr-radius);
        background: var(--dshr-card);
      }
      .dshr-hero {
        display: flex;
        align-items: center;
        gap: 18px;
        padding: 18px 20px;
        background: linear-gradient(180deg, var(--dsw-alias-bg-layer-2, #f7f8fa) 0%, var(--dshr-card) 100%);
      }
      .dshr-heroLead { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1; }
      .dshr-heroText { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .dshr-heroTitle { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
      .dshr-heroMeta { color: var(--dshr-mute); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dshr-heroActions { display: flex; gap: 8px; flex-shrink: 0; }

      .dshr-beacon {
        position: relative;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--dshr-ok);
        flex-shrink: 0;
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--dshr-ok) 16%, transparent);
      }
      .dshr-beacon[data-tone="busy"] { background: var(--dshr-accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dshr-accent) 18%, transparent); animation: dshr-breathe 1.6s ease-in-out infinite; }
      .dshr-beacon[data-tone="warn"] { background: var(--dshr-warn); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dshr-warn) 18%, transparent); }
      .dshr-beacon[data-tone="down"] { background: var(--dshr-err); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dshr-err) 18%, transparent); }
      @keyframes dshr-breathe { 0%, 100% { transform: scale(1); opacity: 1 } 50% { transform: scale(1.25); opacity: .65 } }

      .dshr-tag {
        display: inline-flex; align-items: center; gap: 5px;
        height: 22px; padding: 0 8px; border-radius: 999px;
        font-size: 11.5px; font-weight: 500; letter-spacing: .01em;
        background: var(--dshr-soft); color: var(--dshr-sub);
      }
      .dshr-tag[data-tone="ok"] { background: rgba(18, 183, 106, .14); background: color-mix(in srgb, var(--dshr-ok) 14%, transparent); color: var(--dshr-ok); }
      .dshr-tag[data-tone="busy"] { background: rgba(79, 124, 255, .14); background: color-mix(in srgb, var(--dshr-accent) 14%, transparent); color: var(--dshr-accent); }
      .dshr-tag[data-tone="warn"] { background: rgba(247, 144, 9, .16); background: color-mix(in srgb, var(--dshr-warn) 16%, transparent); color: var(--dshr-warn); }
      .dshr-tag[data-tone="err"] { background: rgba(239, 68, 68, .14); background: color-mix(in srgb, var(--dshr-err) 14%, transparent); color: var(--dshr-err); }

      .dshr-btn {
        height: 34px; padding: 0 14px;
        border: 1px solid var(--dshr-line-strong);
        border-radius: 9px;
        background: var(--dshr-card);
        color: var(--dshr-text);
        font: inherit; font-size: 13px; font-weight: 500;
        cursor: pointer;
        transition: background .16s ease, border-color .16s ease, transform .06s ease;
      }
      .dshr-btn:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dshr-soft)); }
      .dshr-btn:active { transform: translateY(1px); }
      .dshr-btn:focus-visible { outline: 2px solid var(--dshr-accent); outline-offset: 2px; }
      .dshr-btn:disabled { opacity: .55; cursor: not-allowed; }
      .dshr-btnPrimary {
        background: var(--dsw-alias-button-primary-fill, var(--dshr-accent));
        border-color: transparent;
        color: var(--dsw-alias-label-primary-foreground, #fff);
      }
      .dshr-btnPrimary:hover { background: var(--dsw-alias-button-primary-hover, var(--dshr-accent)); filter: brightness(1.04); }
      .dshr-btnDanger { background: var(--dshr-err); border-color: transparent; color: #fff; }
      .dshr-btnDanger:hover { filter: brightness(1.05); background: var(--dshr-err); }
      .dshr-btnGhost { border-color: transparent; background: transparent; color: var(--dshr-sub); }
      .dshr-btnSm { height: 28px; padding: 0 10px; font-size: 12px; border-radius: 8px; }

      .dshr-run { padding: 16px 18px; }
      .dshr-run[data-tone="busy"] { border-color: var(--dshr-line-strong); border-color: color-mix(in srgb, var(--dshr-accent) 34%, var(--dshr-line)); }
      .dshr-run[data-tone="ok"] { border-color: var(--dshr-line-strong); border-color: color-mix(in srgb, var(--dshr-ok) 32%, var(--dshr-line)); }
      .dshr-run[data-tone="err"] { border-color: var(--dshr-line-strong); border-color: color-mix(in srgb, var(--dshr-err) 32%, var(--dshr-line)); }
      .dshr-runHead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .dshr-runTitle { font-weight: 600; font-size: 14px; }
      .dshr-elapsed { font-family: var(--dshr-mono); font-size: 12px; color: var(--dshr-mute); margin-left: auto; }
      .dshr-runId { font-family: var(--dshr-mono); font-size: 11px; color: var(--dshr-mute); opacity: .8; }
      .dshr-hint { margin: 8px 0 0; color: var(--dshr-sub); font-size: 12.5px; }
      .dshr-small { color: var(--dshr-mute); font-size: 12px; }

      .dshr-steps {
        display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px; margin: 14px 0 0; padding: 0; list-style: none;
      }
      .dshr-step { position: relative; padding: 12px 12px 10px; border-radius: 10px; background: var(--dshr-soft); min-width: 0; }
      .dshr-step::before { content: ""; position: absolute; left: 12px; right: 12px; top: 0; height: 3px; border-radius: 0 0 3px 3px; background: var(--dshr-line-strong); }
      .dshr-step[data-state="active"] { background: var(--dshr-soft); background: color-mix(in srgb, var(--dshr-accent) 7%, var(--dshr-soft)); }
      .dshr-step[data-state="done"]::before { background: var(--dshr-ok); }
      .dshr-step[data-state="active"]::before { background: var(--dshr-accent); animation: dshr-scan 1.4s ease-in-out infinite; }
      .dshr-step[data-state="failed"]::before { background: var(--dshr-err); }
      @keyframes dshr-scan { 0%, 100% { opacity: 1 } 50% { opacity: .45 } }
      .dshr-stepTop { display: flex; align-items: center; gap: 6px; }
      .dshr-stepLabel { font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dshr-stepMeta { display: block; margin-top: 2px; color: var(--dshr-mute); font-size: 11.5px; font-family: var(--dshr-mono); }
      .dshr-stepDetail { display: -webkit-box; margin-top: 4px; color: var(--dshr-sub); font-size: 11.5px; line-height: 1.35; white-space: normal; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

      .dshr-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--dshr-line-strong); border: 2px solid color-mix(in srgb, var(--dshr-accent) 26%, transparent); border-top-color: var(--dshr-accent); animation: dshr-rotate .8s linear infinite; flex-shrink: 0; }
      @keyframes dshr-rotate { to { transform: rotate(360deg) } }
      @media (prefers-reduced-motion: reduce) {
        .dshr-spin, .dshr-beacon, .dshr-step::before { animation: none !important; }
      }

      .dshr-offline {
        display: flex; align-items: center; gap: 10px;
        margin-top: 12px; padding: 10px 12px;
        border-radius: 10px;
        background: var(--dshr-soft);
        background: color-mix(in srgb, var(--dshr-warn) 9%, var(--dshr-soft));
        color: var(--dshr-sub); font-size: 12.5px;
      }
      .dshr-offline b { color: var(--dshr-text); font-weight: 600; }
      .dshr-offline .dshr-dotline { margin-left: auto; font-family: var(--dshr-mono); font-size: 12px; color: var(--dshr-mute); }

      .dshr-result { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
      .dshr-resultHead { display: flex; align-items: center; gap: 8px; font-weight: 600; }
      .dshr-result[data-tone="ok"] .dshr-resultHead { color: var(--dshr-ok); }
      .dshr-result[data-tone="err"] .dshr-resultHead { color: var(--dshr-err); }
      .dshr-result[data-tone="warn"] .dshr-resultHead { color: var(--dshr-warn); }
      .dshr-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px 18px; margin: 2px 0 0; }
      .dshr-kv > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .dshr-kv dt { color: var(--dshr-mute); font-size: 11.5px; }
      .dshr-kv dd { margin: 0; font-family: var(--dshr-mono); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      .dshr-callout {
        display: flex; align-items: flex-start; gap: 8px;
        padding: 10px 12px; border-radius: 10px;
        background: var(--dshr-soft); color: var(--dshr-sub); font-size: 12.5px;
      }
      .dshr-callout[data-tone="err"] { background: var(--dshr-soft); background: color-mix(in srgb, var(--dshr-err) 8%, var(--dshr-soft)); }
      .dshr-callout[data-tone="warn"] { background: var(--dshr-soft); background: color-mix(in srgb, var(--dshr-warn) 10%, var(--dshr-soft)); }
      .dshr-callout code { font-family: var(--dshr-mono); font-size: 12px; padding: 1px 4px; border-radius: 4px; background: var(--dshr-sunk); }

      .dshr-cmd { display: flex; align-items: center; gap: 8px; }
      .dshr-cmd code { flex: 1; min-width: 0; padding: 8px 10px; border-radius: 8px; background: var(--dshr-sunk); font-family: var(--dshr-mono); font-size: 12px; line-height: 1.5; white-space: normal; word-break: break-all; }

      .dshr-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 16px; }
      .dshr-section { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
      .dshr-sectionHead { display: flex; align-items: baseline; gap: 8px; }
      .dshr-sectionHead h2 { margin: 0; font-size: 13.5px; font-weight: 600; }
      .dshr-sectionHead span { color: var(--dshr-mute); font-size: 11.5px; }

      .dshr-rows { display: flex; flex-direction: column; margin: 0; }
      .dshr-row { display: flex; align-items: center; gap: 12px; padding: 7px 0; border-top: 1px dashed var(--dshr-line); }
      .dshr-row:first-child { border-top: 0; padding-top: 0; }
      .dshr-row:last-child { padding-bottom: 0; }
      .dshr-row dt { color: var(--dshr-mute); font-size: 12px; flex-shrink: 0; width: 64px; }
      .dshr-row dd { margin: 0; font-size: 12.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dshr-row dd.mono { font-family: var(--dshr-mono); }

      .dshr-history { display: flex; flex-direction: column; gap: 0; margin: 0; padding: 0; list-style: none; }
      .dshr-hrow { display: flex; flex-direction: column; gap: 2px; padding: 7px 0; border-top: 1px dashed var(--dshr-line); font-size: 12px; }
      .dshr-hline { display: flex; align-items: center; gap: 8px; }
      .dshr-hrow:first-child { border-top: 0; padding-top: 0; }
      .dshr-hrow:last-child { padding-bottom: 0; }
      .dshr-hwhen { color: var(--dshr-mute); font-family: var(--dshr-mono); font-size: 11.5px; }
      .dshr-hwhat { color: var(--dshr-sub); min-width: 0; white-space: normal; word-break: break-word; }
      .dshr-hms { margin-left: auto; color: var(--dshr-mute); font-family: var(--dshr-mono); font-size: 11.5px; text-align: right; }
      .dshr-hwhat b { color: var(--dshr-text); font-weight: 500; }
      .dshr-empty { color: var(--dshr-mute); font-size: 12.5px; padding: 6px 0 2px; }

      .dshr-log {
        margin: 0; padding: 10px 12px; max-height: 220px; overflow: auto;
        border-radius: 8px; background: var(--dshr-sunk);
        color: var(--dshr-sub); font-family: var(--dshr-mono); font-size: 11.5px; line-height: 1.6;
        white-space: pre-wrap; word-break: break-all;
      }

      .dshr-details > summary { cursor: pointer; color: var(--dshr-sub); font-size: 12px; user-select: none; }
      .dshr-details > summary:hover { color: var(--dshr-text); }
      .dshr-details[open] > summary { margin-bottom: 8px; }

      .dshr-foot { color: var(--dshr-mute); font-size: 11.5px; display: flex; flex-wrap: wrap; gap: 6px 14px; }
      .dshr-foot code { font-family: var(--dshr-mono); }

      /* 弹窗被 portal 到 document.body，已经不在 .dshr-root 里：把主题变量再声明一遍，
         否则 var(--dshr-card) 取不到值、弹窗是透明的。 */
      .dshr-mask {
        --dshr-card: var(--dsw-alias-bg-layer-1, #ffffff);
        --dshr-soft: var(--dsw-alias-bg-layer-2, #f4f5f7);
        --dshr-sunk: var(--dsw-alias-bg-layer-3, #eceef2);
        --dshr-line: var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 12%, transparent));
        --dshr-line-strong: var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 20%, transparent));
        --dshr-text: var(--dsw-alias-label-primary, #111827);
        --dshr-sub: var(--dsw-alias-label-secondary, #4b5563);
        --dshr-mute: var(--dsw-alias-label-tertiary, #6b7280);
        --dshr-accent: var(--dsw-alias-brand-primary, #4f7cff);
        --dshr-ok: var(--dsw-alias-state-success-primary, #12b76a);
        --dshr-warn: var(--dsw-alias-state-warn-primary, #f79009);
        --dshr-err: var(--dsw-alias-state-error-primary, #ef4444);
        --dshr-radius: var(--dsw-radius-panel, 14px);
        --dshr-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        position: fixed; inset: 0; z-index: 3000;
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
        background: var(--dsw-alias-bg-mask-1, rgba(15, 18, 26, 0.45));
        animation: dshr-fade .12s ease-out;
      }
      @keyframes dshr-fade { from { opacity: 0 } to { opacity: 1 } }
      .dshr-modal {
        width: min(430px, calc(100vw - 32px));
        border: 1px solid var(--dshr-line);
        border-radius: 16px;
        background: var(--dshr-card);
        box-shadow: var(--dsw-elevation-prominent, 0 24px 60px rgba(0, 0, 0, .28));
        padding: 20px 20px 16px;
        display: flex; flex-direction: column; gap: 12px;
        color: var(--dshr-text);
      }
      .dshr-modal h2 { margin: 0; font-size: 16px; font-weight: 600; }
      .dshr-modal p { margin: 0; color: var(--dshr-sub); font-size: 12.5px; }
      .dshr-modalList { margin: 0; padding: 10px 12px; list-style: none; border-radius: 10px; background: var(--dshr-soft); display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
      .dshr-modalList li { display: flex; justify-content: space-between; gap: 12px; }
      .dshr-modalList span { color: var(--dshr-mute); }
      .dshr-modalList b { font-family: var(--dshr-mono); font-weight: 500; }
      .dshr-modalActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }

      @media (max-width: 767px) {
        .dshr-root { gap: 12px; padding-bottom: 24px; }
        .dshr-hero { flex-wrap: wrap; padding: 14px 16px; gap: 12px; }
        .dshr-heroMeta { white-space: normal; }
        .dshr-heroActions { width: 100%; }
        .dshr-heroActions .dshr-btn { width: 100%; height: 40px; }
        .dshr-steps { grid-template-columns: 1fr; gap: 6px; }
        .dshr-step { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "label meta" "detail detail"; padding: 10px 12px 10px 14px; }
        .dshr-step::before { left: 0; right: auto; top: 8px; bottom: 8px; width: 3px; height: auto; border-radius: 3px; }
        .dshr-stepTop { grid-area: label; }
        .dshr-stepMeta { grid-area: meta; margin: 0; align-self: center; }
        .dshr-stepDetail { grid-area: detail; }
        .dshr-cols { grid-template-columns: 1fr; }
        .dshr-section { padding: 14px 16px; }
        .dshr-run { padding: 14px 16px; }
        .dshr-elapsed { margin-left: 0; width: 100%; }
        .dshr-hms { display: none; }
        .dshr-btn { height: 38px; }
      }
    `

    // ── 小工具 ──────────────────────────────────────────────────────────
    function fmtMs(ms) {
      const n = Number(ms) || 0
      if (!n || n < 0) return '—'
      if (n < 1000) return Math.max(1, Math.round(n)) + 'ms'
      const s = n / 1000
      if (s < 60) return s.toFixed(1) + 's'
      const m = Math.floor(s / 60)
      return m + 'm ' + Math.round(s % 60) + 's'
    }

    function fmtUptime(sec) {
      const n = Math.max(0, Number(sec) || 0)
      if (n < 60) return n + ' 秒'
      if (n < 3600) return Math.floor(n / 60) + ' 分钟'
      if (n < 86400) return Math.floor(n / 3600) + ' 小时 ' + Math.floor((n % 3600) / 60) + ' 分'
      return Math.floor(n / 86400) + ' 天 ' + Math.floor((n % 86400) / 3600) + ' 小时'
    }

    function fmtClock(iso) {
      if (!iso) return '—'
      const d = new Date(iso)
      if (isNaN(d.getTime())) return '—'
      return d.toLocaleTimeString('zh-CN', { hour12: false })
    }

    function fmtStamp(iso) {
      if (!iso) return '—'
      const d = new Date(iso)
      if (isNaN(d.getTime())) return '—'
      const now = new Date()
      const sameDay = d.toDateString() === now.toDateString()
      return sameDay
        ? d.toLocaleTimeString('zh-CN', { hour12: false })
        : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    }

    function ago(iso) {
      const t = Date.parse(iso || '')
      if (!t) return ''
      const sec = Math.max(0, Math.round((Date.now() - t) / 1000))
      if (sec < 60) return sec + ' 秒前'
      if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前'
      if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前'
      return Math.floor(sec / 86400) + ' 天前'
    }

    function isRecent(iso, windowMs) {
      const t = Date.parse(iso || '')
      if (!t) return false
      return Date.now() - t < (windowMs || RECENT_MS)
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
      const ref = useRef(null)
      useEffect(() => {
        const onKey = (e) => {
          if (e.key === 'Escape') props.onCancel()
        }
        document.addEventListener('keydown', onKey)
        const timer = setTimeout(() => {
          const node = ref.current
          if (node) node.focus()
        }, 30)
        return () => {
          document.removeEventListener('keydown', onKey)
          clearTimeout(timer)
        }
      }, [])
      const sys = props.sys || {}
      const run = props.run || {}
      const body = h(
        'div',
        { className: 'dshr-mask', onMouseDown: (e) => { if (e.target === e.currentTarget) props.onCancel() } },
        h(
          'div',
          { className: 'dshr-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dshr-confirm-title' },
          h('h2', { id: 'dshr-confirm-title' }, '重启 dsh web？'),
          h('p', null, '页面会在几秒内断开，服务恢复后自动回到这里。正在生成中的回复会被中断。'),
          h(
            'ul',
            { className: 'dshr-modalList' },
            h('li', null, h('span', null, '目标'), h('b', null, targetLabel(Object.assign({}, run, sys)))),
            h('li', null, h('span', null, '方式'), h('b', null, modeLabel(sys))),
            h('li', null, h('span', null, '端口'), h('b', null, ':' + (sys.port || run.port || '—'))),
            h('li', null, h('span', null, '当前进程'), h('b', null, String(sys.pid || run.oldPid || '—'))),
          ),
          h(
            'div',
            { className: 'dshr-modalActions' },
            h('button', { type: 'button', className: 'dshr-btn', onClick: props.onCancel }, '取消'),
            h(
              'button',
              { type: 'button', className: 'dshr-btn dshr-btnDanger', ref: ref, onClick: props.onConfirm },
              '确认重启',
            ),
          ),
        ),
      )
      if (createPortal && typeof document !== 'undefined') return createPortal(body, document.body)
      return body
    }

    // ── 时间线 ──────────────────────────────────────────────────────────
    function StepList(props) {
      const steps = props.steps || []
      const now = props.now
      return h(
        'ol',
        { className: 'dshr-steps', 'aria-label': '重启阶段' },
        steps.map((step) => {
          const state = step.status === 'done' ? 'done' : step.status === 'active' ? 'active' : step.status === 'failed' ? 'failed' : 'pending'
          let meta = '—'
          if (state === 'done' || state === 'failed') meta = fmtMs(step.ms)
          else if (state === 'active' && step.startedAt) meta = fmtMs(Math.max(0, now - Date.parse(step.startedAt)))
          return h(
            'li',
            { key: step.id, className: 'dshr-step', 'data-state': state },
            h(
              'div',
              { className: 'dshr-stepTop' },
              state === 'active' ? h(Spinner) : state === 'done' ? h(Icon, { name: 'check', size: 12 }) : state === 'failed' ? h(Icon, { name: 'cross', size: 12 }) : h('span', { style: { width: 12, height: 12, borderRadius: 999, border: '1.5px solid var(--dshr-line-strong)', display: 'inline-block' } }),
              h('span', { className: 'dshr-stepLabel' }, step.label || step.id),
            ),
            h('span', { className: 'dshr-stepMeta' }, meta),
            step.detail ? h('span', { className: 'dshr-stepDetail', title: step.detail }, step.detail) : null,
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
      const [showLog, setShowLog] = useState(false)
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
          setNotice({ code: 'NO_ACK', message: '没有收到受理确认', hint: '请求可能没有送达。点「刷新」再看一次状态；如果服务确实重启了，这里会自动出现记录。' })
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
        setCopied(copyText(text) ? key : '')
        setTimeout(() => setCopied(''), 1600)
      }, [])

      // 展示状态
      const lastDone = run && run.status === 'done' ? run : null
      const lastFailed = run && run.status === 'failed' ? run : null

      // 执行器没拉起来 ⇒ 服务根本没动，不该展示成一次"重启失败"（服务还好好的）。
      const launchFailed = !!lastFailed && !!(lastFailed.error && lastFailed.error.code === 'LAUNCH_TIMEOUT')
      const showLive = active || (!!pending && !run)
      const showResult = !active && !launchFailed && ((lastDone && (isMine || (sys && lastDone.newPid === sys.pid))) || !!lastFailed)
      const heroTone = connLost ? 'down' : active || pending ? 'busy' : lastFailed && !launchFailed && isRecent(lastFailed.finishedAt, 60 * 60 * 1000) ? 'warn' : 'ok'
      const heroTitle = connLost
        ? '服务连接中断'
        : active
          ? '正在重启 dsh web'
          : pending
            ? '正在提交重启请求'
            : 'dsh web 运行中'
      const heroMeta = sys
        ? 'PID ' + sys.pid + ' · 已运行 ' + fmtUptime(sys.uptimeSec) + ' · 端口 ' + sys.port + ' · 内存 ' + sys.rssMB + ' MB'
        : connLost
          ? '等待服务恢复，页面会自动重试'
          : '正在读取状态…'
      const currentStep = active && run ? (run.steps || []).find((s) => s.status === 'active') : null
      const stepTitle = currentStep
        ? currentStep.label
        : run && run.status === 'queued'
          ? '已受理，等待执行器'
          : '准备下一次尝试'
      const busy = active || !!pending

      const renderRunCard = () => {
        if (showResult && lastDone) {
          return h(
            'section',
            { className: 'dshr-card dshr-run', 'data-tone': 'ok' },
            h(
              'div',
              { className: 'dshr-result', style: { marginTop: 0 } },
              h(
                'div',
                { className: 'dshr-resultHead' },
                h(Icon, { name: 'check', size: 16 }),
                h('span', null, '重启完成'),
                h('span', { className: 'dshr-tag', 'data-tone': 'ok' }, fmtMs((Date.parse(lastDone.finishedAt) || 0) - (Date.parse(lastDone.startedAt) || 0))),
                h('span', { className: 'dshr-runId' }, lastDone.runId),
                h('button', { type: 'button', className: 'dshr-btn dshr-btnGhost dshr-btnSm', style: { marginLeft: 'auto' }, onClick: () => setDismissed(lastDone.runId) }, '收起'),
              ),
              h(
                'dl',
                { className: 'dshr-kv' },
                h('div', null, h('dt', null, '新进程'), h('dd', null, 'PID ' + (lastDone.newPid || '—'))),
                h('div', null, h('dt', null, '监听端口'), h('dd', null, ':' + lastDone.port + (sys && lastDone.newPid === sys.pid ? '（当前连接）' : ''))),
                h('div', null, h('dt', null, '尝试次数'), h('dd', null, lastDone.attempt + ' / ' + lastDone.maxAttempts)),
                h('div', null, h('dt', null, '完成方式'), h('dd', null, lastDone.fallback ? '兜底直接启动' : lastDone.degraded ? 'HTTP 恢复（无握手）' : '执行器 + 启动握手')),
                h('div', null, h('dt', null, '完成时间'), h('dd', null, fmtStamp(lastDone.finishedAt))),
              ),
              lastDone.steps && lastDone.steps.length ? h(StepList, { steps: lastDone.steps, now }) : null,
              lastDone.degraded
                ? h(
                    'div',
                    { className: 'dshr-callout', 'data-tone': 'warn' },
                    h(Icon, { name: 'warn', size: 14 }),
                    h('span', null, '服务已恢复，但新实例没有回报启动标记——插件可能未加载或页面未刷新，建议手动刷新一次。'),
                  )
                : null,
              reloadAt
                ? h(
                    'div',
                    { className: 'dshr-callout' },
                    h(Spinner),
                    h('span', null, h('b', null, '已连接到新实例'), '，页面将在 ' + Math.max(0, Math.ceil((reloadAt - now) / 1000)) + ' 秒后自动刷新。'),
                    h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
                      h('button', { type: 'button', className: 'dshr-btn dshr-btnSm', onClick: () => window.location.reload() }, '立即刷新'),
                      h('button', { type: 'button', className: 'dshr-btn dshr-btnGhost dshr-btnSm', onClick: () => setReloadAt(0) }, '取消'),
                    ),
                  )
                : h('p', { className: 'dshr-hint' }, lastDone.note || '服务已恢复，页面连接正常。'),
            ),
          )
        }
        if (showResult && lastFailed) {
          const err = lastFailed.error || {}
          return h(
            'section',
            { className: 'dshr-card dshr-run', 'data-tone': 'err' },
            h(
              'div',
              { className: 'dshr-result', style: { marginTop: 0 } },
              h(
                'div',
                { className: 'dshr-resultHead' },
                h(Icon, { name: 'cross', size: 16 }),
                h('span', null, '重启失败'),
                h('span', { className: 'dshr-tag', 'data-tone': 'err' }, err.code || 'FAILED'),
                h('span', { className: 'dshr-runId' }, lastFailed.runId),
                h('button', { type: 'button', className: 'dshr-btn dshr-btnGhost dshr-btnSm', style: { marginLeft: 'auto' }, onClick: () => setDismissed(lastFailed.runId) }, '收起'),
              ),
              lastFailed.steps && lastFailed.steps.length ? h(StepList, { steps: lastFailed.steps, now }) : null,
              h('p', { className: 'dshr-hint', style: { color: 'var(--dshr-text)' } }, err.message || '重启没有完成'),
              err.hint ? h('p', { className: 'dshr-hint' }, err.hint) : null,
              err.detail ? h('pre', { className: 'dshr-log', style: { maxHeight: 120 } }, err.detail) : null,
              h(
                'div',
                { className: 'dshr-cmd' },
                h('code', null, diagCommand({ unit: lastFailed.unit || (sys && sys.unit), manager: lastFailed.manager || (sys && sys.manager), dataDir: sys && sys.dataDir })),
                h('button', { type: 'button', className: 'dshr-btn dshr-btnSm', onClick: () => onCopy(diagCommand({ unit: lastFailed.unit || (sys && sys.unit), manager: lastFailed.manager || (sys && sys.manager), dataDir: sys && sys.dataDir }), 'status') }, copied === 'status' ? '已复制' : '复制'),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('button', { type: 'button', className: 'dshr-btn dshr-btnPrimary', onClick: () => setConfirmOpen(true) }, '重试重启'),
                snap && snap.logTail
                  ? h(
                      'details',
                      { className: 'dshr-details', open: showLog, onToggle: (e) => setShowLog(!!e.currentTarget.open) },
                      h('summary', null, '执行器日志'),
                      h('pre', { className: 'dshr-log' }, snap.logTail),
                    )
                  : null,
              ),
            ),
          )
        }
        if (showLive) {
          return h(
            'section',
            { className: 'dshr-card dshr-run', 'data-tone': 'busy' },
            h(
              'div',
              { className: 'dshr-runHead' },
              h(Spinner),
              h('span', { className: 'dshr-runTitle' }, stepTitle),
              active ? h('span', { className: 'dshr-tag', 'data-tone': 'busy' }, '第 ' + run.attempt + ' / ' + run.maxAttempts + ' 次尝试') : null,
              h('span', { className: 'dshr-elapsed' }, connLost ? '等待响应 · ' + fmtMs(offlineFor) : fmtMs(elapsed)),
              run ? h('span', { className: 'dshr-runId' }, run.runId) : null,
            ),
            active ? h(StepList, { steps: run.steps, now }) : h('p', { className: 'dshr-hint' }, '已写入受理记录，正在等待独立执行器接管…'),
            active && run && run.attempts && run.attempts.length
              ? h(
                  'p',
                  { className: 'dshr-hint' },
                  '此前失败：' +
                    run.attempts
                      .filter((a) => !a.ok)
                      .map((a) => '第 ' + a.n + ' 次 ' + (a.code || ''))
                      .join('、'),
                )
              : null,
            connLost
              ? h(
                  'div',
                  { className: 'dshr-offline' },
                  h(Spinner),
                  h('span', null, h('b', null, '连接已断开'), '，这是重启过程的正常阶段。服务恢复后本页会自动接上。'),
                  h('span', { className: 'dshr-dotline' }, '等待 ' + fmtMs(offlineFor)),
                )
              : h('p', { className: 'dshr-hint' }, '执行器已脱离 dsh-web 的 cgroup，因此进程被杀后仍能继续完成重启与自检。'),
            h(
              'div',
              { style: { display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' } },
              h('span', { className: 'dshr-small' }, '预计 8–20 秒'),
              h('span', { className: 'dshr-small' }, '端口 ' + (run ? run.port : sys ? sys.port : '—')),
              snap && snap.live && snap.live.heartbeatAgeMs >= 0
                ? h('span', { className: 'dshr-small' }, '执行器心跳 ' + fmtMs(snap.live.heartbeatAgeMs) + ' 前')
                : null,
            ),
          )
        }
        return null
      }

      const runCard = renderRunCard()
      const showRunCard = runCard && !(dismissed && run && dismissed === run.runId)

      return h(
        'div',
        { className: 'dshr-root' },
        h(
          'header',
          { className: 'dshr-head' },
          h('h1', null, '服务与重启'),
          h('p', null, '查看 dsh web 进程状态，触发一次可追踪、可恢复的重启。'),
        ),

        h(
          'section',
          { className: 'dshr-card dshr-hero' },
          h(
            'div',
            { className: 'dshr-heroLead' },
            h('span', { className: 'dshr-beacon', 'data-tone': heroTone }),
            h(
              'div',
              { className: 'dshr-heroText' },
              h(
                'div',
                { className: 'dshr-heroTitle' },
                heroTitle,
                connLost
                  ? h('span', { className: 'dshr-tag', 'data-tone': 'err' }, '离线')
                  : active || pending
                    ? h('span', { className: 'dshr-tag', 'data-tone': 'busy' }, '重启中')
                    : h('span', { className: 'dshr-tag', 'data-tone': 'ok' }, '运行中'),
              ),
              h('div', { className: 'dshr-heroMeta' }, heroMeta),
            ),
          ),
          h(
            'div',
            { className: 'dshr-heroActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshr-btn dshr-btnPrimary',
                disabled: busy,
                onClick: () => setConfirmOpen(true),
              },
              h(Icon, { name: 'refresh', size: 14 }),
              h('span', { style: { marginLeft: 6 } }, active ? '重启中…' : busy ? '提交中…' : '重启 dsh web'),
            ),
          ),
        ),

        notice
          ? h(
              'section',
              { className: 'dshr-callout', 'data-tone': 'err', role: 'alert' },
              h(Icon, { name: 'warn', size: 15 }),
              h(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { color: 'var(--dshr-text)', fontWeight: 600 } }, (notice.code ? notice.code + ' · ' : '') + (notice.message || '触发失败')),
                notice.hint ? h('div', { style: { marginTop: 2 } }, notice.hint) : null,
              ),
              h('button', { type: 'button', className: 'dshr-btn dshr-btnSm', onClick: () => setNotice(null), 'aria-label': '关闭提示' }, '关闭'),
            )
          : null,

        launchFailed && !(dismissed && dismissed === run.runId)
          ? h(
              'section',
              { className: 'dshr-callout', 'data-tone': 'warn', role: 'status' },
              h(Icon, { name: 'warn', size: 15 }),
              h(
                'div',
                { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { color: 'var(--dshr-text)', fontWeight: 600 } }, '没能触发重启 · 服务未受影响'),
                h(
                  'div',
                  { style: { marginTop: 2 } },
                  (lastFailed.error.detail || lastFailed.error.message || '执行器没有启动') + '。可以重试，或检查 systemd-run 是否可用。',
                ),
              ),
              h('button', { type: 'button', className: 'dshr-btn dshr-btnSm', onClick: trigger, disabled: busy }, '重试'),
              h('button', { type: 'button', className: 'dshr-btn dshr-btnSm', onClick: () => setDismissed(run.runId) }, '关闭'),
            )
          : null,

        showRunCard ? runCard : null,

        h(
          'div',
          { className: 'dshr-cols' },
          h(
            'section',
            { className: 'dshr-card dshr-section' },
            h(
              'div',
              { className: 'dshr-sectionHead' },
              h('h2', null, '运行状态'),
              h('span', null, connLost ? '连接中断' : '实时'),
            ),
            h(
              'dl',
              { className: 'dshr-rows' },
              row('进程', sys ? String(sys.pid) : '—', true),
              row('监听', sys ? endpointLabel(sys) : '—', true),
              row('模式', sys ? modeLabel(sys) : '—', true),
              row('单元', sys ? (sys.unit || '—') : '—', true),
              row('版本', sys ? sys.dshVersion : '—', true),
              row('运行时', sys ? 'Node ' + String(sys.nodeVersion).replace(/^v/, '') + ' · ' + sys.platform + '/' + sys.arch : '—'),
              row('内存', sys ? sys.rssMB + ' MB' : '—'),
              row('进程启动于', sys ? fmtStamp(sys.startedAt) : '—'),
              row('插件启动于', sys && sys.bootAt ? fmtStamp(sys.bootAt) : '—'),
              snap && snap.live && (snap.live.runnerPid || active)
                ? row('执行器', snap.live.runnerAlive ? 'PID ' + snap.live.runnerPid + ' · 心跳 ' + fmtMs(snap.live.heartbeatAgeMs) : snap.live.heartbeatStale ? '心跳中断' : '未运行', true)
                : row(
                    '上次重启',
                    lastDone
                      ? '成功 · ' + ago(lastDone.finishedAt)
                      : lastFailed
                        ? (launchFailed ? '未触发 · ' : '失败 · ') + ago(lastFailed.finishedAt)
                        : '无记录',
                  ),
            ),
            connLost
              ? h('p', { className: 'dshr-hint' }, '状态已停止更新，正在重试连接…')
              : h('p', { className: 'dshr-hint' }, '重启会中断当前所有进行中的回复；页面会在服务恢复后自动刷新。'),
          ),

          h(
            'section',
            { className: 'dshr-card dshr-section' },
            h(
              'div',
              { className: 'dshr-sectionHead' },
              h('h2', null, '最近重启'),
              h('span', null, snap && snap.history && snap.history.length ? '最近 ' + snap.history.length + ' 条' : '暂无'),
            ),
            snap && snap.history && snap.history.length
              ? h(
                  'ul',
                  { className: 'dshr-history' },
                  snap.history.slice(0, 8).map((item) =>
                    h(
                      'li',
                      { key: item.runId, className: 'dshr-hrow' },
                      h(
                        'span',
                        { className: 'dshr-hline' },
                        h('span', { className: 'dshr-hwhen' }, fmtStamp(item.at)),
                        h(
                          'span',
                          { className: 'dshr-tag', 'data-tone': item.ok ? 'ok' : item.code === 'LAUNCH_TIMEOUT' ? 'warn' : 'err' },
                          item.ok ? '成功' : item.code === 'LAUNCH_TIMEOUT' ? '未触发' : '失败',
                        ),
                        h('span', { className: 'dshr-hms' }, fmtMs(item.ms)),
                      ),
                      h(
                        'span',
                        { className: 'dshr-hwhat', title: item.code || item.note || '' },
                        item.ok
                          ? h('span', null, 'PID ' + (item.oldPid || '—') + ' → ', h('b', null, String(item.newPid || '—')), item.fallback ? ' · 兜底启动' : item.degraded ? ' · 降级完成' : '')
                          : h('span', null, (item.code || '失败') + (item.attempts ? ' · ' + item.attempts + ' 次尝试' : '')),
                      ),
                    ),
                  ),
                )
              : h('p', { className: 'dshr-empty' }, '还没有通过此插件重启过。点右上角按钮开始第一次。'),
            h(
              'div',
              { className: 'dshr-cmd' },
              h('code', null, diagCommand(sys)),
              h('button', { type: 'button', className: 'dshr-btn dshr-btnSm', onClick: () => onCopy(diagCommand(sys), 'status2') }, copied === 'status2' ? '已复制' : '复制'),
              h(
                'button',
                { type: 'button', className: 'dshr-btn dshr-btnSm', onClick: refresh },
                '刷新',
              ),
            ),
          ),
        ),

        showLog && snap && snap.logTail
          ? h(
              'section',
              { className: 'dshr-card dshr-section' },
              h('div', { className: 'dshr-sectionHead' }, h('h2', null, '执行器日志'), h('span', null, '尾部 6 KB')),
              h('pre', { className: 'dshr-log' }, snap.logTail),
            )
          : null,

        h(
          'footer',
          { className: 'dshr-foot' },
          h('span', null, '数据目录 ', h('code', null, sys ? sys.dataDir : '…')),
          h('span', null, '重启流程：预检 → systemctl restart → 启动握手 → 端口校验 → 失败重试 → 兜底启动'),
          lastDone ? h('span', null, '上次成功 ', ago(lastDone.finishedAt), ' · 耗时 ', fmtMs((Date.parse(lastDone.finishedAt) || 0) - (Date.parse(lastDone.startedAt) || 0))) : null,
        ),

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
