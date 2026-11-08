// Login / first-run setup / password change pages. Self-contained HTML: no
// external fonts, scripts or images, so the strict CSP applied by the gate
// never has to be relaxed for them.

import { AUTH_BASE, MIN_PASSWORD_LENGTH } from './core.js';

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;
  font-size:14px;line-height:1.65;background:#f4efe5;color:#2b2620}
.card{width:100%;max-width:400px;background:#fbf9f4;border:1px solid #e3dbcc;border-radius:12px;
  padding:28px 26px 24px}
.brand{margin:0 0 14px;color:#776e60;font-size:12px;line-height:1.5}
h1{margin:0 0 6px;font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.01em}
p.lead{margin:0 0 18px;color:#60584b;font-size:13px;line-height:1.65}
label{display:block;margin:0 0 14px}
span.lbl{display:block;margin:0 0 5px;color:#60584b;font-size:13px;line-height:1.5}
input{width:100%;height:40px;padding:0 11px;font:inherit;font-size:14px;color:inherit;background:#fff;
  border:1px solid #d4c8b4;border-radius:8px;outline:none}
input:focus{border-color:#4c4665;outline:2px solid rgba(76,70,101,.28);outline-offset:1px}
button{width:100%;height:40px;margin-top:4px;font:inherit;font-size:14px;font-weight:500;color:#fbf9f4;
  background:#4c4665;border:1px solid #4c4665;border-radius:8px;cursor:pointer}
button:hover{background:#3e3955;border-color:#3e3955}
button:focus-visible{outline:2px solid #4c4665;outline-offset:2px}
button:disabled{opacity:.55;cursor:default}
.msg{margin:0 0 16px;padding:10px 12px;border:1px solid #e3dbcc;border-left:3px solid #9c3b45;
  border-radius:8px;background:#f3efe6;color:#60584b;font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.msg.ok{border-left-color:#2c7349}
.hint{margin:4px 0 0;color:#776e60;font-size:12px;line-height:1.6}
.foot{margin:18px 0 0;color:#776e60;font-size:12px;line-height:1.7;overflow-wrap:anywhere}
.foot a{color:#4c4665;text-decoration:none}
.foot a:hover{text-decoration:underline}
.foot a:focus-visible{outline:2px solid #4c4665;outline-offset:2px;border-radius:3px}
details{margin-top:14px;border-top:1px solid #e3dbcc;padding-top:10px}
summary{color:#60584b;font-size:12px;line-height:1.5;list-style:none;cursor:pointer}
summary::-webkit-details-marker{display:none}
summary::before{content:"+";display:inline-block;width:10px;color:#776e60}
details[open] summary::before{content:"−"}
details[open] summary{margin-bottom:6px}
summary:focus-visible{outline:2px solid #4c4665;outline-offset:2px;border-radius:3px}
details .detailBody{margin-top:8px;color:#60584b;font-size:12px;line-height:1.7;overflow-wrap:anywhere}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
@media (prefers-color-scheme:dark){
  body{background:#1a1815;color:#f1ece3}
  .card{background:#211f1c;border-color:#3b362d}
  .brand,.hint,.foot{color:#9c9384}
  p.lead,span.lbl,details .detailBody{color:#c3baab}
  input{background:#181613;border-color:#4d463a}
  input:focus{border-color:#cfc6e6;outline:2px solid rgba(207,198,230,.3);outline-offset:1px}
  button{color:#241f2b;background:#cfc6e6;border-color:#cfc6e6}
  button:hover{background:#ddd6ef;border-color:#ddd6ef}
  button:focus-visible{outline-color:#cfc6e6}
  .msg{background:#2b2823;border-color:#3b362d;color:#c3baab}
  .msg{border-left-color:#e4949b}
  .msg.ok{border-left-color:#82c99f}
  .foot a{color:#cfc6e6}
  details{border-top-color:#3b362d}
  summary{color:#c3baab}
  summary:focus-visible{outline-color:#cfc6e6}
}
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
<p class="brand">DSH</p>
${body}
</main>
</body>
</html>`;
}

function message({ error, notice }) {
  if (error) return `<p class="msg">${esc(error)}</p>`;
  if (notice) return `<p class="msg ok">${esc(notice)}</p>`;
  return '';
}

function resetHelp() {
  return `<details>
<summary>忘记密码？</summary>
<div class="detailBody">
在 dsh-https 插件目录里运行 <code>node scripts/provision-auth.mjs</code>，会生成一个新密码并让所有设备退出登录。
</div>
</details>`;
}

export function renderLoginPage({ next = '/', error = null, notice = null, setup = false, setupTokenHint = '' } = {}) {
  const action = `${AUTH_BASE}/login`;
  const body = setup
    ? `
<h1>设置访问密码</h1>
<p class="lead">第一次使用，先给这个网站设一个访问密码。以后打开它都要输入这个密码。</p>
${message({ error, notice })}
<form method="post" action="${esc(action)}" autocomplete="off">
  <input type="hidden" name="next" value="${esc(next)}">
  <label>
    <span class="lbl">一次性口令</span>
    <input type="password" name="setupToken" autocomplete="off" autofocus required>
    <span class="hint">在服务器的 dsh-https 数据目录里，文件名是 setup-token。</span>
  </label>
  <label><span class="lbl">新密码（至少 ${MIN_PASSWORD_LENGTH} 位）</span><input type="password" name="password" autocomplete="new-password" required></label>
  <label><span class="lbl">再输一次</span><input type="password" name="confirm" autocomplete="new-password" required></label>
  <button type="submit">保存并登录</button>
</form>
<p class="foot">设置成功后，这个一次性口令会立即失效。</p>`
    : `
<h1>输入访问密码</h1>
<p class="lead">这个网站已开启访问保护。输入密码后继续。</p>
${message({ error, notice })}
<form method="post" action="${esc(action)}" autocomplete="off">
  <input type="hidden" name="next" value="${esc(next)}">
  <label><span class="lbl">访问密码</span><input type="password" name="password" autocomplete="current-password" autofocus required></label>
  <button type="submit">登录</button>
</form>
${setupTokenHint ? `<p class="foot">${esc(setupTokenHint)}</p>` : resetHelp()}`;
  return shell({ title: setup ? '设置访问密码' : '输入访问密码', body });
}

export function renderPasswordPage({ next = '/', error = null, notice = null } = {}) {
  const action = `${AUTH_BASE}/password`;
  const body = `
<h1>修改访问密码</h1>
<p class="lead">保存后，所有设备都会退出登录，需要用新密码重新登录。</p>
${message({ error, notice })}
<form method="post" action="${esc(action)}" autocomplete="off">
  <input type="hidden" name="next" value="${esc(next)}">
  <label><span class="lbl">当前密码</span><input type="password" name="currentPassword" autocomplete="current-password" autofocus required></label>
  <label><span class="lbl">新密码（至少 ${MIN_PASSWORD_LENGTH} 位）</span><input type="password" name="newPassword" autocomplete="new-password" required></label>
  <label><span class="lbl">再输一次</span><input type="password" name="confirm" autocomplete="new-password" required></label>
  <button type="submit">保存新密码</button>
</form>`;
  return shell({ title: '修改访问密码', body });
}

export function renderErrorPage({ status = 400, title = '请求有误', messageText = '' } = {}) {
  const body = `
<h1>${esc(title)}</h1>
${messageText ? `<p class="msg">${esc(messageText)}</p>` : ''}
<p class="foot"><a href="${AUTH_BASE}/login">返回登录页</a></p>`;
  return { status, html: shell({ title, body }) };
}