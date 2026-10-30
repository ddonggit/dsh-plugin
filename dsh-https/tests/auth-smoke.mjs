// End-to-end check through the real TLS listener: the login gate must refuse
// every anonymous path (including plugin routes and WebSocket upgrades), let a
// logged-in browser through, and perform the DSH core token exchange itself.
//
// The upstream here is a stand-in for the DSH core: it answers the launch-token
// request with a `dsh-auth-…` cookie exactly like @deepseek-ai/dsh-client-connection
// does, and echoes everything else so we can see what actually got through.

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { normalizeConfig } from '../lib/config.js';
import { CertStore } from '../lib/certs.js';
import { HttpsProxyServer } from '../lib/https-server.js';
import { AuthStore } from '../lib/auth/store.js';
import { SESSION_COOKIE } from '../lib/auth/core.js';
import { createAuthGate } from '../lib/auth/gate.js';

const LAUNCH_TOKEN = 'test-launch-token-value';
const PASSWORD = 'smoke-test-password';
const CORE_COOKIE_NAME = 'dsh-auth-smoke';

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://placeholder.local');
  if (url.pathname === '/' && url.searchParams.getAll('token').length === 1 && url.searchParams.get('token') === LAUNCH_TOKEN) {
    res.writeHead(303, {
      location: './',
      'set-cookie': [`${CORE_COOKIE_NAME}=core-${crypto.randomUUID()}; Path=/; HttpOnly; SameSite=Strict`],
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }
  if (url.pathname === '/sse' || url.pathname === '/plugins/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: one\n\n');
    setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 60);
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream-host': req.headers.host || '' });
    res.end(`${req.method} ${url.pathname}${url.search} ${Buffer.concat(chunks).length} cookie=${Boolean(req.headers.cookie)}`);
  });
});
upstream.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (data) => socket.write(data));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;

const dataDir = '/tmp/dsh-https-auth-smoke';
await rm(dataDir, { recursive: true, force: true });
const { config, errors } = normalizeConfig(
  {
    listen: { host: '127.0.0.1', port: 0 },
    upstream: { host: '127.0.0.1', port: upstreamPort },
    dataDir,
    localCa: { hosts: ['localhost'] },
    auth: { enabled: true, sessionMaxAgeDays: 7, rateLimitPerMinute: 5 },
  },
  { homePath: '/tmp/x', upstreamPort },
);
if (errors.length) throw new Error(errors.join('; '));

const logger = { info() {}, warn() {}, error() {} };
const authStore = new AuthStore({ dir: path.join(config.dataDir, 'auth'), logger });
await authStore.setPassword(PASSWORD);
const certStore = new CertStore({ config, logger });
await certStore.init();
const connection = { authenticatedUrl: (base) => `${base}/?token=${LAUNCH_TOKEN}` };
const gate = createAuthGate({ config, store: authStore, logger, connection });
await gate.prime();

async function startServer() {
  const server = new HttpsProxyServer({ config, certStore, logger, auth: gate });
  await server.start();
  return server;
}
let server = await startServer();
const port = server.port;
// Pin the ephemeral port so the restart below rebinds the very same address.
config.listen.port = port;

const request = (target, options = {}) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, path: target, rejectUnauthorized: false, servername: 'localhost', ...options },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });

const upgrade = (target, cookie) =>
  new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false }, () => {
      const lines = [
        `GET ${target} HTTP/1.1`,
        `Host: localhost:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
      ];
      if (cookie) lines.push(`Cookie: ${cookie}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`upgrade timeout for ${target}`)); }, 5000);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!upgraded) {
        const index = buffer.indexOf('\r\n\r\n');
        if (index < 0) return;
        const head = buffer.subarray(0, index).toString();
        if (!head.includes('101 Switching Protocols')) {
          clearTimeout(timer);
          socket.end();
          resolve({ status: Number(head.split(' ')[1]), head });
          return;
        }
        upgraded = true;
        socket.write('ping');
        buffer = buffer.subarray(index + 4);
        return;
      }
      if (buffer.includes('ping')) {
        clearTimeout(timer);
        socket.end();
        resolve({ status: 101, echo: true });
      }
    });
    socket.on('error', reject);
  });

