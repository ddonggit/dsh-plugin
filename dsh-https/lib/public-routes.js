// Public CA landing page. It is deliberately dependency-free and
// self-contained: the strict CSP allows inline styles only.
//
// The page has three states because the old page always offered a download
// even when the local CA was disabled, which led to a 503. Only show the
// download when a certificate actually exists.

const PAGE_STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;
  font-size:14px;line-height:1.65;background:#f4efe5;color:#2b2620}
main{max-width:640px;margin:0 auto;padding:40px 20px 64px}
.brand{margin:0 0 14px;color:#776e60;font-size:12px;line-height:1.5}
h1{margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.01em}
h2{margin:26px 0 8px;font-size:14px;line-height:1.5;font-weight:600}
p{margin:0 0 10px;color:#60584b;font-size:13px;line-height:1.7;overflow-wrap:anywhere}
ol,ul{margin:0 0 10px;padding-left:20px;color:#60584b;font-size:13px;line-height:1.7}
li{margin:0 0 6px}
li:last-child{margin-bottom:0}
b{color:#2b2620;font-weight:600}
.card{background:#fbf9f4;border:1px solid #e3dbcc;border-radius:12px;padding:26px 24px 24px}
.button{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;
  color:#fbf9f4;background:#4c4665;border:1px solid #4c4665;border-radius:8px;font-size:14px;font-weight:500;
  line-height:1;text-decoration:none}
.button:hover{background:#3e3955;border-color:#3e3955}
.button:focus-visible{outline:2px solid #4c4665;outline-offset:2px}
.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 0 4px}
.link{color:#4c4665;font-size:13px;text-decoration:none}
.link:hover{text-decoration:underline}
.link:focus-visible{outline:2px solid #4c4665;outline-offset:2px;border-radius:3px}
.hint{margin:2px 0 0;color:#776e60;font-size:12px;line-height:1.6}
.note{margin:18px 0 0;padding:10px 12px;border:1px solid #e3dbcc;border-left:3px solid #7d5b1f;
  border-radius:8px;background:#f3efe6;color:#60584b;font-size:12px;line-height:1.65}
details{margin-top:8px;border-top:1px solid #e3dbcc;padding-top:10px}
summary{color:#2b2620;font-size:13px;line-height:1.6;font-weight:500;list-style:none;cursor:pointer}
summary::-webkit-details-marker{display:none}
summary::before{content:"+";display:inline-block;width:12px;color:#776e60;font-weight:400}
details[open] summary::before{content:"−"}
details[open] summary{margin-bottom:8px}
summary:focus-visible{outline:2px solid #4c4665;outline-offset:2px;border-radius:3px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
@media (prefers-color-scheme:dark){
  body{background:#1a1815;color:#f1ece3}
  .card{background:#211f1c;border-color:#3b362d}
  .brand,.hint{color:#9c9384}
  h2,b,summary{color:#f1ece3}
  p,ol,ul{color:#c3baab}
  .button{color:#241f2b;background:#cfc6e6;border-color:#cfc6e6}
  .button:hover{background:#ddd6ef;border-color:#ddd6ef}
  .button:focus-visible{outline-color:#cfc6e6}
  .link{color:#cfc6e6}
  .link:focus-visible{outline-color:#cfc6e6}
  .note{background:#2b2823;border-color:#3b362d;border-left-color:#d8b673;color:#c3baab}
  details{border-top-color:#3b362d}
  summary::before{color:#9c9384}
  summary:focus-visible{outline-color:#cfc6e6}
}
@media (max-width:480px){
  main{padding:28px 16px 48px}
  .card{padding:22px 18px}
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

function fmtDate(value) {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

function sansText(sans) {
  const list = (sans || [])
    .map((item) => (item && item.value ? String(item.value) : String(item || '')))
    .filter(Boolean);
  return list.length ? list.join('、') : '未知';
}

function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · DSH</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<p class="brand">DSH</p>
<div class="card">
${body}
</div>
</main>
</body>
</html>`;
}

function installSteps() {
  return `<h2>安装到你的设备</h2>
<details>
<summary>macOS</summary>
<ol>
<li>双击下载的证书，把它加入“钥匙串访问”。</li>
<li>打开“钥匙串访问”，在“系统”钥匙串里找到这张证书。</li>
<li>双击它，展开“信任”，把“使用此证书时”设为“始终信任”。</li>
</ol>
</details>
<details>
<summary>Windows</summary>
<ol>
<li>双击下载的证书，点“安装证书”。</li>
<li>选择“本地计算机”，点“下一步”。</li>
<li>选择“将所有的证书都放入下列存储”，浏览到“受信任的根证书颁发机构”，然后完成。</li>
</ol>
</details>
<details>
<summary>iPhone 和 iPad</summary>
<ol>
<li>用 Safari 打开这个页面，点上面的下载按钮。</li>
<li>打开“设置 → 通用 → VPN 与设备管理”，安装刚下载的描述文件。</li>
<li>再打开“设置 → 通用 → 关于本机 → 证书信任设置”，为这张证书打开完全信任。</li>
</ol>
</details>
<details>
<summary>Android</summary>
<ol>
<li>打开“设置 → 安全 → 加密与凭据”（不同品牌名称可能略有不同）。</li>
<li>选择“安装 CA 证书”，再选“CA 证书”，找到刚下载的文件安装。</li>
<li>系统可能要求你先设置锁屏密码。</li>
</ol>
</details>
<details>
<summary>Firefox</summary>
<ol>
<li>打开“设置 → 隐私与安全 → 证书 → 查看证书”。</li>
<li>切到“证书颁发机构”，点“导入”，选择刚下载的证书。</li>
<li>勾选“信任由此证书颁发机构来标识网站”。</li>
</ol>
</details>`;
}

function availablePage(local) {
  return page("安装本地证书", `
<h1>安装本地证书</h1>
<p>安装后，用这台服务器的地址打开 DSH 时，浏览器不会再提示“不安全”。每台设备只需要安装一次。</p>
<div class="actions">
  <a class="button" href="/dsh-https/ca.crt" download>下载证书</a>
  <a class="link" href="/">打开 DSH</a>
</div>
<p class="hint">下载的文件名是 dsh-local-ca.crt。</p>
${installSteps()}
<details>
<summary>这张证书</summary>
<p>根证书到期：${esc(fmtDate(local.caNotAfter))}</p>
<p>覆盖的地址：${esc(sansText(local.sans))}</p>
${local.leafNotAfter ? `<p>站点证书到期：${esc(fmtDate(local.leafNotAfter))}</p>` : ''}
</details>
<p class="note">只在你自己的设备上安装这张证书，不要把它发给别人。装了它的设备会信任这台服务器签发的网站证书。</p>`);
}

function disabledPage() {
  return page("本地证书", `
<h1>本地证书没有开启</h1>
<p>这个页面用来安装本地证书。当前配置里没有开启本地证书，所以还没有可下载的证书。</p>
<h2>怎么开启</h2>
<p>在插件配置里打开本地证书（localCa.enabled），重启 DSH Web，再重新打开这个页面。</p>
<p class="note">如果你的网站用的是公网域名和 Let's Encrypt 证书，就不需要安装本地证书，也不用开启它。</p>`);
}

function pendingPage(reason) {
  return page("本地证书", `
<h1>本地证书还在准备</h1>
<p>证书还没有生成好。稍等几秒，然后刷新这个页面。</p>
<div class="actions">
  <a class="button" href="/dsh-https/">刷新页面</a>
  <a class="link" href="/">打开 DSH</a>
</div>
${reason ? `<details><summary>技术详情</summary><p><code>${esc(reason)}</code></p></details>` : ''}`);
}

function landingHtml(local) {
  if (!local || !local.enabled) return disabledPage();
  if (!local.available) return pendingPage(local.error || '');
  return availablePage(local);
}

function send(res, status, type, body, extraHeaders = {}, headOnly = false) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'content-type': type,
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(headOnly ? undefined : payload);
}

export function registerPublicRoutes({ ctx, state }) {
  const webServer = ctx.get('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[dsh-https] 缺少 webServer 服务，CA 引导页未注册');
    return [];
  }

  const handler = (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { allow: 'GET, HEAD' });
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url, 'http://placeholder.local').pathname;
    } catch {
      send(res, 400, 'text/plain; charset=utf-8', 'Bad Request');
      return;
    }

    if (pathname === '/dsh-https/ca.crt') {
      const caPem = state.caPem();
      if (!caPem) {
        send(res, 503, 'text/plain; charset=utf-8', '本地 CA 尚未就绪');
        return;
      }
      send(res, 200, 'application/x-x509-ca-cert', caPem, {
        'content-disposition': 'attachment; filename="dsh-local-ca.crt"',
        'x-content-type-options': 'nosniff',
      }, method === 'HEAD');
      return;
    }

    if (pathname === '/dsh-https' || pathname === '/dsh-https/') {
      let local = null;
      try {
        local = state.status().certs.local;
      } catch (error) {
        ctx.logger?.warn?.('[dsh-https] 读取本地 CA 状态失败', error);
      }
      send(res, 200, 'text/html; charset=utf-8', landingHtml(local), {
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      }, method === 'HEAD');
      return;
    }

    send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
  };

  return ['/dsh-https', '/dsh-https/', '/dsh-https/ca.crt'].map((path) =>
    ctx.effect(
      () => webServer.register({ kind: 'exact', path, handler }),
      `dsh-https: public ${path}`,
    ),
  );
}