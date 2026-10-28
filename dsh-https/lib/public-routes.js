const LANDING_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH HTTPS 接入</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
         background: #0f1720; color: #e8eef5; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 22px 64px; }
  h1 { font-size: 26px; margin: 0 0 8px; }
  h2 { font-size: 18px; margin: 32px 0 10px; }
  p, li { color: #b9c7d6; }
  code { background: #1b2936; padding: 2px 6px; border-radius: 5px; font-size: 13px; color: #c7f0ea; }
  .badge { display: inline-block; padding: 3px 9px; border-radius: 999px; background: #123a37; color: #7de2d1;
           font-size: 12px; letter-spacing: .04em; margin-bottom: 18px; }
  a.button { display: inline-block; margin-top: 8px; padding: 10px 18px; border-radius: 9px;
             background: #19b5a5; color: #06211f; font-weight: 650; text-decoration: none; }
  .note { border-left: 3px solid #d9a441; padding: 10px 14px; background: #211d12; color: #e7d7ac; border-radius: 0 8px 8px 0; }
  ol { padding-left: 22px; }
</style>
</head>
<body>
<main>
  <div class="badge">DSH · HTTPS</div>
  <h1>为 DSH Web 启用 HTTPS</h1>
  <p>这个页面由 <code>dsh-https</code> 插件提供，用于安装本机 CA 证书。安装后，局域网 IP 与 <code>localhost</code> 的 HTTPS 访问不会再出现证书警告。</p>
  <h2>1. 下载 CA 证书</h2>
  <p><a class="button" href="/dsh-https/ca.crt" download>下载 dsh-local-ca.crt</a></p>
  <h2>2. 安装到系统或浏览器</h2>
  <ol>
    <li><b>macOS</b>：双击证书加入“钥匙串访问”，在“系统”钥匙串中找到它并设为“始终信任”。</li>
    <li><b>Windows</b>：双击证书 → 安装证书 → 本地计算机 → 受信任的根证书颁发机构。</li>
    <li><b>iOS / iPadOS</b>：Safari 下载后到“设置 → 通用 → VPN 与设备管理”安装描述文件，再到“关于本机 → 证书信任设置”开启完全信任。</li>
    <li><b>Android</b>：设置 → 安全 → 加密与凭据 → 安装 CA 证书。</li>
    <li><b>Firefox</b>：设置 → 隐私与安全 → 证书 → 查看证书 → 证书颁发机构 → 导入。</li>
  </ol>
  <h2>3. 用 HTTPS 打开 DSH</h2>
  <p>把地址改成 <code>https://&lt;主机&gt;:3088/</code> 即可。公网域名使用 Let's Encrypt 证书，无需安装本机 CA。</p>
  <p class="note">只应在你信任的设备上安装此 CA。CA 私钥保存在 DSH 数据目录，权限为 <code>0600</code>。</p>
</main>
</body>
</html>`;

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
      send(res, 200, 'text/html; charset=utf-8', LANDING_HTML, {
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
