// dsh-https 浏览器端：设置页「HTTPS 接入」。
// 唯一 id 契约：__ModuleLoader__.load.id === package.json name === patch.yml insert.id。
window.__ModuleLoader__.load({
  id: "dsh-https",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    var SECTION = {
      id: "dsh-https",
      label: "HTTPS 接入",
      order: 60,
      title: "HTTPS 接入",
      desc: "网站地址、证书与访问密码",
    };
    var API = "/api/dsh-https";
    var CSS_TAG = "dsh-https/style";

    // 与「服务与重启」共用一套暖灰 + 青黛的设计语言：每页一个强调色，
    // 四级字号，直角平面卡片，浅色与深色各自成对。
    var CSS = `
      .dsh-https-page {
        --dh-card: #fbf9f4;
        --dh-soft: #f3efe6;
        --dh-sunk: #ebe5d9;
        --dh-line: #e3dbcc;
        --dh-line-strong: #d4c8b4;
        --dh-text: #2b2620;
        --dh-sub: #60584b;
        --dh-mute: #776e60;
        --dh-accent: #4c4665;
        --dh-accent-hover: #3e3955;
        --dh-on-accent: #fbf9f4;
        --dh-ok: #2c7349;
        --dh-err: #9c3b45;
        --dh-warn: #7d5b1f;
        --dh-radius: 12px;
        --dh-radius-sm: 8px;
        --dh-title: 20px;
        --dh-body: 14px;
        --dh-small: 13px;
        --dh-meta: 12px;
        --dh-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        display: flex;
        flex-direction: column;
        gap: 20px;
        width: 100%;
        max-width: 920px;
        min-width: 0;
        padding: 4px 0 48px;
        color: var(--dh-text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
        font-size: var(--dh-body);
        line-height: 1.6;
      }
      body[data-ds-dark-theme] .dsh-https-page,
      :root[data-ds-theme-source="dark"] .dsh-https-page {
        --dh-card: #211f1c;
        --dh-soft: #2b2823;
        --dh-sunk: #181613;
        --dh-line: #3b362d;
        --dh-line-strong: #4d463a;
        --dh-text: #f1ece3;
        --dh-sub: #c3baab;
        --dh-mute: #9c9384;
        --dh-accent: #cfc6e6;
        --dh-accent-hover: #ddd6ef;
        --dh-on-accent: #241f2b;
        --dh-ok: #82c99f;
        --dh-err: #e4949b;
        --dh-warn: #d8b673;
      }
      .dsh-https-page *,
      .dsh-https-page *::before,
      .dsh-https-page *::after { box-sizing: border-box; }

      .dsh-https-head h1 {
        margin: 0;
        font-size: var(--dh-title);
        font-weight: 600;
        line-height: 1.3;
        letter-spacing: -0.01em;
      }
      .dsh-https-head p {
        margin: 6px 0 0;
        color: var(--dh-sub);
        font-size: var(--dh-small);
      }

      .dsh-https-card {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px 18px;
        border: 1px solid var(--dh-line);
        border-radius: var(--dh-radius);
        background: var(--dh-card);
        min-width: 0;
      }
      .dsh-https-cardHead {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .dsh-https-cardHead h2 {
        margin: 0;
        font-size: var(--dh-body);
        font-weight: 600;
        line-height: 1.5;
      }
      .dsh-https-cardBody {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 0;
      }

      /* 顶部一句话状态 */
      .dsh-https-hero {
        gap: 14px;
        padding: 18px;
      }
      .dsh-https-heroMain {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        min-width: 0;
      }
      .dsh-https-beacon {
        width: 8px;
        height: 8px;
        margin-top: 10px;
        border-radius: 50%;
        flex: 0 0 auto;
        background: var(--dh-mute);
      }
      .dsh-https-beacon[data-tone="ok"] { background: var(--dh-ok); }
      .dsh-https-beacon[data-tone="warn"] { background: var(--dh-warn); }
      .dsh-https-beacon[data-tone="err"] { background: var(--dh-err); }
      .dsh-https-heroText { min-width: 0; }
      .dsh-https-heroTitle {
        margin: 0;
        font-size: var(--dh-title);
        font-weight: 600;
        line-height: 1.3;
        letter-spacing: -0.01em;
      }
      .dsh-https-heroMeta {
        margin: 4px 0 0;
        color: var(--dh-sub);
        font-size: var(--dh-small);
        line-height: 1.6;
        overflow-wrap: anywhere;
      }
      .dsh-https-heroMeta[data-tone="warn"] { color: var(--dh-warn); }
      .dsh-https-heroMeta[data-tone="err"] { color: var(--dh-err); }

      .dsh-https-address {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        min-width: 0;
      }
      .dsh-https-address a {
        color: var(--dh-accent);
        font-size: var(--dh-body);
        font-weight: 600;
        line-height: 1.5;
        text-decoration: none;
        overflow-wrap: anywhere;
      }
      .dsh-https-address a:hover { text-decoration: underline; }
      .dsh-https-address a:focus-visible {
        outline: 2px solid var(--dh-accent);
        outline-offset: 2px;
        border-radius: 4px;
      }

      .dsh-https-status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--dh-sub);
        font-size: var(--dh-meta);
        line-height: 1.5;
        white-space: nowrap;
      }
      .dsh-https-status .dsh-https-beacon { margin-top: 0; }
      .dsh-https-status[data-tone="ok"] { color: var(--dh-ok); }
      .dsh-https-status[data-tone="warn"] { color: var(--dh-warn); }
      .dsh-https-status[data-tone="err"] { color: var(--dh-err); }
      .dsh-https-status[data-tone="accent"] { color: var(--dh-accent); }

      .dsh-https-note {
        margin: 0;
        color: var(--dh-sub);
        font-size: var(--dh-small);
        line-height: 1.6;
        overflow-wrap: anywhere;
      }
      .dsh-https-note[data-tone="warn"] { color: var(--dh-warn); }
      .dsh-https-note[data-tone="err"] { color: var(--dh-err); }
      .dsh-https-hint {
        margin: 0;
        color: var(--dh-mute);
        font-size: var(--dh-meta);
        line-height: 1.6;
        overflow-wrap: anywhere;
      }

      /* 按钮：全页只用 --dh-accent 一个强调色 */
      .dsh-https-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 34px;
        padding: 0 14px;
        border: 1px solid var(--dh-line-strong);
        border-radius: var(--dh-radius-sm);
        background: var(--dh-card);
        color: var(--dh-text);
        font: inherit;
        font-size: var(--dh-small);
        font-weight: 500;
        line-height: 1;
        text-decoration: none;
        white-space: nowrap;
        cursor: pointer;
        transition: background-color .15s ease, border-color .15s ease;
      }
      .dsh-https-btn:hover { background: var(--dh-soft); }
      .dsh-https-btn:active { background: var(--dh-sunk); }
      .dsh-https-btn:focus-visible {
        outline: 2px solid var(--dh-accent);
        outline-offset: 2px;
      }
      .dsh-https-btn:disabled { opacity: .5; cursor: not-allowed; }
      .dsh-https-btn:disabled:hover { background: var(--dh-card); }
      .dsh-https-btnPrimary {
        border-color: transparent;
        background: var(--dh-accent);
        color: var(--dh-on-accent);
      }
      .dsh-https-btnPrimary:hover { background: var(--dh-accent-hover); }
      .dsh-https-btnPrimary:active { background: var(--dh-accent-hover); }
      .dsh-https-btnPrimary:disabled,
      .dsh-https-btnPrimary:disabled:hover {
        opacity: 1;
        border-color: var(--dh-line);
        background: var(--dh-sunk);
        color: var(--dh-mute);
      }
      .dsh-https-btnGhost {
        border-color: transparent;
        background: transparent;
        color: var(--dh-sub);
      }
      .dsh-https-btnGhost:hover { background: var(--dh-soft); color: var(--dh-text); }
      .dsh-https-btnSm {
        height: 28px;
        padding: 0 10px;
        font-size: var(--dh-meta);
      }
      .dsh-https-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      /* 提示条：中性底 + 细边，只让左侧细线表达语气 */
      .dsh-https-callout {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 12px;
        border: 1px solid var(--dh-line);
        border-left: 3px solid var(--dh-line-strong);
        border-radius: var(--dh-radius-sm);
        background: var(--dh-soft);
        color: var(--dh-sub);
        font-size: var(--dh-small);
        line-height: 1.6;
        overflow-wrap: anywhere;
      }
      .dsh-https-callout[data-tone="err"] { border-left-color: var(--dh-err); }
      .dsh-https-callout[data-tone="warn"] { border-left-color: var(--dh-warn); }
      .dsh-https-callout[data-tone="ok"] { border-left-color: var(--dh-ok); }
      .dsh-https-callout:has(.dsh-https-btn) { align-items: center; }
      .dsh-https-calloutBody { flex: 1; min-width: 0; }
      .dsh-https-calloutTitle {
        color: var(--dh-text);
        font-weight: 600;
        margin-bottom: 2px;
      }

      /* 键值行：标签在上、值在下，长路径不截断 */
      .dsh-https-rows {
        display: flex;
        flex-direction: column;
        margin: 0;
      }
      .dsh-https-row {
        display: grid;
        grid-template-columns: 84px minmax(0, 1fr);
        gap: 12px;
        padding: 8px 0;
        border-top: 1px solid var(--dh-line);
      }
      .dsh-https-row:first-child { border-top: 0; padding-top: 0; }
      .dsh-https-row:last-child { padding-bottom: 0; }
      .dsh-https-row dt {
        color: var(--dh-sub);
        font-size: var(--dh-meta);
        line-height: 20px;
      }
      .dsh-https-row dd {
        margin: 0;
        color: var(--dh-text);
        font-size: var(--dh-small);
        line-height: 20px;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .dsh-https-row dd.dsh-https-mono {
        font-family: var(--dh-mono);
        font-size: var(--dh-meta);
        line-height: 1.6;
      }

      .dsh-https-details {
        border-top: 1px solid var(--dh-line);
        padding-top: 10px;
      }
      .dsh-https-details > summary {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--dh-sub);
        font-size: var(--dh-meta);
        line-height: 1.6;
        list-style: none;
        cursor: pointer;
      }
      .dsh-https-details > summary::-webkit-details-marker { display: none; }
      .dsh-https-details > summary::before {
        content: "+";
        display: inline-block;
        width: 10px;
        color: var(--dh-mute);
        text-align: center;
      }
      .dsh-https-details[open] > summary::before { content: "−"; }
      .dsh-https-details[open] > summary { margin-bottom: 8px; }
      .dsh-https-detailsBody { min-width: 0; }

      /* 证书来源切换：外 10px、内 8px 同心圆角，不做嵌套卡片 */
      .dsh-https-seg {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border: 1px solid var(--dh-line);
        border-radius: 10px;
        background: var(--dh-sunk);
        align-self: flex-start;
      }
      .dsh-https-seg button {
        height: 28px;
        padding: 0 12px;
        border: 1px solid transparent;
        border-radius: var(--dh-radius-sm);
        background: transparent;
        color: var(--dh-sub);
        font: inherit;
        font-size: var(--dh-meta);
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
      }
      .dsh-https-seg button:hover { color: var(--dh-text); }
      .dsh-https-seg button[aria-pressed="true"] {
        border-color: var(--dh-line-strong);
        background: var(--dh-card);
        color: var(--dh-text);
      }
      .dsh-https-seg button:focus-visible {
        outline: 2px solid var(--dh-accent);
        outline-offset: 1px;
      }
      .dsh-https-editor {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--dh-line);
      }

      .dsh-https-fields {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .dsh-https-field {
        display: flex;
        flex-direction: column;
        gap: 5px;
        min-width: 0;
      }
      .dsh-https-label {
        color: var(--dh-sub);
        font-size: var(--dh-meta);
        line-height: 1.5;
      }
      .dsh-https-input {
        width: 100%;
        height: 36px;
        padding: 0 10px;
        border: 1px solid var(--dh-line-strong);
        border-radius: var(--dh-radius-sm);
        background: var(--dh-card);
        color: var(--dh-text);
        font: inherit;
        font-size: var(--dh-small);
        line-height: 1.5;
        min-width: 0;
      }
      .dsh-https-input::placeholder { color: var(--dh-mute); opacity: 1; }
      .dsh-https-input:focus {
        outline: 2px solid var(--dh-accent);
        outline-offset: 1px;
        border-color: var(--dh-accent);
      }
      .dsh-https-check {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        color: var(--dh-text);
        font-size: var(--dh-small);
        line-height: 1.5;
        cursor: pointer;
      }
      .dsh-https-check input {
        width: 15px;
        height: 15px;
        margin: 2px 0 0;
        accent-color: var(--dh-accent);
        flex: 0 0 auto;
      }
      .dsh-https-subhead {
        display: flex;
        align-items: baseline;
        gap: 8px;
        color: var(--dh-text);
        font-size: var(--dh-small);
        font-weight: 600;
      }
      .dsh-https-tag {
        display: inline-flex;
        align-items: center;
        height: 20px;
        padding: 0 7px;
        border: 1px solid var(--dh-line-strong);
        border-radius: 6px;
        color: var(--dh-mute);
        font-size: var(--dh-meta);
        font-weight: 400;
        white-space: nowrap;
      }
      .dsh-https-warnList {
        margin: 0;
        padding-left: 18px;
        color: var(--dh-sub);
        font-size: var(--dh-meta);
        line-height: 1.7;
      }
      .dsh-https-spacer { flex: 1 1 auto; }
      .dsh-https-empty {
        margin: 0;
        color: var(--dh-mute);
        font-size: var(--dh-small);
      }

      @media (max-width: 560px) {
        .dsh-https-page { gap: 16px; padding-bottom: 32px; }
        .dsh-https-card { padding: 14px; }
        .dsh-https-hero { padding: 16px 14px; }
        .dsh-https-fields { grid-template-columns: 1fr; }
        .dsh-https-row { grid-template-columns: 1fr; gap: 1px; }
        .dsh-https-row dt { line-height: 1.5; }
      }
    `;

    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.getElementById(CSS_TAG)) return;
      var style = document.createElement("style");
      style.id = CSS_TAG;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    function fmtDate(value) {
      if (!value) return "—";
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
    }

    function fmtDateTime(value) {
      if (!value) return "—";
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    }

    function fmtFingerprint(value) {
      if (!value) return "—";
      var hex = String(value).replace(/[^0-9a-f]/gi, "").toUpperCase();
      return (hex.match(/.{2}/g) || []).join(":");
    }

    function listText(items) {
      var list = (items || []).map(function (item) {
        return item && item.value ? String(item.value) : String(item || "");
      }).filter(Boolean);
      return list.length ? list.join("、") : "—";
    }

    function expiryText(notAfter, daysLeft) {
      var date = fmtDate(notAfter);
      if (typeof daysLeft !== "number") return date;
      if (daysLeft < 0) return date + "（已过期 " + Math.abs(daysLeft) + " 天）";
      if (daysLeft === 0) return date + "（今天到期）";
      if (daysLeft === 1) return date + "（明天到期）";
      return date + "（还有 " + daysLeft + " 天）";
    }

    function expiryLine(notAfter, daysLeft) {
      var date = fmtDate(notAfter);
      if (typeof daysLeft !== "number") return date;
      if (daysLeft < 0) return date + "（已过期 " + Math.abs(daysLeft) + " 天）";
      if (daysLeft === 0) return date + "（今天到期）";
      if (daysLeft === 1) return date + "（明天到期）";
      return date + "到期（还有 " + daysLeft + " 天）";
    }

    function modeName(mode) {
      if (mode === "acme") return "自动证书";
      if (mode === "local") return "本地 CA";
      if (mode === "files") return "证书文件";
      return "未设置";
    }

    function certState(cert) {
      if (!cert || !cert.available) {
        return { tone: cert && cert.error ? "err" : "warn", label: cert && cert.error ? "证书错误" : "证书未就绪" };
      }
      if (typeof cert.daysLeft === "number" && cert.daysLeft < 0) return { tone: "err", label: "证书已过期" };
      if (typeof cert.daysLeft === "number" && cert.daysLeft <= 0) return { tone: "err", label: "证书今天到期" };
      if (typeof cert.daysLeft === "number" && cert.daysLeft <= 14) return { tone: "warn", label: "证书即将到期" };
      return { tone: "ok", label: "证书有效" };
    }

    function acmeState(acme) {
      if (!acme || !acme.enabled) return "未启用";
      if (!acme.usable) return "待配置";
      if (acme.phase === "issuing") return "正在申请";
      if (acme.phase === "error") return "申请失败";
      if (acme.phase === "valid" || acme.phase === "ready") return "已生效";
      return "已启用";
    }

    function statusNode(text, tone) {
      return h(
        "span",
        { className: "dsh-https-status", "data-tone": tone || "mute" },
        h("span", { className: "dsh-https-beacon", "aria-hidden": "true" }),
        text
      );
    }

    function card(title, status, body) {
      return h(
        "section",
        { className: "dsh-https-card" },
        h("div", { className: "dsh-https-cardHead" }, h("h2", null, title), status || null),
        h("div", { className: "dsh-https-cardBody" }, body)
      );
    }

    function rows(items) {
      var list = (items || []).filter(Boolean);
      return h(
        "dl",
        { className: "dsh-https-rows" },
        list.map(function (item, index) {
          return h(
            "div",
            { className: "dsh-https-row", key: item.key || index },
            h("dt", null, item.label),
            h("dd", { className: item.mono ? "dsh-https-mono" : undefined }, item.value)
          );
        })
      );
    }

    function details(summaryText, body) {
      return h(
        "details",
        { className: "dsh-https-details" },
        h("summary", null, summaryText),
        h("div", { className: "dsh-https-detailsBody" }, body)
      );
    }

    function callout(tone, title, body, action) {
      return h(
        "div",
        { className: "dsh-https-callout", "data-tone": tone || "info" },
        h(
          "div",
          { className: "dsh-https-calloutBody" },
          title ? h("div", { className: "dsh-https-calloutTitle" }, title) : null,
          h("div", null, body)
        ),
        action || null
      );
    }

    function field(label, control, hint) {
      return h(
        "label",
        { className: "dsh-https-field" },
        h("span", { className: "dsh-https-label" }, label),
        control,
        hint ? h("span", { className: "dsh-https-hint" }, hint) : null
      );
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () {
          return true;
        }).catch(function () {
          return fallbackCopy(text);
        });
      }
      return Promise.resolve(fallbackCopy(text));
    }

    function fallbackCopy(text) {
      try {
        var area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        var copied = document.execCommand("copy");
        document.body.removeChild(area);
        return copied;
      } catch (error) {
        return false;
      }
    }

    function HttpsPage() {
      ensureCss();
      var stateHook = React.useState({ loading: true, error: null, data: null });
      var state = stateHook[0];
      var setState = stateHook[1];
      var busyHook = React.useState(null);
      var busy = busyHook[0];
      var setBusy = busyHook[1];
      var noticeHook = React.useState(null);
      var notice = noticeHook[0];
      var setNotice = noticeHook[1];
      var copiedHook = React.useState("");
      var copied = copiedHook[0];
      var setCopied = copiedHook[1];
      var certOpenHook = React.useState(null);
      var certOpenState = certOpenHook[0];
      var setCertOpen = certOpenHook[1];
      var passwordOpenHook = React.useState(false);
      var passwordOpen = passwordOpenHook[0];
      var setPasswordOpen = passwordOpenHook[1];

      function load(silent) {
        if (!silent) {
          setState(function (prev) {
            return { loading: true, error: null, data: prev.data };
          });
        }
        return fetch(API + "/status", { credentials: "same-origin", cache: "no-store" })
          .then(function (response) {
            return response.json().then(function (body) {
              if (!response.ok) throw new Error(body && body.error ? body.error : "HTTP " + response.status);
              return body;
            });
          })
          .then(function (body) {
            setState({ loading: false, error: null, data: body });
          })
          .catch(function (error) {
            setState(function (prev) {
              return { loading: false, error: String(error && error.message ? error.message : error), data: prev.data };
            });
          });
      }

      React.useEffect(function () {
        load(true);
        var timer = setInterval(function () { load(true); }, 15000);
        return function () { clearInterval(timer); };
      }, []);

      React.useEffect(function () {
        if (!notice || notice.tone !== "ok") return undefined;
        var timer = setTimeout(function () { setNotice(null); }, 6000);
        return function () { clearTimeout(timer); };
      }, [notice]);

      var data = state.data;
      var listener = (data && data.listener) || {};
      var certs = (data && data.certs) || {};
      var acme = (data && data.acme) || {};
      var settings = (data && data.settings) || {};
      var settingsAcme = settings.acme || {};
      var credentials = settings.credentials || {};
      var auth = (data && data.auth) || settings.auth || {};
      var urls = data && data.publicUrls && Array.isArray(data.publicUrls.https) ? data.publicUrls.https : [];
      var running = Boolean(data && data.started && listener.running);
      var warnings = (data && data.warnings) || [];
      var errors = (data && data.errors) || [];
      var publicCert = certs.public || null;
      var localCert = certs.local || null;
      var localActive = Boolean(certs.defaultSource === "local" && localCert && localCert.available);
      var mainCert = localActive ? localCert : publicCert;
      var mainState = certState(mainCert);
      var certFile = settings.files && settings.files.certFile ? settings.files.certFile : "";

      var draftHook = React.useState({ mode: "files", email: "", domains: "", zone: "", staging: true, secretId: "" });
      var draft = draftHook[0];
      var setDraft = draftHook[1];
      var secretKeyHook = React.useState("");
      var secretKey = secretKeyHook[0];
      var setSecretKey = secretKeyHook[1];
      var authDraftHook = React.useState({ current: "", next: "", confirm: "" });
      var authDraft = authDraftHook[0];
      var setAuthDraft = authDraftHook[1];

      var serverSig = [
        settings.mode || "",
        settingsAcme.email || "",
        (settingsAcme.domains || []).join(","),
        settingsAcme.zone || "",
        String(settingsAcme.staging),
      ].join("|");
      var sigHook = React.useState("");

      React.useEffect(function () {
        if (!data) return;
        if (sigHook[0] === serverSig) return;
        sigHook[1](serverSig);
        setDraft({
          mode: settings.mode || "files",
          email: settingsAcme.email || "",
          domains: (settingsAcme.domains || []).join(", "),
          zone: settingsAcme.zone || "",
          staging: settingsAcme.staging !== false,
          secretId: "",
        });
        setSecretKey("");
      }, [serverSig, data]);

      var certOpen = certOpenState === null ? settings.mode === "acme" : certOpenState;

      function messageOf(error) {
        return String(error && error.message ? error.message : error);
      }

      function postJson(path, body) {
        return fetch(API + path, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then(function (response) {
          return response.json().then(function (payload) {
            if (!response.ok || !payload || payload.ok === false) {
              throw new Error((payload && payload.error) || "HTTP " + response.status);
            }
            return payload;
          });
        });
      }

      function copyAddress(url) {
        copyText(url).then(function (ok) {
          if (!ok) {
            setNotice({ tone: "warn", text: "复制失败，请手动选中地址复制。" });
            return;
          }
          setCopied(url);
          setTimeout(function () { setCopied(""); }, 1800);
        });
      }

      function renew() {
        if (busy) return;
        setBusy("renew");
        setNotice(null);
        postJson("/renew", { force: true })
          .then(function () {
            setNotice({ tone: "ok", text: "已开始续期，证书就绪后会自动切换。" });
            setTimeout(function () { load(true); }, 3000);
            setTimeout(function () { load(true); }, 10000);
          })
          .catch(function (error) {
            setNotice({ tone: "bad", text: messageOf(error) });
          })
          .then(function () { setBusy(null); });
      }

      function saveCert(event) {
        if (event) event.preventDefault();
        if (busy) return;
        var nextMode = draft.mode;
        if (nextMode !== "files" && nextMode !== "acme") {
          setNotice({ tone: "warn", text: "先选择一种证书方式。" });
          return;
        }
        var email = String(draft.email || "").trim();
        var domains = String(draft.domains || "").trim();
        var zone = String(draft.zone || "").trim();
        var secretId = String(draft.secretId || "").trim();
        var secretKeyValue = String(secretKey || "").trim();
        if (nextMode === "acme") {
          if (!email || email.indexOf("@") <= 0 || email.indexOf(".", email.indexOf("@")) < 0) {
            setNotice({ tone: "bad", text: "请填写有效的邮箱地址。" });
            return;
          }
          if (!domains) {
            setNotice({ tone: "bad", text: "请填写要申请证书的域名。" });
            return;
          }
          if ((secretId && !secretKeyValue) || (!secretId && secretKeyValue)) {
            setNotice({ tone: "bad", text: "SecretId 和 SecretKey 要一起填写。" });
            return;
          }
          if (!credentials.configured && (!secretId || !secretKeyValue)) {
            setNotice({ tone: "bad", text: "请填写腾讯云的 SecretId 和 SecretKey。" });
            return;
          }
        }
        setBusy("cert");
        setNotice(null);
        var patch = { mode: nextMode };
        if (nextMode === "acme") {
          patch.acme = {
            email: email,
            domains: domains,
            zone: zone,
            staging: Boolean(draft.staging),
          };
        }
        postJson("/settings", patch)
          .then(function (body) {
            if (nextMode === "acme" && secretId && secretKeyValue) {
              return postJson("/credentials", { secretId: secretId, secretKey: secretKeyValue }).then(function () {
                return body;
              });
            }
            return body;
          })
          .then(function (body) {
            if (body && body.status) setState({ loading: false, error: null, data: body.status });
            setDraft(function (prev) {
              return {
                mode: prev.mode,
                email: prev.email,
                domains: prev.domains,
                zone: prev.zone,
                staging: prev.staging,
                secretId: "",
              };
            });
            setSecretKey("");
            setNotice({
              tone: "ok",
              text: nextMode === "acme" ? "已保存，正在申请证书。签发成功后会显示在这里。" : "已改用证书文件。",
            });
            setTimeout(function () { load(true); }, 2500);
            if (nextMode === "acme") setTimeout(function () { load(true); }, 9000);
          })
          .catch(function (error) {
            setNotice({ tone: "bad", text: messageOf(error) });
          })
          .then(function () { setBusy(null); });
      }

      function savePassword(event) {
        if (event) event.preventDefault();
        if (busy) return;
        if (!authDraft.next || authDraft.next.length < 8) {
          setNotice({ tone: "bad", text: "新密码至少要有 8 位。" });
          return;
        }
        if (authDraft.next !== authDraft.confirm) {
          setNotice({ tone: "bad", text: "两次输入的新密码不一样。" });
          return;
        }
        setBusy("password");
        setNotice(null);
        postJson("/auth/password", {
          currentPassword: authDraft.current,
          newPassword: authDraft.next,
          confirmPassword: authDraft.confirm,
        })
          .then(function () {
            setAuthDraft({ current: "", next: "", confirm: "" });
            setPasswordOpen(false);
            setNotice({ tone: "ok", text: "密码已更新，请用新密码登录。" });
            setTimeout(function () {
              if (typeof window !== "undefined") {
                window.location.assign((auth.loginPath || "/dsh-https/auth/login") + "?changed=1");
              }
            }, 1200);
          })
          .catch(function (error) {
            setNotice({ tone: "bad", text: messageOf(error) });
          })
          .then(function () { setBusy(null); });
      }

      var header = h(
        "header",
        { className: "dsh-https-head" },
        h("h1", null, SECTION.title),
        h("p", null, SECTION.desc)
      );

      if (!data && state.loading) {
        return h("div", { className: "dsh-https-page" }, header, h("div", { className: "dsh-https-card" }, h("p", { className: "dsh-https-empty" }, "正在读取状态…")));
      }

      var heroTone = "ok";
      var heroTitle = "网站正常运行";
      var heroMetaTone = "mute";
      var heroMeta = mainCert && mainCert.available
        ? (localActive ? "本地证书有效，" : "证书有效，") + expiryLine(localActive ? localCert.leafNotAfter : publicCert.notAfter, localActive ? localCert.leafDaysLeft : publicCert.daysLeft)
        : "还没有读到可用的证书。";
      if (state.error) {
        heroTone = "err";
        heroTitle = "读取状态失败";
        heroMeta = "暂时无法读取 HTTPS 服务状态。";
        heroMetaTone = "err";
      } else if (data && !running) {
        heroTone = "err";
        heroTitle = "网站打不开";
        heroMeta = "HTTPS 服务没有在运行。如果刚改过设置，请稍等几秒再刷新。";
        heroMetaTone = "err";
      } else if (data && data.error) {
        heroTone = "err";
        heroTitle = "配置有问题";
        heroMeta = "HTTPS 配置没有通过检查，请看下面的说明。";
        heroMetaTone = "err";
      } else if (mainState.tone === "err") {
        heroTone = "err";
        heroTitle = "证书有问题";
        heroMeta = mainState.label + "。" + heroMeta;
        heroMetaTone = "err";
      } else if (mainState.tone === "warn") {
        heroTone = "warn";
        heroTitle = "证书快到期了";
        heroMetaTone = "warn";
      }

      var heroAddresses = urls.length
        ? urls.map(function (url) {
            return h(
              "div",
              { key: url, className: "dsh-https-address" },
              h("a", { href: url, target: "_blank", rel: "noreferrer" }, url),
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-https-btn dsh-https-btnSm",
                  onClick: function () { copyAddress(url); },
                  "aria-live": "polite",
                },
                copied === url ? "已复制" : "复制"
              )
            );
          })
        : h("p", { className: "dsh-https-empty" }, "还没有生成可访问的地址。");

      var hero = h(
        "section",
        { className: "dsh-https-card dsh-https-hero" },
        h(
          "div",
          { className: "dsh-https-heroMain" },
          h("span", { className: "dsh-https-beacon", "data-tone": heroTone, "aria-hidden": "true" }),
          h(
            "div",
            { className: "dsh-https-heroText" },
            h("h2", { className: "dsh-https-heroTitle" }, heroTitle),
            h("p", { className: "dsh-https-heroMeta", "data-tone": heroMetaTone }, heroMeta)
          )
        ),
        heroAddresses,
        details(
          "技术详情",
          rows([
            { label: "监听地址", value: (listener.host || "—") + ":" + (listener.actualPort || listener.port || "—"), mono: true },
            { label: "转发到", value: data && data.upstream ? data.upstream.protocol + "://" + data.upstream.host + ":" + data.upstream.port : "—", mono: true },
            { label: "版本", value: data && data.version ? "v" + data.version : "—" },
          ])
        )
      );

      var alerts = [];
      if (state.error) {
        alerts.push(
          callout(
            "err",
            "读取状态失败",
            state.error,
            h("button", { type: "button", className: "dsh-https-btn dsh-https-btnSm", onClick: function () { load(false); } }, "重试")
          )
        );
      }
      if (notice) {
        alerts.push(callout(notice.tone === "bad" ? "err" : notice.tone === "warn" ? "warn" : "ok", null, notice.text));
      }
      errors.forEach(function (message) {
        alerts.push(callout("err", null, message));
      });

      var certBody = [];
      if (localActive) {
        certBody.push(
          rows([
            { label: "来源", value: "本地 CA" },
            { label: "根证书", value: localCert.caFile || "—", mono: true },
            { label: "根证书到期", value: expiryText(localCert.caNotAfter, null) },
            { label: "站点证书到期", value: expiryText(localCert.leafNotAfter, localCert.leafDaysLeft) },
            { label: "覆盖名称", value: listText(localCert.sans) },
          ])
        );
        certBody.push(
          h(
            "div",
            { className: "dsh-https-actions" },
            h("a", { className: "dsh-https-btn dsh-https-btnSm", href: "/dsh-https/" }, "安装说明"),
            h("a", { className: "dsh-https-btn dsh-https-btnSm", href: "/dsh-https/ca.crt" }, "下载证书")
          )
        );
      } else {
        if (publicCert && publicCert.available) {
          certBody.push(
            rows([
              { label: "来源", value: modeName(settings.mode || (publicCert.source === "acme" ? "acme" : "files")) },
              settings.mode !== "acme" && certFile ? { label: "文件", value: certFile, mono: true } : null,
              settings.mode === "acme" ? { label: "自动续期", value: acmeState(acme) } : null,
              { label: "域名", value: listText(publicCert.san) },
              { label: "有效期至", value: expiryText(publicCert.notAfter, publicCert.daysLeft) },
            ])
          );
          if (settings.mode !== "acme" && certFile) {
            certBody.push(h("p", { className: "dsh-https-hint" }, "证书文件被替换后，网站会自动读取新文件。"));
          }
        } else {
          certBody.push(
            callout(
              publicCert && publicCert.error ? "err" : "warn",
              publicCert && publicCert.error ? "证书有问题" : "还没有读到证书",
              publicCert && publicCert.error ? publicCert.error : "请检查服务器上的证书文件，或改用自动证书。"
            )
          );
          certBody.push(rows([{ label: "来源", value: modeName(settings.mode) }, certFile ? { label: "文件", value: certFile, mono: true } : null]));
        }
        if (publicCert && publicCert.staging) {
          certBody.push(callout("warn", "这是测试证书", "它由 Let's Encrypt 测试环境签发，浏览器不会信任。正式使用前请关闭测试环境。"));
        }
        if (settings.mode === "acme" && acme.lastError) {
          certBody.push(callout("err", "最近一次申请失败", acme.lastError));
        }
        if (settings.mode === "acme" && acme.phase === "issuing") {
          certBody.push(h("p", { className: "dsh-https-note" }, "正在申请证书，完成后会自动生效。"));
        }
        if (settings.mode === "acme" && acme.usable) {
          certBody.push(
            h(
              "div",
              { className: "dsh-https-actions" },
              h(
                "button",
                { type: "button", className: "dsh-https-btn dsh-https-btnSm", onClick: renew, disabled: Boolean(busy) },
                busy === "renew" ? "续期中…" : "立即续期"
              ),
              h("span", { className: "dsh-https-hint" }, "到期前会自动续期。")
            )
          );
        }
        if (publicCert && publicCert.available) {
          certBody.push(
            details(
              "证书详情",
              rows([
                { label: "签发者", value: publicCert.issuer || "—", mono: true },
                { label: "指纹", value: fmtFingerprint(publicCert.fingerprintSha256), mono: true },
                { label: "证书链", value: publicCert.chainLength ? publicCert.chainLength + " 张证书" : "—" },
                settings.mode === "acme" ? { label: "上次签发", value: fmtDateTime(acme.lastSuccess) } : null,
                settings.mode === "acme" ? { label: "下次检查", value: fmtDateTime(acme.nextAttempt) } : null,
              ])
            )
          );
        }
      }

      var modeButtons = h(
        "div",
        { className: "dsh-https-seg", role: "group", "aria-label": "证书来源" },
        ["files", "acme"].map(function (mode) {
          return h(
            "button",
            {
              key: mode,
              type: "button",
              "aria-pressed": draft.mode === mode ? "true" : "false",
              onClick: function () { setDraft(Object.assign({}, draft, { mode: mode })); },
            },
            mode === "files" ? "证书文件" : "自动证书"
          );
        })
      );

      var certFields = [];
      if (draft.mode === "acme") {
        certFields.push(
          h(
            "div",
            { className: "dsh-https-fields" },
            field(
              "邮箱",
              h("input", {
                className: "dsh-https-input",
                type: "email",
                value: draft.email,
                placeholder: "you@example.com",
                autoComplete: "email",
                onChange: function (event) { setDraft(Object.assign({}, draft, { email: event.target.value })); },
              })
            ),
            field(
              "域名",
              h("input", {
                className: "dsh-https-input",
                type: "text",
                value: draft.domains,
                placeholder: "dsh.example.com",
                onChange: function (event) { setDraft(Object.assign({}, draft, { domains: event.target.value })); },
              }),
              "多个域名用逗号隔开。"
            )
          )
        );
        var keyFields = h(
          "div",
          { className: "dsh-https-fields" },
          field(
            "SecretId",
            h("input", {
              className: "dsh-https-input",
              type: "text",
              value: draft.secretId,
              placeholder: credentials.configured ? "已保存，留空不改" : "AKID…",
              autoComplete: "off",
              onChange: function (event) { setDraft(Object.assign({}, draft, { secretId: event.target.value })); },
            })
          ),
          field(
            "SecretKey",
            h("input", {
              className: "dsh-https-input",
              type: "password",
              value: secretKey,
              placeholder: credentials.configured ? "已保存，留空不改" : "请输入 SecretKey",
              autoComplete: "new-password",
              onChange: function (event) { setSecretKey(event.target.value); },
            })
          )
        );
        var keyHint = h(
          "p",
          { className: "dsh-https-hint" },
          "在腾讯云控制台的「访问管理 → API 密钥」里创建。密钥只保存在这台服务器上。"
        );
        if (credentials.configured) {
          certFields.push(
            details(
              "腾讯云密钥（已保存）",
              h("div", { className: "dsh-https-cardBody" }, keyHint, keyFields)
            )
          );
        } else {
          certFields.push(
            h("div", { className: "dsh-https-subhead" }, "腾讯云密钥"),
            keyHint,
            keyFields
          );
        }
        certFields.push(
          details(
            "高级选项",
            h(
              "div",
              { className: "dsh-https-cardBody" },
              field(
                "DNS 区域",
                h("input", {
                  className: "dsh-https-input",
                  type: "text",
                  value: draft.zone,
                  placeholder: "example.com",
                  onChange: function (event) { setDraft(Object.assign({}, draft, { zone: event.target.value })); },
                }),
                "通常留空，插件会自动判断。"
              ),
              h(
                "label",
                { className: "dsh-https-check" },
                h("input", {
                  type: "checkbox",
                  checked: Boolean(draft.staging),
                  onChange: function (event) { setDraft(Object.assign({}, draft, { staging: event.target.checked })); },
                }),
                h("span", null, "先用测试环境申请（浏览器不会信任证书）")
              ),
              draft.staging
                ? h("p", { className: "dsh-https-hint" }, "测试证书只用于排查问题。正式使用前请取消勾选，再保存一次。")
                : null
            )
          )
        );
      } else if (draft.mode === "files") {
        certFields.push(
          h("p", { className: "dsh-https-hint" }, "使用服务器上的证书文件。换证书时直接替换文件，这里不用改。")
        );
      } else {
        certFields.push(h("p", { className: "dsh-https-hint" }, "选择一种公网证书方式后保存。"));
      }

      var certEditor = h(
        "div",
        { className: "dsh-https-editor" },
        modeButtons,
        h(
          "form",
          { onSubmit: saveCert },
          h(
            "div",
            { className: "dsh-https-cardBody" },
            certFields,
            h(
              "div",
              { className: "dsh-https-actions" },
              h(
                "button",
                { type: "submit", className: "dsh-https-btn dsh-https-btnPrimary", disabled: Boolean(busy) || (draft.mode !== "files" && draft.mode !== "acme") },
                busy === "cert" ? "保存中…" : "保存"
              )
            )
          )
        )
      );

      var certCard = card(
        "证书",
        statusNode(mainState.label, mainState.tone),
        h(
          "div",
          { className: "dsh-https-cardBody" },
          certBody,
          h(
            "button",
            {
              type: "button",
              className: "dsh-https-btn dsh-https-btnGhost",
              onClick: function () { setCertOpen(!certOpen); },
              "aria-expanded": certOpen ? "true" : "false",
            },
            certOpen ? "收起" : "更换证书来源"
          ),
          certOpen ? certEditor : null
        )
      );

      var authOn = Boolean(auth.enabled);
      var authReady = Boolean(auth.configured);
      var authStatus = authOn ? (authReady ? statusNode("已开启", "ok") : statusNode("还没有密码", "warn")) : statusNode("未开启", "mute");
      var authBody = [];
      if (authOn && authReady) {
        authBody.push(
          h(
            "p",
            { className: "dsh-https-note" },
            "打开网站时需要输入密码。登录一次后，这台设备 " + (auth.sessionMaxAgeDays || 30) + " 天内不用再输。"
          )
        );
        authBody.push(
          h(
            "div",
            { className: "dsh-https-actions" },
            h(
              "button",
              {
                type: "button",
                className: "dsh-https-btn",
                onClick: function () { setPasswordOpen(!passwordOpen); },
                "aria-expanded": passwordOpen ? "true" : "false",
              },
              passwordOpen ? "取消" : "修改密码"
            ),
            h(
              "a",
              { className: "dsh-https-btn dsh-https-btnGhost", href: (auth.loginPath || "/dsh-https/auth/login").replace(/\/login$/, "") + "/logout" },
              "退出登录"
            )
          )
        );
        if (passwordOpen) {
          authBody.push(
            h(
              "form",
              { className: "dsh-https-editor", onSubmit: savePassword },
              h("p", { className: "dsh-https-hint" }, "保存后所有设备都会退出登录，需要用新密码重新登录。"),
              h(
                "div",
                { className: "dsh-https-fields" },
                field(
                  "当前密码",
                  h("input", {
                    className: "dsh-https-input",
                    type: "password",
                    value: authDraft.current,
                    autoComplete: "current-password",
                    autoFocus: true,
                    onChange: function (event) { setAuthDraft(Object.assign({}, authDraft, { current: event.target.value })); },
                  })
                ),
                field(
                  "新密码（至少 8 位）",
                  h("input", {
                    className: "dsh-https-input",
                    type: "password",
                    value: authDraft.next,
                    autoComplete: "new-password",
                    onChange: function (event) { setAuthDraft(Object.assign({}, authDraft, { next: event.target.value })); },
                  })
                ),
                field(
                  "确认新密码",
                  h("input", {
                    className: "dsh-https-input",
                    type: "password",
                    value: authDraft.confirm,
                    autoComplete: "new-password",
                    onChange: function (event) { setAuthDraft(Object.assign({}, authDraft, { confirm: event.target.value })); },
                  })
                )
              ),
              h(
                "div",
                { className: "dsh-https-actions" },
                h(
                  "button",
                  { type: "submit", className: "dsh-https-btn dsh-https-btnPrimary", disabled: Boolean(busy) },
                  busy === "password" ? "保存中…" : "保存新密码"
                )
              )
            )
          );
        }
      } else if (authOn && !authReady) {
        authBody.push(
          callout("warn", "还没有访问密码", "这个地址现在没有密码。先设置一个，再继续使用。")
        );
        authBody.push(
          h(
            "div",
            { className: "dsh-https-actions" },
            h("a", { className: "dsh-https-btn dsh-https-btnPrimary", href: auth.loginPath || "/dsh-https/auth/login" }, "设置密码")
          )
        );
      } else {
        authBody.push(
          h("p", { className: "dsh-https-note" }, "这个地址不需要密码，能访问它的人都可以直接打开 DSH。"),
          h("p", { className: "dsh-https-hint" }, "要开启登录保护，需要修改插件配置并重启 DSH Web。")
        );
      }
      var authCard = card("访问密码", authStatus, h("div", { className: "dsh-https-cardBody" }, authBody));

      var localCard = null;
      if (localCert && localCert.enabled && !localActive) {
        var localState = certState(localCert);
        var localBody = [];
        if (localCert.available) {
          localBody.push(h("p", { className: "dsh-https-note" }, "给局域网设备安装这张证书后，用局域网地址访问就不会再提示不安全。"));
          localBody.push(
            rows([
              { label: "根证书", value: localCert.caFile || "—", mono: true },
              { label: "根证书到期", value: expiryText(localCert.caNotAfter, null) },
              { label: "站点证书到期", value: expiryText(localCert.leafNotAfter, localCert.leafDaysLeft) },
            ])
          );
          localBody.push(
            h(
              "div",
              { className: "dsh-https-actions" },
              h("a", { className: "dsh-https-btn dsh-https-btnSm", href: "/dsh-https/" }, "安装说明"),
              h("a", { className: "dsh-https-btn dsh-https-btnSm", href: "/dsh-https/ca.crt" }, "下载证书")
            )
          );
          localBody.push(
            details(
              "证书详情",
              rows([
                { label: "覆盖名称", value: listText(localCert.sans) },
                { label: "根指纹", value: fmtFingerprint(localCert.caFingerprintSha256), mono: true },
                { label: "私钥权限", value: localCert.caKeyMode ? "0o" + (Number(localCert.caKeyMode) & 0o777).toString(8).padStart(3, "0") : "—", mono: true },
              ])
            )
          );
        } else {
          localBody.push(
            callout("warn", "本地 CA 还没有准备好", localCert.error || "稍后再试。")
          );
        }
        localCard = card("本地 CA", statusNode(localState.label, localState.tone), h("div", { className: "dsh-https-cardBody" }, localBody));
      }

      var warningsNode = warnings.length
        ? details(
            "配置提醒（" + warnings.length + "）",
            h(
              "ul",
              { className: "dsh-https-warnList" },
              warnings.map(function (message, index) {
                return h("li", { key: index }, message);
              })
            )
          )
        : null;

      return h(
        "div",
        { className: "dsh-https-page" },
        header,
        alerts,
        hero,
        certCard,
        authCard,
        localCard,
        warningsNode
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          { name: "settings.section", id: SECTION.id, label: SECTION.label, order: SECTION.order },
          function () { return React.createElement(HttpsPage); }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});