function sessionCookieFrom(response) {
  const list = response.headers['set-cookie'] || [];
  for (const cookie of list) {
    if (String(cookie).startsWith(`${SESSION_COOKIE}=`)) return String(cookie).split(';')[0];
  }
  return '';
}
function coreCookieFrom(response) {
  const list = response.headers['set-cookie'] || [];
  for (const cookie of list) {
    if (String(cookie).startsWith(`${CORE_COOKIE_NAME}=`)) return String(cookie).split(';')[0];
  }
  return '';
}

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`);
}

// 1. Anonymous traffic is refused on every surface the core does not guard.
for (const target of ['/', '/index.html', '/assets/app.js', '/plugins/events', '/plugins/anything', '/__bili/', '/__bili/plugin/status', '/bili/origin', '/api/session', '/unknown']) {
  const res = await request(target, { headers: { host: `localhost:${port}` } });
  check(`anonymous ${target} → 302 login`, res.status === 302, `got ${res.status}`);
  check(`anonymous ${target} → login page`, /^\/dsh-https\/auth\/login\?next=/.test(String(res.headers.location || '')), String(res.headers.location));
}
const anonymousPost = await request('/api/session', {
  method: 'POST',
  headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
  body: JSON.stringify({}),
});
check('anonymous POST /api/session → 401 JSON', anonymousPost.status === 401 && /authentication required/.test(anonymousPost.body), `got ${anonymousPost.status}`);

const anonymousWs = await upgrade('/api/remote.mux');
check('anonymous WebSocket upgrade → 401', anonymousWs.status === 401, `got ${anonymousWs.status}`);

// An anonymous launch-token URL must NOT slip through: the gate mints the core
// cookie itself, so a bare token URL is just an anonymous request.
const anonymousToken = await request(`/?token=${LAUNCH_TOKEN}`, { headers: { host: `localhost:${port}` } });
check('anonymous launch-token URL → 302 login', anonymousToken.status === 302, `got ${anonymousToken.status}`);
check(
  'anonymous launch-token URL never leaks the token to the login page',
  !String(anonymousToken.headers.location || '').includes(LAUNCH_TOKEN),
  String(anonymousToken.headers.location),
);

// 2. The gate's own pages and deliberately public paths.
const loginPage = await request('/dsh-https/auth/login', { headers: { host: `localhost:${port}` } });
check('login page renders', loginPage.status === 200 && loginPage.body.includes('访问密码'), `got ${loginPage.status}`);
check('login page CSP', /default-src 'none'/.test(String(loginPage.headers['content-security-policy'] || '')));
check('public path /dsh-https/ca.crt is proxied, not gated', (await request('/dsh-https/ca.crt', { headers: { host: `localhost:${port}` } })).status === 200);

// 3. Login: wrong password refused, right password mints both cookies.
const wrong = await request('/dsh-https/auth/login', {
  method: 'POST',
  headers: { host: `localhost:${port}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: 'definitely-wrong', next: '/' }).toString(),
});
check('wrong password → 401', wrong.status === 401, `got ${wrong.status}`);
check('wrong password sets no cookie', !sessionCookieFrom(wrong));

const login = await request('/dsh-https/auth/login', {
  method: 'POST',
  headers: { host: `localhost:${port}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: PASSWORD, next: '/dashboard' }).toString(),
});
check('login → 303 to next', login.status === 303 && login.headers.location === '/dashboard', `got ${login.status} ${login.headers.location}`);
const sessionCookie = sessionCookieFrom(login);
check('login sets the session cookie', Boolean(sessionCookie));
check('login mints the core cookie', Boolean(coreCookieFrom(login)), JSON.stringify(login.headers['set-cookie']));
check('session cookie is hardened', /HttpOnly/.test(JSON.stringify(login.headers['set-cookie'])) && /Secure/.test(JSON.stringify(login.headers['set-cookie'])));

const cookieHeader = `${sessionCookie}; ${coreCookieFrom(login)}`;
const authed = await request('/__bili/plugin/status', { headers: { host: `localhost:${port}`, cookie: cookieHeader } });
check('authenticated plugin route is proxied', authed.status === 200 && authed.body.includes('GET /__bili/plugin/status'), authed.body);
check('Host is preserved upstream', authed.headers['x-upstream-host'] === `localhost:${port}`, String(authed.headers['x-upstream-host']));

const authedWs = await upgrade('/api/remote.mux', cookieHeader);
check('authenticated WebSocket upgrade → 101', authedWs.status === 101 && authedWs.echo === true, `got ${authedWs.status}`);

const sse = await request('/plugins/events', { headers: { host: `localhost:${port}`, cookie: cookieHeader } });
check('authenticated SSE passes through', sse.status === 200 && /data: two/.test(sse.body), sse.body.slice(0, 40));

// 4. Session persists across a server restart (cookie is signed, not in memory).
await server.stop();
server = await startServer();
const afterRestart = await request('/', { headers: { host: `localhost:${port}`, cookie: cookieHeader } });
check('session survives a listener restart', afterRestart.status === 200, `got ${afterRestart.status}`);

// 5. Logout invalidates the session cookie.
const logout = await request('/dsh-https/auth/logout', { headers: { host: `localhost:${port}`, cookie: cookieHeader } });
check('logout clears the session', logout.status === 303 && String(logout.headers['set-cookie']).includes(`${SESSION_COOKIE}=;`));
const afterLogout = await request('/', { headers: { host: `localhost:${port}` } });
check('after logout → login redirect', afterLogout.status === 302, `got ${afterLogout.status}`);

// 6. Password change invalidates existing sessions.
const secondLogin = await request('/dsh-https/auth/login', {
  method: 'POST',
  headers: { host: `localhost:${port}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: PASSWORD, next: '/' }).toString(),
});
const secondCookie = sessionCookieFrom(secondLogin);
const changed = await gate.changePassword({ currentPassword: PASSWORD, newPassword: 'second-smoke-password' });
check('password change accepted', changed.changed === true);
const stale = await request('/', { headers: { host: `localhost:${port}`, cookie: secondCookie } });
check('password change invalidates old sessions', stale.status === 302, `got ${stale.status}`);

// 7. With auth disabled the listener is a plain proxy again.
const offConfig = normalizeConfig(
  {
    listen: { host: '127.0.0.1', port: 0 },
    upstream: { host: '127.0.0.1', port: upstreamPort },
    dataDir,
    localCa: { hosts: ['localhost'] },
    auth: { enabled: false },
  },
  { homePath: '/tmp/x', upstreamPort },
).config;
const offServer = new HttpsProxyServer({ config: offConfig, certStore, logger, auth: null });
await offServer.start();
const openRequest = await new Promise((resolve, reject) => {
  const req = https.request(
    { host: '127.0.0.1', port: offServer.port, path: '/', rejectUnauthorized: false, servername: 'localhost', headers: { host: `localhost:${offServer.port}` } },
    (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    },
  );
  req.on('error', reject);
  req.end();
});
check('auth disabled → anonymous request reaches upstream', openRequest.status === 200, `got ${openRequest.status}`);
await offServer.stop();

await server.stop();
upstream.close();
console.log(JSON.stringify({ ok: true, checks: checks.length, port, upstreamPort }));