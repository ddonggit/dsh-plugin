// dsh-https 浏览器端：设置页「HTTPS 接入」。
// 唯一 id 契约：__ModuleLoader__.load.id === package.json name === patch.yml insert.id。
window.__ModuleLoader__.load({
  id: "dsh-https",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var SECTION = { id: "dsh-https", label: "HTTPS 接入", order: 60, title: "HTTPS 接入", desc: "为 dsh web 提供 TLS 终止入口、证书状态与自动续期" };
    var API = "/api/dsh-https";
    var CSS_TAG = "dsh-https/style";

    var CSS = [
      ".dsh-https-page{display:flex;flex-direction:column;width:100%;max-width:820px;min-width:0;margin:0 auto;padding:0 24px 32px;box-sizing:border-box}",
      ".dsh-https-head{display:flex;flex-direction:column;gap:2px;padding:16px 0 2px;flex:none}",
      ".dsh-https-title{font-size:14px;font-weight:400;color:var(--dsw-alias-label-primary,#0f1115);line-height:22px}",
      ".dsh-https-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);line-height:20px}",
      ".dsh-https-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 0 12px;flex:none;flex-wrap:wrap}",
      ".dsh-https-muted{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b)}",
      ".dsh-https-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.15));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);margin:0 0 12px;overflow:hidden;min-width:0}",
      ".dsh-https-cardHead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;flex-wrap:wrap;min-width:0}",
      ".dsh-https-cardTitle{font-size:14px;font-weight:400;color:var(--dsw-alias-label-primary,#0f1115);line-height:22px}",
      ".dsh-https-cardBody{padding:0 16px 14px;display:flex;flex-direction:column;gap:8px}",
      ".dsh-https-row{display:flex;gap:10px;align-items:baseline;font-size:12px;line-height:20px;min-width:0}",
      ".dsh-https-key{color:var(--dsw-alias-label-secondary,#61666b);flex:none;min-width:76px}",
      ".dsh-https-val{color:var(--dsw-alias-label-primary,#0f1115);min-width:0;overflow-wrap:anywhere}",
      ".dsh-https-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:18px}",
      ".dsh-https-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:20px;border:1px solid transparent;white-space:nowrap}",
      ".dsh-https-badge-ok{color:#0a6b3d;background:#e8f7ef;border-color:#bfe8d2}",
      ".dsh-https-badge-warn{color:#8a5a00;background:#fff6df;border-color:#f2dfb0}",
      ".dsh-https-badge-bad{color:#a12a2a;background:#fdecec;border-color:#f3c9c9}",
      ".dsh-https-badge-info{color:#2b4f8a;background:#edf3ff;border-color:#cddcf7}",
      ".dsh-https-btns{display:flex;gap:8px;flex-wrap:wrap}",
      ".dsh-https-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);border-radius:999px;height:30px;padding:0 14px;font-size:12px;cursor:pointer}",
      ".dsh-https-btn:hover{background:var(--dsw-alias-bg-layer-2,#f5f5f5)}",
      ".dsh-https-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".dsh-https-btn-primary{background:#0f1115;color:#fff;border-color:#0f1115}",
      ".dsh-https-btn-primary:hover{background:#2a2d33}",
      ".dsh-https-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}",
      ".dsh-https-url{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}",
      ".dsh-https-url a{color:var(--dsw-alias-brand-primary,#2b6cb0);text-decoration:none;font-size:12px;overflow-wrap:anywhere}",
      ".dsh-https-url a:hover{text-decoration:underline}",
      ".dsh-https-alert{border-radius:8px;padding:8px 10px;font-size:12px;line-height:19px;overflow-wrap:anywhere}",
      ".dsh-https-alert-bad{background:#fdecec;color:#8f2323;border:1px solid #f3c9c9}",
      ".dsh-https-alert-warn{background:#fff6df;color:#7a5200;border:1px solid #f2dfb0}",
      ".dsh-https-alert-ok{background:#e8f7ef;color:#0a5d36;border:1px solid #bfe8d2}",
      ".dsh-https-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}",
      ".dsh-https-metric{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12));border-radius:8px;padding:8px 10px;min-width:0}",
      ".dsh-https-metricLabel{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);line-height:18px}",
      ".dsh-https-metricValue{font-size:13px;color:var(--dsw-alias-label-primary,#0f1115);line-height:20px;overflow-wrap:anywhere}",
      ".dsh-https-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".dsh-https-fieldLabel{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);line-height:18px}",
      ".dsh-https-input{height:30px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:12px;padding:0 10px;min-width:0;width:100%;box-sizing:border-box}",
      ".dsh-https-seg{display:flex;gap:6px;flex-wrap:wrap}",
      ".dsh-https-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary,#0f1115)}",
      ".dsh-https-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#61666b);line-height:18px}",
      ".dsh-https-formGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}",
      "@media (max-width:640px){.dsh-https-page{padding:0 14px 24px}.dsh-https-grid{grid-template-columns:1fr}.dsh-https-formGrid{grid-template-columns:1fr}.dsh-https-key{min-width:64px}}",
    ].join("");

    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.getElementById(CSS_TAG)) return;
      var style = document.createElement("style");
      style.id = CSS_TAG;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    function fmtTime(value) {
      if (!value) return "—";
      var date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString("zh-CN", { hour12: false });
    }

    function fmtFingerprint(value) {
      if (!value) return "—";
      var hex = String(value).replace(/[^0-9a-f]/gi, "").toUpperCase();
      return (hex.match(/.{2}/g) || []).join(":");
    }

    function badge(text, tone) {
      return React.createElement("span", { className: "dsh-https-badge dsh-https-badge-" + (tone || "info") }, text);
    }

    // The host only ever reports disabled / misconfigured / idle / issuing /
    // valid / error; map them to human labels instead of leaking raw phases.
    var ACME_PHASES = {
      disabled: ["未启用", "warn"],
      misconfigured: ["配置不完整", "bad"],
      idle: ["待机", "info"],
      issuing: ["签发中", "info"],
      valid: ["证书有效", "ok"],
      ready: ["已就绪", "ok"],
      error: ["错误", "bad"],
      starting: ["启动中", "info"]
    };

    function acmeBadge(acme) {
      if (!acme || !acme.enabled) return badge("未启用", "warn");
      var entry = ACME_PHASES[acme.phase] || ["待机", "info"];
      return badge(entry[0], entry[1]);
    }

    function row(label, value, mono) {
      return React.createElement(
        "div",
        { className: "dsh-https-row" },
        React.createElement("span", { className: "dsh-https-key" }, label),
        React.createElement("span", { className: "dsh-https-val" + (mono ? " dsh-https-mono" : "") }, value)
      );
    }

    function field(label, control) {
      return React.createElement(
        "label",
        { className: "dsh-https-field" },
        React.createElement("span", { className: "dsh-https-fieldLabel" }, label),
        control
      );
    }

    function copyText(text) {
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () {});
        return;
      }
      try {
        var area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      } catch (error) {
        // Clipboard is best-effort.
      }
    }

    function certificateCard(title, data, isPublic) {
      if (!data) return null;
      var available = data.available;
      var tone = available ? "ok" : data.error ? "bad" : "warn";
      var label = available ? "可用" : data.error ? "错误" : "未配置";
      var body = [];
      if (isPublic) {
        body.push(row("来源", data.source === "acme" ? "ACME 自动签发" : data.source === "files" ? "证书文件" : "—"));
        if (data.source === "files" && data.certFile) body.push(row("证书文件", data.certFile, true));
        if (data.staging !== null && data.staging !== undefined) {
          body.push(row("环境", data.staging ? "Let's Encrypt Staging" : "Let's Encrypt Production"));
        }
        body.push(row("域名", (data.san || []).map(function (item) { return (item.type === "ip" ? "IP " : "") + item.value; }).join("，") || "—"));
        body.push(row("到期", fmtTime(data.notAfter) + (typeof data.daysLeft === "number" ? "（剩 " + data.daysLeft + " 天）" : "")));
        body.push(row("签发者", data.issuer || "—", true));
        body.push(row("指纹", fmtFingerprint(data.fingerprintSha256), true));
        if (data.chainLength) body.push(row("链长度", data.chainLength + " 张证书"));
      } else {
        body.push(row("根证书", data.caFile || "—", true));
        body.push(row("根指纹", fmtFingerprint(data.caFingerprintSha256), true));
        body.push(row("根到期", fmtTime(data.caNotAfter)));
        body.push(row("叶证书到期", fmtTime(data.leafNotAfter) + (typeof data.leafDaysLeft === "number" ? "（剩 " + data.leafDaysLeft + " 天）" : "")));
        body.push(row("覆盖名称", (data.sans || []).map(function (item) { return (item.type === "ip" ? "IP " : "") + item.value; }).join("，") || "—"));
        if (data.caKeyMode) body.push(row("私钥权限", "0o" + (Number(data.caKeyMode) & 0o777).toString(8).padStart(3, "0")));
      }
      if (data.error) {
        body.push(React.createElement("div", { className: "dsh-https-alert dsh-https-alert-bad" }, data.error));
      }
      return React.createElement(
        "div",
        { className: "dsh-https-card" },
        React.createElement(
          "div",
          { className: "dsh-https-cardHead" },
          React.createElement("span", { className: "dsh-https-cardTitle" }, title),
          badge(label, tone)
        ),
        React.createElement("div", { className: "dsh-https-cardBody" }, body)
      );
    }

    function HttpsPage() {
      ensureCss();
      var stateHook = React.useState({ loading: true, error: null, data: null });
      var state = stateHook[0];
      var setState = stateHook[1];
      var busyHook = React.useState(false);
      var busy = busyHook[0];
      var setBusy = busyHook[1];
      var noticeHook = React.useState(null);
      var notice = noticeHook[0];
      var setNotice = noticeHook[1];

      function load(showBusy) {
        if (showBusy) setBusy(true);
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
          })
          .then(function () {
            if (showBusy) setBusy(false);
          });
      }

      React.useEffect(function () {
        load(false);
        var timer = setInterval(function () { load(false); }, 15000);
        return function () { clearInterval(timer); };
      }, []);

      function renew() {
        if (busy) return;
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          if (!window.confirm("现在向 Let's Encrypt 申请/续期证书？Staging 环境签发的证书浏览器不会信任。")) return;
        }
        setBusy(true);
        setNotice(null);
        fetch(API + "/renew", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: true }),
        })
          .then(function (response) {
            return response.json().then(function (body) {
              if (!response.ok) throw new Error(body && body.error ? body.error : "HTTP " + response.status);
              return body;
            });
          })
          .then(function (body) {
            setNotice({ tone: "ok", text: "已开始签发任务（" + (body.status || "started") + "），完成后状态会自动刷新。" });
            setTimeout(function () { load(false); }, 2500);
            setTimeout(function () { load(false); }, 8000);
          })
          .catch(function (error) {
            setNotice({ tone: "bad", text: String(error && error.message ? error.message : error) });
          })
          .then(function () {
            setBusy(false);
          });
      }

      var data = state.data;
      var listener = data && data.listener ? data.listener : {};
      var certs = data && data.certs ? data.certs : {};
      var acme = data && data.acme ? data.acme : {};
      var settings = (data && data.settings) || {};
      var settingsAcme = settings.acme || {};
      var credentials = settings.credentials || {};
      var urls = data && data.publicUrls && Array.isArray(data.publicUrls.https) ? data.publicUrls.https : [];
      var running = Boolean(data && data.started && listener.running);
      var errors = (data && data.errors) || [];
      var warnings = (data && data.warnings) || [];

      var draftHook = React.useState({ mode: "files", email: "", domains: "", zone: "", staging: true, secretId: "" });
      var draft = draftHook[0];
      var setDraft = draftHook[1];
      var secretHook = React.useState("");
      var secretKey = secretHook[0];
      var setSecretKey = secretHook[1];
      var savingHook = React.useState(null);
      var saving = savingHook[0];
      var setSaving = savingHook[1];
      var sigHook = React.useState("");
      var formSig = [
        settings.mode || "",
        settingsAcme.email || "",
        (settingsAcme.domains || []).join(","),
        settingsAcme.zone || "",
        String(settingsAcme.staging),
      ].join("|");
      // Keep the form in sync with the server after every reload, without
      // overwriting what the user is typing in between reloads.
      if (data && sigHook[0] !== formSig) {
        sigHook[1](formSig);
        setDraft({
          mode: settings.mode || "files",
          email: settingsAcme.email || "",
          domains: (settingsAcme.domains || []).join(", "),
          zone: settingsAcme.zone || "",
          staging: settingsAcme.staging !== false,
          secretId: "",
        });
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

      function saveMode(nextMode) {
        if (saving) return;
        var payload = {
          mode: nextMode,
          acme: {
            email: draft.email,
            domains: draft.domains,
            zone: draft.zone,
            staging: Boolean(draft.staging),
          },
        };
        if (nextMode === "acme" && typeof window !== "undefined" && typeof window.confirm === "function") {
          if (!window.confirm("切换到自动证书？会用下面填写的邮箱和域名为 Let's Encrypt 申请证书，签发成功前继续使用当前证书。")) return;
        }
        setSaving("settings");
        setNotice(null);
        postJson("/settings", payload)
          .then(function (body) {
            if (body.status) setState({ loading: false, error: null, data: body.status });
            setNotice({ tone: "ok", text: nextMode === "acme" ? "已切换到自动证书，正在申请，状态会自动刷新。" : "已切换到证书文件模式。" });
            setTimeout(function () { load(false); }, 2500);
          })
          .catch(function (error) {
            setNotice({ tone: "bad", text: String(error && error.message ? error.message : error) });
          })
          .then(function () { setSaving(null); });
      }

      function saveCredential() {
        if (saving) return;
        if (!draft.secretId && !secretKey) {
          setNotice({ tone: "warn", text: "请先填写 SecretId 和 SecretKey。" });
          return;
        }
        setSaving("credentials");
        setNotice(null);
        postJson("/credentials", { secretId: draft.secretId, secretKey: secretKey })
          .then(function (body) {
            setSecretKey("");
            setDraft(function (prev) {
              return { mode: prev.mode, email: prev.email, domains: prev.domains, zone: prev.zone, staging: prev.staging, secretId: "" };
            });
            if (body.status) setState({ loading: false, error: null, data: body.status });
            setNotice({ tone: "ok", text: "腾讯云密钥已保存（文件权限 600），下一次签发会使用它。" });
          })
          .catch(function (error) {
            setNotice({ tone: "bad", text: String(error && error.message ? error.message : error) });
          })
          .then(function () { setSaving(null); });
      }

      var header = React.createElement(
        "div",
        { className: "dsh-https-head" },
        React.createElement("div", { className: "dsh-https-title" }, SECTION.title),
        React.createElement("div", { className: "dsh-https-desc" }, SECTION.desc)
      );

      var toolbar = React.createElement(
        "div",
        { className: "dsh-https-toolbar" },
        React.createElement(
          "span",
          { className: "dsh-https-muted" },
          state.loading ? "正在读取状态…" : "监听 " + (listener.host || "—") + ":" + (listener.actualPort || listener.port || "—") + " → 上游 " + (data && data.upstream ? data.upstream.host + ":" + data.upstream.port : "—")
        ),
        React.createElement(
          "div",
          { className: "dsh-https-btns" },
          React.createElement("button", { type: "button", className: "dsh-https-btn", onClick: function () { load(true); }, disabled: busy }, busy ? "刷新中…" : "刷新"),
          React.createElement("button", { type: "button", className: "dsh-https-btn dsh-https-btn-primary", onClick: renew, disabled: busy || !acme.usable }, busy ? "处理中…" : "立即续期")
        )
      );

      var alerts = [];
      if (state.error) alerts.push(React.createElement("div", { key: "fetch", className: "dsh-https-alert dsh-https-alert-bad" }, "状态读取失败：" + state.error));
      if (notice) alerts.push(React.createElement("div", { key: "notice", className: "dsh-https-alert dsh-https-alert-" + notice.tone }, notice.text));
      if (data && data.error) alerts.push(React.createElement("div", { key: "fatal", className: "dsh-https-alert dsh-https-alert-bad" }, data.error));
      errors.forEach(function (message, index) {
        alerts.push(React.createElement("div", { key: "err" + index, className: "dsh-https-alert dsh-https-alert-bad" }, message));
      });
      warnings.forEach(function (message, index) {
        alerts.push(React.createElement("div", { key: "warn" + index, className: "dsh-https-alert dsh-https-alert-warn" }, message));
      });
      if (!running && !data?.error) {
        alerts.push(React.createElement("div", { key: "stopped", className: "dsh-https-alert dsh-https-alert-warn" }, "HTTPS 监听未运行；请查看上方错误或 profile 日志。"));
      }

      var overview = React.createElement(
        "div",
        { className: "dsh-https-card" },
        React.createElement(
          "div",
          { className: "dsh-https-cardHead" },
          React.createElement("span", { className: "dsh-https-cardTitle" }, "运行状态"),
          running ? badge("运行中", "ok") : badge("未运行", "bad")
        ),
        React.createElement(
          "div",
          { className: "dsh-https-cardBody" },
          React.createElement(
            "div",
            { className: "dsh-https-grid" },
            React.createElement("div", { className: "dsh-https-metric" }, React.createElement("div", { className: "dsh-https-metricLabel" }, "HTTPS 端口"), React.createElement("div", { className: "dsh-https-metricValue" }, String(listener.actualPort || listener.port || "—"))),
            React.createElement("div", { className: "dsh-https-metric" }, React.createElement("div", { className: "dsh-https-metricLabel" }, "默认证书"), React.createElement("div", { className: "dsh-https-metricValue" }, certs.defaultSource === "public" ? "公网证书" : certs.defaultSource === "local" ? "本地 CA" : "无")),
            React.createElement("div", { className: "dsh-https-metric" }, React.createElement("div", { className: "dsh-https-metricLabel" }, "上游"), React.createElement("div", { className: "dsh-https-metricValue" }, data && data.upstream ? data.upstream.protocol + "://" + data.upstream.host + ":" + data.upstream.port : "—")),
            React.createElement("div", { className: "dsh-https-metric" }, React.createElement("div", { className: "dsh-https-metricLabel" }, "版本"), React.createElement("div", { className: "dsh-https-metricValue" }, data && data.version ? "v" + data.version : "—"))
          ),
          urls.length > 0
            ? React.createElement(
                "div",
                null,
                React.createElement("div", { className: "dsh-https-muted", style: { paddingTop: "4px" } }, "可用地址"),
                React.createElement(
                  "ul",
                  { className: "dsh-https-list" },
                  urls.map(function (url) {
                    return React.createElement(
                      "li",
                      { key: url, className: "dsh-https-url" },
                      React.createElement("a", { href: url, target: "_blank", rel: "noreferrer" }, url),
                      React.createElement("button", { type: "button", className: "dsh-https-btn", onClick: function () { copyText(url); } }, "复制")
                    );
                  })
                )
              )
            : null,
          React.createElement(
            "div",
            { className: "dsh-https-row" },
            React.createElement("span", { className: "dsh-https-key" }, "CA 引导页"),
            React.createElement("span", { className: "dsh-https-val" }, React.createElement("a", { href: "/dsh-https/", target: "_blank", rel: "noreferrer" }, "/dsh-https/"), "（下载本地根证书）")
          )
        )
      );

      var modeLabel = settings.mode === "acme" ? "自动证书（ACME）" : settings.mode === "files" ? "证书文件" : "本地 CA";
      var settingsCard = React.createElement(
        "div",
        { className: "dsh-https-card" },
        React.createElement(
          "div",
          { className: "dsh-https-cardHead" },
          React.createElement("span", { className: "dsh-https-cardTitle" }, "证书来源"),
          badge(modeLabel, settings.mode === "acme" ? "info" : "ok")
        ),
        React.createElement(
          "div",
          { className: "dsh-https-cardBody" },
          React.createElement(
            "div",
            { className: "dsh-https-seg" },
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-https-btn" + (draft.mode === "files" ? " dsh-https-btn-primary" : ""),
                onClick: function () { saveMode("files"); },
                disabled: Boolean(saving) || draft.mode === "files",
              },
              "使用证书文件"
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "dsh-https-btn" + (draft.mode === "acme" ? " dsh-https-btn-primary" : ""),
                onClick: function () { saveMode("acme"); },
                disabled: Boolean(saving) || draft.mode === "acme",
              },
              saving === "settings" ? "保存中…" : "使用自动证书"
            )
          ),
          row("当前文件", settings.files && settings.files.certFile ? settings.files.certFile : "—", true),
          React.createElement(
            "div",
            { className: "dsh-https-hint" },
            "证书文件模式读取 profile 里配置的证书路径，文件更新后会自动热加载；自动证书模式由插件向 Let's Encrypt 申请并自动续期，签发成功前继续使用当前证书。"
          ),
          React.createElement("div", { className: "dsh-https-fieldLabel", style: { paddingTop: "4px" } }, "自动证书参数"),
          React.createElement(
            "div",
            { className: "dsh-https-formGrid" },
            field("邮箱", React.createElement("input", {
              className: "dsh-https-input",
              type: "email",
              value: draft.email,
              placeholder: "you@example.com",
              onChange: function (event) { setDraft(Object.assign({}, draft, { email: event.target.value })); },
            })),
            field("域名（逗号分隔）", React.createElement("input", {
              className: "dsh-https-input",
              type: "text",
              value: draft.domains,
              placeholder: "dsh.example.com, *.dsh.example.com",
              onChange: function (event) { setDraft(Object.assign({}, draft, { domains: event.target.value })); },
            })),
            field("DNS 区域（可留空自动识别）", React.createElement("input", {
              className: "dsh-https-input",
              type: "text",
              value: draft.zone,
              placeholder: "example.com",
              onChange: function (event) { setDraft(Object.assign({}, draft, { zone: event.target.value })); },
            })),
            React.createElement(
              "label",
              { className: "dsh-https-check", style: { paddingTop: "18px" } },
              React.createElement("input", {
                type: "checkbox",
                checked: Boolean(draft.staging),
                onChange: function (event) { setDraft(Object.assign({}, draft, { staging: event.target.checked })); },
              }),
              "使用 Staging（测试环境，浏览器不信任）"
            )
          ),
          React.createElement(
            "div",
            { className: "dsh-https-btns" },
            React.createElement(
              "button",
              { type: "button", className: "dsh-https-btn", onClick: function () { saveMode(draft.mode); }, disabled: Boolean(saving) },
              "保存自动证书参数"
            )
          ),
          React.createElement("div", { className: "dsh-https-fieldLabel", style: { paddingTop: "6px" } }, "腾讯云 DNSPod 密钥"),
          row("已保存", credentials.configured ? credentials.secretIdHint || "已配置" : "未配置"),
          React.createElement(
            "div",
            { className: "dsh-https-formGrid" },
            field("SecretId", React.createElement("input", {
              className: "dsh-https-input",
              type: "text",
              value: draft.secretId,
              placeholder: credentials.configured ? "留空表示不修改" : "AKID...",
              autoComplete: "off",
              onChange: function (event) { setDraft(Object.assign({}, draft, { secretId: event.target.value })); },
            })),
            field("SecretKey", React.createElement("input", {
              className: "dsh-https-input",
              type: "password",
              value: secretKey,
              placeholder: credentials.configured ? "留空表示不修改" : "请输入 SecretKey",
              autoComplete: "new-password",
              onChange: function (event) { setSecretKey(event.target.value); },
            }))
          ),
          React.createElement(
            "div",
            { className: "dsh-https-hint" },
            "密钥只保存在本机（06" + "00 权限文件），页面上只显示掩码。需要 DNS 解析权限（DNSPod 的 DNS 记录读写）。"
          ),
          React.createElement(
            "div",
            { className: "dsh-https-btns" },
            React.createElement(
              "button",
              { type: "button", className: "dsh-https-btn dsh-https-btn-primary", onClick: saveCredential, disabled: Boolean(saving) },
              saving === "credentials" ? "保存中…" : "保存密钥"
            )
          )
        )
      );

      var acmeCard = React.createElement(
        "div",
        { className: "dsh-https-card" },
        React.createElement(
          "div",
          { className: "dsh-https-cardHead" },
          React.createElement("span", { className: "dsh-https-cardTitle" }, "ACME 自动证书"),
          acmeBadge(acme)
        ),
        React.createElement(
          "div",
          { className: "dsh-https-cardBody" },
          row("目录", acme.directory || "—", true),
          row("环境", acme.staging ? "Staging（浏览器不信任）" : "Production"),
          row("域名", (acme.domains || []).join("，") || "—"),
          row("区域", acme.zone || "—"),
          row("上次成功", fmtTime(acme.lastSuccess)),
          row("下次检查", fmtTime(acme.nextAttempt)),
          acme.challenge ? row("当前挑战", acme.challenge) : null,
          acme.lastError ? React.createElement("div", { className: "dsh-https-alert dsh-https-alert-bad" }, acme.lastError) : null,
          React.createElement(
            "div",
            { className: "dsh-https-muted" },
            acme.enabled && acme.usable
              ? "证书到期前会自动续期；也可点右上角「立即续期」手动触发（10 分钟内只允许一次）。"
              : acme.enabled
                ? "ACME 已启用但配置不完整，请在上方填写邮箱、域名，并保存腾讯云密钥。"
                : "在上方「证书来源」里点「使用自动证书」即可启用，无需重启。"
          )
        )
      );

      return React.createElement(
        "div",
        { className: "dsh-https-page" },
        header,
        toolbar,
        alerts,
        overview,
        settingsCard,
        certificateCard("公网证书", certs.public, true),
        certificateCard("本地 CA", certs.local, false),
        acmeCard
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
