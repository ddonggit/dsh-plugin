// Login / first-run setup / password change pages. Self-contained HTML: no
// external fonts, scripts or images, so the strict CSP applied by the gate
// never has to be relaxed for them.

import { AUTH_BASE, MIN_PASSWORD_LENGTH } from './core.js';

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  background:var(--bg,#f5f6f8);color:var(--fg,#16181d)}
@media (prefers-color-scheme:dark){body{background:var(--bg,#14161a);color:var(--fg,#e8eaee)}}
.card{width:100%;max-width:380px;background:var(--card,#fff);border:1px solid var(--border,rgba(127,127,127,.22));
  border-radius:14px;padding:26px 24px 22px;box-shadow:0 10px 30px rgba(0,0,0,.07)}
@media (prefers-color-scheme:dark){.card{background:var(--card,#1c1f24);box-shadow:0 10px 30px rgba(0,0,0,.4)}}
h1{margin:0 0 6px;font-size:17px;font-weight:600}
p.lead{margin:0 0 18px;font-size:12.5px;line-height:1.65;color:var(--muted,#6b7280)}
label{display:block;margin:0 0 12px}
span.lbl{display:block;margin:0 0 5px;font-size:12px;color:var(--muted,#6b7280)}
input{width:100%;height:38px;padding:0 11px;font-size:13.5px;color:inherit;background:var(--input,#fff);
  border:1px solid var(--border,rgba(127,127,127,.3));border-radius:8px;outline:none}
@media (prefers-color-scheme:dark){input{background:var(--input,#14161a)}}
input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.18)}
button{width:100%;height:38px;margin-top:6px;font-size:13.5px;font-weight:600;color:#fff;background:#2563eb;
  border:none;border-radius:8px;cursor:pointer}
button:hover{background:#1d4ed8}
button:disabled{opacity:.6;cursor:default}
.msg{margin:0 0 14px;padding:9px 11px;border-radius:8px;font-size:12.5px;line-height:1.6;overflow-wrap:anywhere}
.msg.bad{background:#fdecec;color:#8f2323;border:1px solid #f3c9c9}
.msg.ok{background:#e8f7ef;color:#0a5d36;border:1px solid #bfe8d2}
.msg.info{background:#edf3ff;color:#2b4f8a;border:1px solid #cddcf7}
.foot{margin:16px 0 0;font-size:11.5px;line-height:1.7;color:var(--muted,#6b7280)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow-wrap:anywhere}
a{color:#2563eb}
`;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell({ title, body }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
${body}
</main>
</body>
</html>`;
}

function message({ error, notice }) {
  if (error) return `<p class="msg bad">${esc(error)}</p>`;
  if (notice) return `<p class="msg ok">${esc(notice)}</p>`;
  return '';
}

export function renderLoginPage({ next = '/', error = null, notice = null, setup = false, setupTokenHint = '' } = {}) {
  const action = `${AUTH_BASE}/login`;
  const body = setup
    ? `
<h1>设置访问密码</h1>
<p class="lead">这台 DSH Web 入口还没有访问密码。首次设置需要一次性口令（setup token），它由 dsh-https 在启动时生成，保存在服务器上；设置成功后该口令立即失效。</p>
${message({ error, notice })}
<form method="post" action="${esc(action)}" autocomplete="off">
  <input type="hidden" name="next" value="${esc(next)}">
  <label><span class="lbl">一次性口令</span><input type="password" name="setupToken" autocomplete="off" autofocus required></label>
  <label><span class="lbl">新密码（至少 ${MIN_PASSWORD_LENGTH} 位）</span><input type="password" name="password" autocomplete="new-password" required></label>
  <label><span class="lbl">再输一次</span><input type="password" name="confirm" autocomplete="new-password" required></label>
  <button type="submit">设置并登录</button>
</form>
<p class="foot">忘记口令或无法完成设置时，在服务器上运行 <code>node scripts/provision-auth.mjs --password-file /root/.dsh/dsh-https-initial-password.txt</code> 重新生成。</p>`
    : `
<h1>需要登录</h1>
<p class="lead">这个 DSH Web 入口已启用访问密码。登录后浏览器会记住 ${esc('30')} 天（可在配置里调整），期间无需重复输入。</p>
${message({ error, notice })}
<form method="post" action="${esc(action)}" autocomplete="off">
  <input type="hidden" name="next" value="${esc(next)}">
  <label><span class="lbl">访问密码</span><input type="password" name="password" autocomplete="current-password" autofocus required></label>
  <button type="submit">登录</button>
</form>
<p class="foot">${setupTokenHint ? esc(setupTokenHint) : '忘记密码？在服务器上运行 <code>node scripts/provision-auth.mjs</code> 可以重设（会同时下线所有已登录浏览器）。'}</p>`;
  return shell({ title: setup ? '设置访问密码' : '需要登录', body });
}

export function renderPasswordPage({ next = '/', error = null, notice = null } = {}) {
  const action = `${AUTH_BASE}/password`;
  const body = `
<h1>修改访问密码</h1>
<p class="lead">修改后所有已登录的浏览器（包括当前这个）都会下线，需要用新密码重新登录。</p>
${message({ error, notice })}
<form method="post" action="${esc(action)}" autocomplete="off">
  <input type="hidden" name="next" value="${esc(next)}">
  <label><span class="lbl">当前密码</span><input type="password" name="currentPassword" autocomplete="current-password" autofocus required></label>
  <label><span class="lbl">新密码（至少 ${MIN_PASSWORD_LENGTH} 位）</span><input type="password" name="newPassword" autocomplete="new-password" required></label>
  <label><span class="lbl">再输一次</span><input type="password" name="confirm" autocomplete="new-password" required></label>
  <button type="submit">保存并重新登录</button>
</form>
<p class="foot"><a href="${AUTH_BASE}/logout">退出登录</a></p>`;
  return shell({ title: '修改访问密码', body });
}

export function renderErrorPage({ status = 400, title = '请求有误', messageText = '' } = {}) {
  const body = `
<h1>${esc(title)}</h1>
${messageText ? `<p class="msg bad">${esc(messageText)}</p>` : ''}
<p class="foot"><a href="${AUTH_BASE}/login">返回登录页</a></p>`;
  return { status, html: shell({ title, body }) };
}