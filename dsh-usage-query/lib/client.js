// dsh-usage-query 浏览器半：设置页「用量查询」单页总览。
// 形态：官方 client module（__ModuleLoader__.load 工厂）；样式/监听/定时器全部经
// ctx.effect 注册并带清理函数，卸载或 HMR 时不残留。凭据不出服务器，页面只看到掩码。
// ⚠️ id 契约：load.id === package.json name === cordis.patch.yml insert.id === dsh-usage-query
window.__ModuleLoader__.load({
  id: "dsh-usage-query",
  factory: function (require) {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var SECTION = {
      id: "usage-query",
      label: "用量查询",
      order: 41,
    };
    var API_ROOT = "/api/usage-query";
    var PROVIDERS = ["deepseek", "opencode", "opendesign"];
    var CSS_ID = "dsh-usage-query/style";
    var CACHE_TICK_MS = 15000;
    var AUTO_REFRESH_MS = 5 * 60 * 1000;
    var STALE_MS = 60 * 1000;
    // 宿主一次查询最多 3 个上游请求 × 10 秒，超过这个时间基本是进程卡住：GET 可放弃、可重试。
    var API_TIMEOUT_MS = 45000;

    var META = {
      deepseek: {
        title: "DeepSeek 余额",
        host: "api.deepseek.com",
        empty: "还没有配置 DeepSeek 账号",
        action: "添加 DeepSeek Key",
        steps: [
          "打开 platform.deepseek.com，登录后进入 API Keys",
          "新建一个 Key 并复制（形如 sk-…）",
          "粘贴到下面，保存时会立刻向上游校验一次，失败不会落盘",
        ],
        link: { href: "https://platform.deepseek.com/api_keys", text: "打开 API Keys 页面" },
        placeholder: "sk-…",
        label: "API Key",
        help: "Key 只保存在本机 dsh 数据目录（0600），页面只显示掩码。",
      },
      opencode: {
        title: "OpenCode Go 用量",
        host: "opencode.ai/zen",
        empty: "还没有配置 OpenCode Go 账号",
        action: "添加 OpenCode Key",
        steps: [
          "打开 opencode.ai/zen 并登录，进入 API Keys",
          "复制 Key 后粘贴到下面",
          "保存时会请求一次用量接口校验，返回 401 表示 Key 不可用",
        ],
        link: { href: "https://opencode.ai/zen", text: "打开 OpenCode Zen" },
        placeholder: "opencode key",
        label: "API Key",
        help: "4 小时 / 每周 / 每月三个窗口按剩余比例显示，颜色随余量变化。",
      },
      opendesign: {
        title: "OpenDesign 余额",
        host: "amr-api.open-design.ai",
        empty: "还没有配置 OpenDesign 账号",
        action: "添加 OpenDesign 凭据",
        steps: [
          "在装有 OpenDesign 桌面端的机器上执行 vela login",
          "把 ~/.amr/config.json 的内容整段粘贴到下面（会自动挑出 controlKey）",
        ],
        link: { href: "https://open-design.ai", text: "打开 OpenDesign" },
        placeholder: "{ \"controlKey\": \"…\" }",
        label: "config.json 或 controlKey",
        help: "账单接口只认 controlKey；模型 runtimeKey 会被拒绝，粘贴后自动探测。",
      },
    };

    var CSS = [
      ".dsh-uq-page{display:flex;flex-direction:column;width:100%;max-width:860px;min-width:0;margin:0 auto;padding:0 20px 32px;box-sizing:border-box}",
      ".dsh-uq-head{display:flex;flex-direction:column;gap:2px;padding:16px 0 2px;flex:none}",
      ".dsh-uq-title{font-size:14px;font-weight:400;color:var(--dsw-alias-label-primary,#0f1115);line-height:22px;margin:0}",
      ".dsh-uq-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);line-height:20px}",
      ".dsh-uq-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0 10px;flex-wrap:wrap}",
      ".dsh-uq-muted{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);line-height:18px}",
      ".dsh-uq-btns{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dsh-uq-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);border-radius:999px;height:30px;padding:0 14px;font:inherit;font-size:12px;line-height:28px;cursor:pointer;white-space:nowrap;transition:background .15s ease,border-color .15s ease}",
      ".dsh-uq-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f5)}",
      ".dsh-uq-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".dsh-uq-btn-primary{background:#0f1115;border-color:#0f1115;color:#fff}",
      ".dsh-uq-btn-primary:hover{background:#2a2d33;border-color:#2a2d33}",
      ".dsh-uq-btn-danger{color:#b42318;border-color:#f0c7c3}",
      ".dsh-uq-btn-danger:hover{background:#fdecec}",
      ".dsh-uq-btn-sm{height:26px;line-height:24px;padding:0 10px;font-size:11px}",
      ".dsh-uq-chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}",
      ".dsh-uq-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16));background:var(--dsw-alias-bg-layer-1,#fff);font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);max-width:100%;min-width:0}",
      ".dsh-uq-chip b{font-weight:500;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".dsh-uq-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-uq-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#c4c8cc}",
      ".dsh-uq-dot.ok{background:#12a150}",
      ".dsh-uq-dot.warn{background:#e0a100}",
      ".dsh-uq-dot.bad{background:#e5484d}",
      ".dsh-uq-dot.idle{background:#c4c8cc}",
      ".dsh-uq-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);margin:0 0 12px;overflow:hidden;min-width:0}",
      ".dsh-uq-cardHead{display:flex;align-items:center;gap:10px;padding:12px 16px;flex-wrap:wrap;min-width:0}",
      ".dsh-uq-cardMain{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}",
      ".dsh-uq-cardTitle{font-size:14px;font-weight:400;color:var(--dsw-alias-label-primary,#0f1115);line-height:22px;white-space:nowrap}",
      ".dsh-uq-cardHost{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9096);line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-uq-cardBody{padding:0 16px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}",
      ".dsh-uq-select{height:26px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:11px;padding:0 8px;max-width:150px;min-width:0}",
      ".dsh-uq-row{display:flex;align-items:baseline;gap:10px;font-size:12px;line-height:20px;min-width:0}",
      ".dsh-uq-rowKey{color:var(--dsw-alias-label-secondary,#61666b);flex:none;min-width:76px}",
      ".dsh-uq-rowNote{color:var(--dsw-alias-label-tertiary,#8b9096);font-size:11px;line-height:18px}",
      ".dsh-uq-rowVal{margin-left:auto;text-align:right;color:var(--dsw-alias-label-primary,#0f1115);min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}",
      ".dsh-uq-amount{font-size:20px;line-height:26px;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums;letter-spacing:-.01em}",
      ".dsh-uq-big{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;min-width:0}",
      ".dsh-uq-bigNote{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);line-height:18px;padding-bottom:3px}",
      ".dsh-uq-meter{display:flex;flex-direction:column;gap:5px;min-width:0}",
      ".dsh-uq-meterHead{display:flex;align-items:baseline;gap:8px;min-width:0}",
      ".dsh-uq-meterTitle{font-size:12px;color:var(--dsw-alias-label-primary,#0f1115);line-height:20px;white-space:nowrap}",
      ".dsh-uq-meterNote{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9096);line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-uq-meterVal{margin-left:auto;font-size:12px;line-height:20px;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".dsh-uq-track{position:relative;height:8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform,#eceef0);overflow:hidden}",
      ".dsh-uq-fill{height:100%;border-radius:999px;transition:width .35s ease,background-color .35s ease;background:#12a150}",
      ".dsh-uq-fill.warn{background:#e0a100}",
      ".dsh-uq-fill.bad{background:#e5484d}",
      ".dsh-uq-fill.idle{background:#c4c8cc}",
      ".dsh-uq-split{display:flex;height:8px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-module-platform,#eceef0)}",
      ".dsh-uq-splitPart{height:100%}",
      ".dsh-uq-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);line-height:18px}",
      ".dsh-uq-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:middle}",
      ".dsh-uq-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:20px;border:1px solid transparent;white-space:nowrap;color:#2b4f8a;background:#edf3ff;border-color:#cddcf7}",
      ".dsh-uq-badge.ok{color:#0a6b3d;background:#e8f7ef;border-color:#bfe8d2}",
      ".dsh-uq-badge.warn{color:#8a5a00;background:#fff6df;border-color:#f2dfb0}",
      ".dsh-uq-badge.bad{color:#a12a2a;background:#fdecec;border-color:#f3c9c9}",
      ".dsh-uq-alert{display:flex;gap:8px;align-items:flex-start;border-radius:8px;padding:8px 10px;font-size:12px;line-height:19px;overflow-wrap:anywhere}",
      ".dsh-uq-alert.bad{background:#fdecec;color:#8f2323;border:1px solid #f3c9c9}",
      ".dsh-uq-alert.warn{background:#fff6df;color:#7a5200;border:1px solid #f2dfb0}",
      ".dsh-uq-alert.ok{background:#e8f7ef;color:#0a5d36;border:1px solid #bfe8d2}",
      ".dsh-uq-alertText{flex:1 1 auto;min-width:0}",
      ".dsh-uq-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:22px 12px;text-align:center}",
      ".dsh-uq-emptyTitle{font-size:13px;color:var(--dsw-alias-label-primary,#0f1115);line-height:21px}",
      ".dsh-uq-emptyText{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);line-height:18px;max-width:420px}",
      ".dsh-uq-skel{display:flex;flex-direction:column;gap:10px}",
      ".dsh-uq-skelLine{height:10px;border-radius:6px;background:var(--dsw-alias-bg-module-platform,#eceef0);animation:dsh-uq-pulse 1.2s ease-in-out infinite}",
      ".dsh-uq-skelLine.a{width:52%}.dsh-uq-skelLine.b{width:78%}.dsh-uq-skelLine.c{width:35%}",
      "@keyframes dsh-uq-pulse{0%,100%{opacity:.55}50%{opacity:1}}",
      ".dsh-uq-overlay{position:fixed;inset:0;background:rgba(15,17,21,.32);z-index:60;display:flex;justify-content:flex-end;animation:dsh-uq-fade .16s ease}",
      ".dsh-uq-drawer{width:min(440px,100%);height:100%;background:var(--dsw-alias-bg-layer-1,#fff);display:flex;flex-direction:column;min-width:0;box-shadow:-8px 0 28px rgba(0,0,0,.12);animation:dsh-uq-slide .2s ease}",
      ".dsh-uq-drawerHead{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));flex:none}",
      ".dsh-uq-drawerTitle{font-size:14px;color:var(--dsw-alias-label-primary,#0f1115);line-height:22px;flex:1 1 auto;min-width:0}",
      ".dsh-uq-drawerBody{padding:14px 16px 24px;display:flex;flex-direction:column;gap:12px;overflow:auto;min-height:0;flex:1 1 auto}",
      ".dsh-uq-acct{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));border-radius:10px;min-width:0;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dsh-uq-acct.on{border-color:#0f1115;box-shadow:0 0 0 1px #0f1115 inset}",
      ".dsh-uq-acctMain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}",
      ".dsh-uq-acctName{font-size:12px;color:var(--dsw-alias-label-primary,#0f1115);line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-uq-acctKey{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-uq-acctBtns{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex:none}",
      ".dsh-uq-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".dsh-uq-fieldLabel{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);line-height:18px}",
      ".dsh-uq-input,.dsh-uq-textarea{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:12px;padding:0 10px;min-width:0}",
      ".dsh-uq-input{height:32px}",
      ".dsh-uq-textarea{min-height:96px;padding:8px 10px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:18px}",
      ".dsh-uq-steps{margin:0;padding-left:18px;font-size:11px;line-height:19px;color:var(--dsw-alias-label-secondary,#61666b)}",
      ".dsh-uq-steps li{margin:0 0 2px}",
      ".dsh-uq-link{font-size:11px;color:var(--dsw-alias-brand-primary,#2b6cb0);text-decoration:none;line-height:18px}",
      ".dsh-uq-link:hover{text-decoration:underline}",
      ".dsh-uq-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(127,127,127,.14));margin:2px 0}",
      ".dsh-uq-subTitle{font-size:12px;color:var(--dsw-alias-label-primary,#0f1115);line-height:20px}",
      "@media (max-width:640px){.dsh-uq-page{padding:0 14px 24px}.dsh-uq-rowKey{min-width:64px}.dsh-uq-cardHead{padding:10px 12px;gap:8px}.dsh-uq-cardBody{padding:0 12px 12px}.dsh-uq-select{max-width:120px}.dsh-uq-amount{font-size:18px}.dsh-uq-drawer{width:100%}}",
      "@media (prefers-reduced-motion:reduce){.dsh-uq-fill{transition:none}.dsh-uq-skelLine{animation:none}.dsh-uq-overlay,.dsh-uq-drawer{animation:none}}",
      "@keyframes dsh-uq-fade{from{opacity:0}to{opacity:1}}",
      "@keyframes dsh-uq-slide{from{transform:translateX(16px);opacity:.6}to{transform:none;opacity:1}}",
    ].join("");

    // ── 工具 ────────────────────────────────────────────────────────────
    /** GET 是幂等的，卡住时可以放弃；POST 不设超时，否则用户会以为没保存而重复提交。 */
    function timeoutSignal() {
      try {
        if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(API_TIMEOUT_MS);
      } catch (error) {
        // 老浏览器没有 AbortSignal.timeout：退回不设超时
      }
      return undefined;
    }

    function timeoutText() {
      return "查询超时（" + Math.round(API_TIMEOUT_MS / 1000) + " 秒），请稍后重试";
    }

    function apiGet(path) {
      return fetch(API_ROOT + path, { credentials: "include", cache: "no-store", headers: { Accept: "application/json" }, signal: timeoutSignal() })
        .then(function (res) {
          return res.json().then(
            function (body) { return body && typeof body === "object" ? body : { ok: false, error: "接口返回了空响应" }; },
            function () { return { ok: false, error: "接口返回非 JSON（HTTP " + res.status + "）" }; },
          );
        })
        .catch(function (error) {
          if (error && (error.name === "TimeoutError" || error.name === "AbortError")) return { ok: false, error: timeoutText() };
          return { ok: false, error: "网络请求失败，请确认 dsh web 服务仍在运行" };
        });
    }

    function apiPost(path, body) {
      return fetch(API_ROOT + path, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body || {}),
      })
        .then(function (res) {
          return res.json().then(
            function (data) { return data && typeof data === "object" ? data : { ok: false, error: "接口返回了空响应" }; },
            function () { return { ok: false, error: "接口返回非 JSON（HTTP " + res.status + "）" }; },
          );
        })
        .catch(function () { return { ok: false, error: "网络请求失败，请确认 dsh web 服务仍在运行" }; });
    }

    function pad2(n) { return n < 10 ? "0" + n : String(n); }

    function fmtTime(value) {
      if (!value) return "";
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
    }

    function fmtMinute(value) {
      if (!value) return "";
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return pad2(date.getMonth() + 1) + "-" + pad2(date.getDate()) + " " + pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    }

    function fmtCredits(value) {
      var n = Number(value);
      if (!Number.isFinite(n)) return "—";
      return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
    }

    function fmtMoney(value) {
      var n = Number(value);
      if (!Number.isFinite(n)) return "—";
      return n.toFixed(2);
    }

    function fmtUsd(value) {
      var n = Number(value);
      if (!Number.isFinite(n)) return "—";
      return "$" + (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));
    }


    // 当天只显示时分秒，跨天补上日期，避免「08:59:44」看起来像刚更新
    function fmtStamp(value, now) {
      if (!value) return "";
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      var stamp = now ? new Date(now) : new Date();
      var sameDay = date.getFullYear() === stamp.getFullYear() && date.getMonth() === stamp.getMonth() && date.getDate() === stamp.getDate();
      return sameDay ? pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds()) : fmtMinute(value);
    }

    function clampPct(value) {
      var n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
    }

    function toneOf(remaining) {
      if (remaining == null) return "idle";
      if (remaining > 50) return "ok";
      if (remaining > 20) return "warn";
      return "bad";
    }

    function untilReset(iso, now) {
      if (!iso) return "";
      var target = Date.parse(iso);
      if (!Number.isFinite(target)) return "";
      var diff = target - now;
      if (diff <= 0) return "即将重置";
      var minutes = Math.round(diff / 60000);
      var days = Math.floor(minutes / 1440);
      if (days > 0) return days + " 天后重置";
      var hours = Math.floor((minutes % 1440) / 60);
      if (hours > 0) return hours + " 小时 " + (minutes % 60) + " 分后重置";
      return Math.max(1, minutes) + " 分钟后重置";
    }

    function durationLabel(seconds) {
      var n = Number(seconds);
      if (!Number.isFinite(n) || n <= 0) return "用量额度";
      if (n % 86400 === 0) return n / 86400 + " 天窗口";
      if (n % 3600 === 0) return n / 3600 + " 小时窗口";
      return Math.round(n / 60) + " 分钟窗口";
    }

    function tierLabel(tier) {
      if (!tier) return "";
      var map = { free: "免费版", go: "Go", plus: "标准版", pro: "专业版", max: "旗舰版" };
      return map[String(tier).toLowerCase()] || String(tier);
    }

    function ageText(ts, now) {
      if (!ts) return "";
      var diff = Math.max(0, now - ts);
      if (diff < 60000) return "刚刚更新";
      var minutes = Math.floor(diff / 60000);
      if (minutes < 60) return minutes + " 分钟前更新";
      return Math.floor(minutes / 60) + " 小时前更新";
    }

    // ── 原子组件 ────────────────────────────────────────────────────────
    function Dot(props) {
      return React.createElement("span", { className: "dsh-uq-dot " + (props.tone || "idle"), "aria-hidden": "true" });
    }

    function Badge(props) {
      return React.createElement("span", { className: "dsh-uq-badge" + (props.tone ? " " + props.tone : "") }, props.children);
    }

    function Row(props) {
      return React.createElement("div", { className: "dsh-uq-row" },
        React.createElement("span", { className: "dsh-uq-rowKey" }, props.label),
        props.note ? React.createElement("span", { className: "dsh-uq-rowNote" }, props.note) : null,
        React.createElement("span", { className: "dsh-uq-rowVal" }, props.value));
    }

    function Alert(props) {
      return React.createElement("div", { className: "dsh-uq-alert " + (props.tone || "warn") },
        React.createElement("span", { className: "dsh-uq-alertText" }, props.children),
        props.action || null);
    }

    function Skeleton() {
      return React.createElement("div", { className: "dsh-uq-skel", "aria-hidden": "true" },
        React.createElement("div", { className: "dsh-uq-skelLine a" }),
        React.createElement("div", { className: "dsh-uq-skelLine b" }),
        React.createElement("div", { className: "dsh-uq-skelLine c" }));
    }

    /** Quota bar filled by REMAINING share; colour follows the remaining level. */
    function Meter(props) {
      var remaining = props.remaining == null ? null : clampPct(props.remaining);
      var tone = toneOf(remaining);
      var reset = untilReset(props.resetsAt, props.now || Date.now());
      return React.createElement("div", { className: "dsh-uq-meter" },
        React.createElement("div", { className: "dsh-uq-meterHead" },
          React.createElement("span", { className: "dsh-uq-meterTitle" }, props.title),
          props.note ? React.createElement("span", { className: "dsh-uq-meterNote" }, props.note) : null,
          React.createElement("span", { className: "dsh-uq-meterVal" },
            remaining == null ? "—" : "剩余 " + remaining + "%" + (props.used != null ? " · 已用 " + clampPct(props.used) + "%" : ""))),
        React.createElement("div", {
          className: "dsh-uq-track",
          role: "progressbar",
          "aria-label": props.title + " 剩余",
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          "aria-valuenow": remaining == null ? 0 : remaining,
        }, React.createElement("div", { className: "dsh-uq-fill " + tone, style: { width: (remaining == null ? 0 : remaining) + "%" } })),
        reset ? React.createElement("div", { className: "dsh-uq-meterNote" }, props.resetsAt ? fmtMinute(props.resetsAt) + " 重置 · " + reset : reset) : null);
    }

    // ── 账号抽屉 ────────────────────────────────────────────────────────
    function AccountDrawer(props) {
      var provider = props.provider;
      var meta = META[provider];
      var acct = props.acct || { accounts: [], activeAccountId: "" };
      var [view, setView] = React.useState("list");
      var [editId, setEditId] = React.useState("");
      var [name, setName] = React.useState("");
      var [credential, setCredential] = React.useState("");
      var [busy, setBusy] = React.useState("");
      var [error, setError] = React.useState("");
      var [notice, setNotice] = React.useState("");
      var [pendingDelete, setPendingDelete] = React.useState("");

      React.useEffect(function () {
        function onKey(event) { if (event.key === "Escape") props.onClose(); }
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, []);

      function reset(nextView) {
        setView(nextView || "list");
        setEditId("");
        setName("");
        setCredential("");
        setError("");
        setNotice("");
      }

      function submit() {
        if (busy) return;
        var body = { provider: provider, name: name.trim(), credential: credential.trim() };
        if (!body.credential) { setError("请先填写 " + meta.label); return; }
        setBusy("save");
        setError("");
        var request = view === "edit"
          ? apiPost("/accounts/update", Object.assign({ id: editId }, body))
          : apiPost("/accounts", Object.assign({ activate: !acct.activeAccountId }, body));
        request.then(function (result) {
          setBusy("");
          if (!result.ok) { setError(result.error || "保存失败"); return; }
          props.onChanged();
          reset("list");
          setNotice(view === "edit" ? "已更新凭据" : "已添加账号并完成校验");
        });
      }

      function remove(id) {
        if (busy) return;
        setBusy("delete:" + id);
        apiPost("/accounts/delete", { provider: provider, id: id }).then(function (result) {
          setBusy("");
          setPendingDelete("");
          if (!result.ok) { setError(result.error || "删除失败"); return; }
          props.onChanged();
          setNotice("已删除该账号");
        });
      }

      function beginEdit(account) {
        setView("edit");
        setEditId(account.id);
        setName(account.name || "");
        setCredential("");
        setError("");
        setNotice("");
      }

      var body;
      if (view === "add" || view === "edit") {
        body = [
          React.createElement("ol", { className: "dsh-uq-steps", key: "s" }, meta.steps.map(function (step, index) {
            return React.createElement("li", { key: "step-" + index }, step);
          })),
          meta.link ? React.createElement("a", { className: "dsh-uq-link", key: "l", href: meta.link.href, target: "_blank", rel: "noreferrer noopener" }, meta.link.text) : null,
          React.createElement("div", { className: "dsh-uq-field", key: "n" },
            React.createElement("label", { className: "dsh-uq-fieldLabel" }, "名称（可选）"),
            React.createElement("input", {
              className: "dsh-uq-input",
              value: name,
              placeholder: "例如：主账号",
              onChange: function (event) { setName(event.target.value); },
            })),
          React.createElement("div", { className: "dsh-uq-field", key: "c" },
            React.createElement("label", { className: "dsh-uq-fieldLabel" }, view === "edit" ? "新凭据（留空表示只改名称）" : meta.label),
            React.createElement("textarea", {
              className: "dsh-uq-textarea",
              value: credential,
              placeholder: meta.placeholder,
              onChange: function (event) { setCredential(event.target.value); },
            })),
          React.createElement("div", { className: "dsh-uq-muted", key: "h" }, meta.help),
          error ? React.createElement(Alert, { tone: "bad", key: "e" }, error) : null,
          React.createElement("div", { className: "dsh-uq-btns", key: "b" },
            React.createElement("button", { type: "button", className: "dsh-uq-btn dsh-uq-btn-primary", onClick: submit, disabled: !!busy }, busy === "save" ? "正在校验…" : "保存并校验"),
            React.createElement("button", { type: "button", className: "dsh-uq-btn", onClick: function () { reset("list"); } }, "取消")),
        ];
      } else {
        var list = acct.accounts.length
          ? acct.accounts.map(function (account) {
              var active = account.id === acct.activeAccountId;
              return React.createElement("div", { className: "dsh-uq-acct" + (active ? " on" : ""), key: account.id },
                React.createElement("div", { className: "dsh-uq-acctMain" },
                  React.createElement("span", { className: "dsh-uq-acctName" },
                    account.name,
                    active ? React.createElement("span", { style: { marginLeft: 6 } }, React.createElement(Badge, { tone: "ok" }, "使用中")) : null),
                  React.createElement("span", { className: "dsh-uq-acctKey" }, account.key || "—")),
                React.createElement("div", { className: "dsh-uq-acctBtns" },
                  pendingDelete === account.id
                    ? [
                        React.createElement("button", { type: "button", className: "dsh-uq-btn dsh-uq-btn-sm dsh-uq-btn-danger", key: "y", onClick: function () { remove(account.id); }, disabled: !!busy }, busy ? "删除中…" : (acct.accounts.length === 1 ? "确认清空" : "确认删除")),
                        React.createElement("button", { type: "button", className: "dsh-uq-btn dsh-uq-btn-sm", key: "n", onClick: function () { setPendingDelete(""); } }, "取消"),
                      ]
                    : [
                        active ? null : React.createElement("button", { type: "button", className: "dsh-uq-btn dsh-uq-btn-sm", key: "use", onClick: function () { props.onSwitch(account.id); } }, "使用"),
                        React.createElement("button", { type: "button", className: "dsh-uq-btn dsh-uq-btn-sm", key: "edit", onClick: function () { beginEdit(account); } }, "编辑"),
                        React.createElement("button", { type: "button", className: "dsh-uq-btn dsh-uq-btn-sm dsh-uq-btn-danger", key: "del", onClick: function () { setPendingDelete(account.id); setError(""); } }, "删除"),
                      ]));
            })
          : React.createElement("div", { className: "dsh-uq-empty" },
              React.createElement("div", { className: "dsh-uq-emptyTitle" }, meta.empty),
              React.createElement("div", { className: "dsh-uq-emptyText" }, "点下面的按钮，按提示粘贴凭据即可。保存时会先向上游校验，失败不会写入。"),
              React.createElement("button", { type: "button", className: "dsh-uq-btn dsh-uq-btn-primary", onClick: function () { reset("add"); } }, meta.action));

        body = [
          pendingDelete && acct.accounts.length === 1
            ? React.createElement(Alert, { tone: "warn", key: "w" }, "这是该渠道的最后一个账号：确认后会清空本机保存的凭据，卡片回到空态。")
            : null,
          notice ? React.createElement(Alert, { tone: "ok", key: "n" }, notice) : null,
          error ? React.createElement(Alert, { tone: "bad", key: "e" }, error) : null,
          React.createElement("div", { key: "list", style: { display: "flex", flexDirection: "column", gap: 8 } }, list),
          React.createElement("div", { className: "dsh-uq-sep", key: "sep" }),
          React.createElement("div", { className: "dsh-uq-btns", key: "b" },
            React.createElement("button", { type: "button", className: "dsh-uq-btn dsh-uq-btn-primary", onClick: function () { reset("add"); } }, acct.accounts.length ? "添加账号" : meta.action)),
          React.createElement("div", { className: "dsh-uq-muted", key: "h" }, meta.help),
        ];
      }

      return React.createElement("div", { className: "dsh-uq-overlay", onMouseDown: function (event) { if (event.target === event.currentTarget) props.onClose(); } },
        React.createElement("div", { className: "dsh-uq-drawer", role: "dialog", "aria-modal": "true", "aria-label": meta.title + " 账号管理" },
          React.createElement("div", { className: "dsh-uq-drawerHead" },
            React.createElement("span", { className: "dsh-uq-drawerTitle" }, meta.title + " · 账号管理"),
            React.createElement("button", { type: "button", className: "dsh-uq-btn dsh-uq-btn-sm", onClick: props.onClose, "aria-label": "关闭" }, "关闭")),
          React.createElement("div", { className: "dsh-uq-drawerBody" }, body)));
    }

    // ── 各渠道正文 ──────────────────────────────────────────────────────
    function DeepseekBody(props) {
      var data = props.data;
      if (!data) return React.createElement(Skeleton);
      var info = Array.isArray(data.balance_infos) && data.balance_infos.length ? data.balance_infos[0] : null;
      if (!info) return React.createElement("div", { className: "dsh-uq-muted" }, "上游没有返回余额信息");
      var currency = info.currency === "CNY" ? "¥" : (info.currency === "USD" ? "$" : (info.currency ? info.currency + " " : ""));
      var total = Number(info.total_balance);
      var topped = Number(info.topped_up_balance);
      var granted = Number(info.granted_balance);
      var sum = (Number.isFinite(topped) ? topped : 0) + (Number.isFinite(granted) ? granted : 0);
      var toppedPct = sum > 0 && Number.isFinite(topped) ? Math.round((topped / sum) * 100) : 0;

      return React.createElement("div", { className: "dsh-uq-cardBody" },
        React.createElement("div", { className: "dsh-uq-big" },
          React.createElement("span", { className: "dsh-uq-amount" }, currency + (Number.isFinite(total) ? total.toFixed(2) : "—")),
          React.createElement("span", { className: "dsh-uq-bigNote" }, data.is_available ? "账户可用" : "账户当前不可用")),
        sum > 0
          ? React.createElement("div", { className: "dsh-uq-split", "aria-hidden": "true" },
              React.createElement("div", { className: "dsh-uq-splitPart", style: { width: toppedPct + "%", background: "#2f6feb" } }),
              React.createElement("div", { className: "dsh-uq-splitPart", style: { width: 100 - toppedPct + "%", background: "#f0a92a" } }))
          : null,
        sum > 0
          ? React.createElement("div", { className: "dsh-uq-legend" },
              React.createElement("span", null, React.createElement("i", { style: { background: "#2f6feb" } }), "充值 " + currency + fmtMoney(topped)),
              React.createElement("span", null, React.createElement("i", { style: { background: "#f0a92a" } }), "赠送 " + currency + fmtMoney(granted)))
          : null,
        React.createElement(Row, { label: "充值 / 赠送", value: "充值 " + currency + fmtMoney(topped) + " · 赠送 " + currency + fmtMoney(granted) }));
    }

    var GO_WINDOWS = [
      { key: "rolling", title: "4 小时余量", note: "滚动窗口" },
      { key: "weekly", title: "一周余量", note: "每周配额" },
      { key: "monthly", title: "一月余量", note: "每月配额" },
    ];

    function OpencodeBody(props) {
      var data = props.data;
      if (!data) return React.createElement(Skeleton);
      var usage = data.usage || {};
      return React.createElement("div", { className: "dsh-uq-cardBody" }, GO_WINDOWS.map(function (win) {
        var value = usage[win.key];
        if (!value || typeof value.percent !== "number") {
          return React.createElement(Row, { key: win.key, label: win.title, note: win.note, value: "—" });
        }
        var used = clampPct(value.percent);
        var remaining = clampPct(100 - value.percent);
        return React.createElement(Meter, {
          key: win.key,
          title: win.title,
          note: win.note,
          remaining: remaining,
          used: used,
          resetsAt: value.resetsAt,
          now: props.now,
        });
      }));
    }

    function OpendesignBody(props) {
      var data = props.data;
      if (!data) return React.createElement(Skeleton);
      var usage = data.usage || {};
      var me = usage.me || {};
      var sum = usage.summary || {};
      var wallet = usage.wallet || {};
      var windows = sum.codingPlan && Array.isArray(sum.codingPlan.windows)
        ? sum.codingPlan.windows.slice().sort(function (a, b) { return (Number(a.durationSeconds) || 0) - (Number(b.durationSeconds) || 0); })
        : [];

      var nodes = [];
      var tier = sum.planTier || sum.membershipTier || "";
      nodes.push(React.createElement(Row, {
        key: "who",
        label: "账户",
        note: "OpenDesign 控制台登录账号",
        value: me.email || me.name || "—",
      }));
      nodes.push(React.createElement("div", { className: "dsh-uq-row", key: "plan" },
        React.createElement("span", { className: "dsh-uq-rowKey" }, "计划"),
        React.createElement("span", { className: "dsh-uq-rowNote" }, sum.subscriptionStatus === "active" ? "订阅生效中" : (sum.subscriptionStatus || "订阅状态未知")),
        React.createElement("span", { className: "dsh-uq-rowVal" },
          tier ? React.createElement(Badge, null, tierLabel(tier)) : React.createElement("span", { className: "dsh-uq-muted" }, "—"))));

      windows.forEach(function (win, index) {
        var limit = Number(win.limitCredits);
        var remain = Number(win.remainingCredits);
        var used = Number(win.usedCredits);
        var remainingPct = null;
        if (Number.isFinite(remain) && Number.isFinite(limit) && limit > 0) remainingPct = (remain / limit) * 100;
        else if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) remainingPct = 100 - (used / limit) * 100;
        nodes.push(React.createElement(Meter, {
          key: "win-" + index,
          title: durationLabel(win.durationSeconds),
          note: Number.isFinite(limit) ? fmtCredits(remain) + " / " + fmtCredits(limit) + " 积分" : "剩余额度",
          remaining: remainingPct,
          used: remainingPct == null ? null : 100 - remainingPct,
          resetsAt: win.resetsAt,
          now: props.now,
        }));
      });

      var walletUsd = wallet.balanceUsd != null ? wallet.balanceUsd : sum.balanceUsd;
      nodes.push(React.createElement(Row, {
        key: "wallet",
        label: "钱包余额",
        note: wallet.updatedAt ? "更新于 " + fmtStamp(wallet.updatedAt, props.now) : "Wallet balance",
        value: fmtUsd(walletUsd),
      }));
      nodes.push(React.createElement(Row, {
        key: "credits",
        label: "账户积分",
        note: sum.creditsPerUsd ? fmtCredits(sum.creditsPerUsd) + " 积分 / US$1" : "订阅 + 充值",
        value: "订阅 " + fmtCredits(sum.subscriptionCredits) + " · 充值 " + fmtCredits(sum.rechargeCredits),
      }));
      nodes.push(React.createElement(Row, {
        key: "today",
        label: "今日消耗",
        note: "控制台返回的当日用量",
        value: fmtUsd(sum.todayConsumedUsd),
      }));
      nodes.push(React.createElement(Row, {
        key: "total",
        label: "累计消耗",
        note: sum.usageCount ? "共 " + fmtCredits(sum.usageCount) + " 次调用" : "全部历史用量",
        value: fmtUsd(sum.totalConsumedUsd),
      }));

      return React.createElement("div", { className: "dsh-uq-cardBody" }, nodes);
    }

    // ── 页面 ────────────────────────────────────────────────────────────
    function UsageQueryPage() {
      var [accounts, setAccounts] = React.useState(null);
      var [data, setData] = React.useState({ deepseek: null, opencode: null, opendesign: null });
      var [errors, setErrors] = React.useState({});
      var [loading, setLoading] = React.useState({});
      var [drawer, setDrawer] = React.useState(null);
      var [updated, setUpdated] = React.useState(0);
      var [auto, setAuto] = React.useState(true);
      var [now, setNow] = React.useState(Date.now());
      var [refreshToken, setRefreshToken] = React.useState(0);
      var lastLoad = React.useRef(0);
      var mounted = React.useRef(true);
      var autoRef = React.useRef(true);

      React.useEffect(function () {
        mounted.current = true;
        return function () { mounted.current = false; };
      }, []);

      React.useEffect(function () {
        autoRef.current = auto;
      }, [auto]);

      function loadAccounts() {
        return apiGet("/accounts").then(function (result) {
          if (!mounted.current) return;
          if (result && result.ok && result.providers) {
            setAccounts(result.providers);
            setErrors(function (prev) { var next = Object.assign({}, prev); delete next.accounts; return next; });
          } else {
            setErrors(function (prev) { return Object.assign({}, prev, { accounts: (result && result.error) || "账号列表加载失败" }); });
          }
        });
      }

      function loadProvider(provider, force) {
        setLoading(function (prev) { return Object.assign({}, prev, { [provider]: true }); });
        return apiGet("/" + provider + (force ? "?force=1" : "")).then(function (result) {
          if (!mounted.current) return;
          setLoading(function (prev) { return Object.assign({}, prev, { [provider]: false }); });
          if (result && result.ok) {
            setData(function (prev) { return Object.assign({}, prev, { [provider]: result }); });
            setErrors(function (prev) { var next = Object.assign({}, prev); delete next[provider]; return next; });
          } else {
            setData(function (prev) { return Object.assign({}, prev, { [provider]: Object.assign({ ok: false }, result) }); });
            setErrors(function (prev) { return Object.assign({}, prev, { [provider]: (result && result.error) || "查询失败" }); });
          }
        });
      }

      function refreshAll(force) {
        lastLoad.current = Date.now();
        loadAccounts();
        PROVIDERS.forEach(function (provider) { loadProvider(provider, force); });
        if (force) setRefreshToken(function (n) { return n + 1; });
        setUpdated(Date.now());
      }

      function providerAccount(provider) {
        return accounts && accounts[provider] ? accounts[provider] : { accounts: [], activeAccountId: "" };
      }

      function switchAccount(provider, id) {
        setAccounts(function (prev) {
          if (!prev) return prev;
          return Object.assign({}, prev, { [provider]: Object.assign({}, prev[provider], { activeAccountId: id }) });
        });
        apiPost("/accounts/switch", { provider: provider, id: id }).then(function (result) {
          if (!result.ok) {
            setErrors(function (prev) { return Object.assign({}, prev, { [provider]: result.error || "切换账号失败" }); });
            // 乐观更新已经把当前账号画成新的了：失败时按宿主的真实状态回滚。
            loadAccounts();
            return;
          }
          loadProvider(provider, true);
        });
      }

      React.useEffect(function () {
        refreshAll(false);
        var tick = setInterval(function () { setNow(Date.now()); }, CACHE_TICK_MS);
        var autoTimer = setInterval(function () {
          if (autoRef.current && document.visibilityState === "visible") refreshAll(false);
        }, AUTO_REFRESH_MS);
        function onVisible() {
          if (document.visibilityState !== "visible") return;
          if (Date.now() - lastLoad.current > STALE_MS) refreshAll(false);
        }
        document.addEventListener("visibilitychange", onVisible);
        return function () {
          clearInterval(tick);
          clearInterval(autoTimer);
          document.removeEventListener("visibilitychange", onVisible);
        };
      }, []);

      function chip(provider, tone, label, value) {
        return React.createElement("span", { className: "dsh-uq-chip", key: provider },
          React.createElement(Dot, { tone: tone }),
          React.createElement("span", null, label),
          React.createElement("b", null, value));
      }

      var chips = [];
      var dsResult = data.deepseek;
      var dsInfo = dsResult && dsResult.ok && Array.isArray(dsResult.balance_infos) && dsResult.balance_infos.length ? dsResult.balance_infos[0] : null;
      if (dsInfo) {
        var dsCurrency = dsInfo.currency === "CNY" ? "¥" : (dsInfo.currency === "USD" ? "$" : "");
        chips.push(chip("deepseek", "ok", "DeepSeek", dsCurrency + fmtMoney(dsInfo.total_balance)));
      } else chips.push(chip("deepseek", errors.deepseek ? "bad" : "idle", "DeepSeek", errors.deepseek ? "失败" : "—"));

      var ocResult = data.opencode;
      var ocUsage = ocResult && ocResult.ok ? ocResult.usage || {} : {};
      // chip 只给一眼结论：取三个窗口里最紧的那个
      var ocWorst = null;
      var ocWorstKey = "";
      ["rolling", "weekly", "monthly"].forEach(function (key) {
        var win = ocUsage[key];
        if (!win || typeof win.percent !== "number") return;
        var left = clampPct(100 - win.percent);
        if (left == null) return;
        if (ocWorst == null || left < ocWorst) { ocWorst = left; ocWorstKey = key; }
      });
      var ocLabel = ocWorstKey === "monthly" ? "OpenCode 月" : (ocWorstKey === "weekly" ? "OpenCode 周" : "OpenCode 4h");
      var ocTitle = ["rolling", "weekly", "monthly"].map(function (key) {
        var win = ocUsage[key];
        return win && typeof win.percent === "number" ? (key === "rolling" ? "4h" : key === "weekly" ? "周" : "月") + " 剩 " + clampPct(100 - win.percent) + "%" : "";
      }).filter(Boolean).join(" · ");
      chips.push(React.createElement("span", { className: "dsh-uq-chip", key: "opencode", title: ocTitle },
        React.createElement(Dot, { tone: errors.opencode ? "bad" : (ocWorst == null ? "idle" : toneOf(ocWorst)) }),
        React.createElement("span", null, ocWorst == null ? "OpenCode" : ocLabel),
        React.createElement("b", null, ocWorst == null ? (errors.opencode ? "失败" : "—") : ocWorst + "%")));

      var odResult = data.opendesign;
      var odUsage = odResult && odResult.ok ? odResult.usage || {} : {};
      var odWindows = odUsage.summary && odUsage.summary.codingPlan && Array.isArray(odUsage.summary.codingPlan.windows) ? odUsage.summary.codingPlan.windows : [];
      var odPrimary = odWindows.length ? odWindows.slice().sort(function (a, b) { return (Number(a.durationSeconds) || 0) - (Number(b.durationSeconds) || 0); })[0] : null;
      var odText = "—";
      if (odPrimary) {
        var odLimit = Number(odPrimary.limitCredits);
        var odRemain = Number(odPrimary.remainingCredits);
        odText = Number.isFinite(odLimit) && odLimit > 0 && Number.isFinite(odRemain) ? Math.round((odRemain / odLimit) * 100) + "%" : "—";
      } else if (odUsage.summary && odUsage.summary.subscriptionCredits != null) {
        odText = fmtCredits(odUsage.summary.subscriptionCredits);
      }
      chips.push(chip("opendesign", errors.opendesign ? "bad" : (odText === "—" ? "idle" : "ok"), "OpenDesign", odText));

      function card(provider, Body) {
        var meta = META[provider];
        var acct = providerAccount(provider);
        var state = data[provider];
        var error = errors[provider];
        var busy = !!loading[provider];
        var hasAccount = acct.accounts.length > 0;
        var activeAccount = acct.accounts.filter(function (a) { return a.id === acct.activeAccountId; })[0] || null;
        var tone = !hasAccount ? "idle" : (error ? "bad" : (state ? "ok" : "warn"));

        var head = React.createElement("div", { className: "dsh-uq-cardHead" },
          React.createElement("div", { className: "dsh-uq-cardMain" },
            React.createElement(Dot, { tone: tone }),
            React.createElement("span", { className: "dsh-uq-cardTitle" }, meta.title),
            React.createElement("span", { className: "dsh-uq-cardHost" }, meta.host)),
          React.createElement("div", { className: "dsh-uq-btns" },
            hasAccount && acct.accounts.length > 1
              ? React.createElement("select", {
                  className: "dsh-uq-select",
                  value: acct.activeAccountId,
                  "aria-label": meta.title + " 当前账号",
                  onChange: function (event) { switchAccount(provider, event.target.value); },
                }, acct.accounts.map(function (account) {
                  return React.createElement("option", { value: account.id, key: account.id }, account.name);
                }))
              : null,
            hasAccount ? React.createElement("button", {
              type: "button",
              className: "dsh-uq-btn dsh-uq-btn-sm",
              onClick: function () { loadProvider(provider, true); },
              disabled: busy,
            }, busy ? "刷新中…" : "刷新") : null,
            React.createElement("button", {
              type: "button",
              className: "dsh-uq-btn dsh-uq-btn-sm",
              onClick: function () { setDrawer(provider); },
            }, hasAccount ? "管理" : "添加")));

        var body;
        if (!hasAccount) {
          body = React.createElement("div", { className: "dsh-uq-empty" },
            React.createElement("div", { className: "dsh-uq-emptyTitle" }, meta.empty),
            React.createElement("div", { className: "dsh-uq-emptyText" }, meta.steps[0] + "。点按钮按提示粘贴凭据，保存前会先校验。"),
            React.createElement("button", { type: "button", className: "dsh-uq-btn dsh-uq-btn-primary", onClick: function () { setDrawer(provider); } }, meta.action));
        } else if (error) {
          body = React.createElement("div", { className: "dsh-uq-cardBody" },
            React.createElement(Alert, { tone: "bad", action: React.createElement("button", {
              type: "button",
              className: "dsh-uq-btn dsh-uq-btn-sm",
              onClick: function () { loadProvider(provider, true); },
            }, "重试") }, error),
            activeAccount ? React.createElement("div", { className: "dsh-uq-muted" }, "当前账号：" + activeAccount.name + " · " + activeAccount.key) : null);
        } else {
          body = React.createElement(Body, {
            data: state && state.ok ? state : null,
            now: now,
            accountId: acct.activeAccountId,
            refreshToken: refreshToken,
          });
        }

        return React.createElement("div", { className: "dsh-uq-card", key: provider }, head, body);
      }

      return React.createElement("div", { className: "dsh-uq-page" },
        React.createElement("div", { className: "dsh-uq-head" },
          React.createElement("h2", { className: "dsh-uq-title" }, "用量查询"),
          React.createElement("span", { className: "dsh-uq-desc" }, "DeepSeek · OpenCode Go · OpenDesign 余额与用量总览")),
        React.createElement("div", { className: "dsh-uq-bar" },
          React.createElement("span", { className: "dsh-uq-muted" }, updated ? ageText(updated, now) + " · " + fmtTime(updated) : "正在同步…"),
          React.createElement("div", { className: "dsh-uq-btns" },
            React.createElement("label", { className: "dsh-uq-muted", style: { display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" } },
              React.createElement("input", { type: "checkbox", checked: auto, onChange: function (event) { setAuto(event.target.checked); } }),
              "自动刷新"),
            React.createElement("button", {
              type: "button",
              className: "dsh-uq-btn dsh-uq-btn-primary",
              onClick: function () { refreshAll(true); },
              disabled: PROVIDERS.some(function (provider) { return !!loading[provider]; }),
            }, PROVIDERS.some(function (provider) { return !!loading[provider]; }) ? "正在刷新…" : "刷新全部"))),
        errors.accounts ? React.createElement(Alert, { tone: "bad", action: React.createElement("button", {
          type: "button",
          className: "dsh-uq-btn dsh-uq-btn-sm",
          onClick: function () { loadAccounts(); },
        }, "重试") }, errors.accounts) : null,
        React.createElement("div", { className: "dsh-uq-chips" }, chips),
        card("deepseek", DeepseekBody),
        card("opencode", OpencodeBody),
        card("opendesign", OpendesignBody),
        drawer ? React.createElement(AccountDrawer, {
          provider: drawer,
          acct: providerAccount(drawer),
          onClose: function () { setDrawer(null); },
          onSwitch: function (id) { switchAccount(drawer, id); },
          onChanged: function () {
            loadAccounts();
            PROVIDERS.forEach(function (provider) { loadProvider(provider, true); });
          },
        }) : null);
    }

    function apply(ctx) {
      // 样式随插件生命周期注册，卸载/HMR 时移除，避免重复注入与残留。
      ctx.effect(function () {
        if (typeof document === "undefined") return;
        var previous = document.getElementById(CSS_ID);
        if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
        var style = document.createElement("style");
        style.id = CSS_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        return function () {
          if (style.parentNode) style.parentNode.removeChild(style);
        };
      }, "dsh-usage-query: styles");

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          { name: "settings.section", id: SECTION.id, label: SECTION.label, order: SECTION.order },
          function () { return React.createElement(UsageQueryPage); },
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
