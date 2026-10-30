// The login gate that sits in front of the reverse proxy. It owns a tiny route
// space (/dsh-https/auth/*), decides every other request, and — once a browser
// has our session — performs the DSH core token exchange server side so the
// user never has to keep the launch token in their address bar.
//
// Contract used by HttpsProxyServer:
//   handleRequest(req, res, proceed) -> boolean
//     true  : the gate owns the response (now or asynchronously)
//     false : caller must proxy the request upstream
//     The gate may call `proceed()` later (mint fallback) instead of looping.
//   handleUpgrade(req, socket, head, proceed) -> boolean

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import {
  AUTH_BASE,
  RateLimiter,
  SESSION_COOKIE,
  countCookiePrefix,
  newSessionId,
  normalizeClientIp,
  parseCookies,
  passwordProblem,
  sanitizeNext,
  sessionExpiry,
  signSession,
  verifyPassword,
  verifySession,
} from './core.js';
import { renderErrorPage, renderLoginPage, renderPasswordPage } from './pages.js';
import { sanitizeError } from '../util.js';

const FORM_LIMIT_BYTES = 4096;
const MINT_TIMEOUT_MS = 5000;
const AUTH_ALIASES = new Map([
  ['/dsh-https/login', `${AUTH_BASE}/login`],
  ['/dsh-https/logout', `${AUTH_BASE}/logout`],
  ['/dsh-https/password', `${AUTH_BASE}/password`],
]);
const DEFAULT_PUBLIC_PATHS = ['/dsh-https', '/dsh-https/', '/dsh-https/ca.crt'];

function securityHeaders(extra = {}) {
  return {
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...extra,
  };
}

function html(res, status, body, { head = false, ...extra } = {}) {
  if (res.writableEnded || res.destroyed) return;
  const payload = Buffer.from(body, 'utf8');
  res.writeHead(
    status,
    securityHeaders({ 'content-type': 'text/html; charset=utf-8', 'content-length': payload.length, ...extra }),
  );
  res.end(head ? undefined : payload);
}

function json(res, status, body, extra = {}) {
  if (res.writableEnded || res.destroyed) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(
    status,
    securityHeaders({ 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, ...extra }),
  );
  res.end(payload);
}

function redirect(res, status, location, extra = {}) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, securityHeaders({ location, ...extra }));
  res.end();
}

function hardenCookies(cookies) {
  return (Array.isArray(cookies) ? cookies : [cookies]).filter(Boolean).map((cookie) => {
    if (/;\s*secure\b/i.test(cookie)) return cookie;
    return `${cookie}; Secure`;
  });
}

function sessionCookie(value, expiresAt, { clear = false } = {}) {
  if (clear) {
    return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Secure`;
  }
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Lax; Secure`;
}

function buildPublicMatcher(extraPaths) {
  const exact = new Set(DEFAULT_PUBLIC_PATHS);
  const prefixes = [];
  for (const entry of Array.isArray(extraPaths) ? extraPaths : []) {
    if (typeof entry !== 'string') continue;
    const value = entry.trim();
    if (!value) continue;
    if (value.endsWith('*')) prefixes.push(value.slice(0, -1));
    else exact.add(value);
  }
  return (pathname) => {
    if (exact.has(pathname)) return true;
    return prefixes.some((prefix) => pathname.startsWith(prefix));
  };
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > FORM_LIMIT_BYTES) throw new Error('form too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function createAuthGate({ config, store, logger = console, connection = null }) {
  const cfg = config.auth;
  const limiter = new RateLimiter({ limit: cfg.rateLimitPerMinute });
  const isPublicPath = buildPublicMatcher(cfg.publicPaths);
  let configured = false;

  const mintAvailable = () => Boolean(connection) && typeof connection.authenticatedUrl === 'function';
  const upstreamScheme = () => (config.upstream.protocol === 'https' ? 'https:' : 'http:');

  function requestUrl(req) {
    try {
      return new URL(req.url || '/', 'http://placeholder.local');
    } catch {
      return null;
    }
  }

  function isAuthPath(pathname) {
    return (
      pathname === AUTH_BASE ||
      pathname.startsWith(`${AUTH_BASE}/`) ||
      pathname === '/dsh-https/login' ||
      pathname === '/dsh-https/logout' ||
      pathname === '/dsh-https/password'
    );
  }

  function currentSession(req) {
    const secret = store.cachedSecret();
    if (!secret) return null;
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (!token) return null;
    return verifySession(token, secret);
  }

  function hasDshCookie(req) {
    return countCookiePrefix(parseCookies(req.headers.cookie), 'dsh-auth-') > 0;
  }

  function clientIp(req) {
    return normalizeClientIp(req.socket?.remoteAddress);
  }

  function localTarget(url) {
    return `${url.pathname}${url.search}`;
  }

  function launchUrl(req) {
    if (!mintAvailable()) return null;
    try {
      const base = `${upstreamScheme()}//${req.headers.host || `127.0.0.1:${config.upstream.port}`}`;
      const value = connection.authenticatedUrl(base);
      if (typeof value !== 'string' || !value) return null;
      const parsed = new URL(value, base);
      if (parsed.searchParams.getAll('token').length === 0) return null;
      return parsed.toString();
    } catch {
      return null;
    }
  }

  /**
   * Ask the DSH core to mint its own browser-session cookie. The upstream is
   * plain HTTP (that is the whole point of this topology), so this is a normal
   * loopback request: /?token=<launch token> with the public Host header, so
   * the cookie the core issues is bound to the public authority.
   */
  function mintDshCookies(req) {
    return new Promise((resolve) => {
      if (!cfg.mintDshCookie || !mintAvailable()) {
        resolve([]);
        return;
      }
      const target = launchUrl(req);
      if (!target) {
        resolve([]);
        return;
      }
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        resolve([]);
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const transport = config.upstream.protocol === 'https' ? https : http;
      let upstreamReq;
      try {
        upstreamReq = transport.request({
          protocol: upstreamScheme(),
          host: config.upstream.host,
          port: config.upstream.port,
          method: 'GET',
          path: `${parsed.pathname}${parsed.search}`,
          headers: {
            host: parsed.host,
            accept: 'text/plain',
            connection: 'close',
          },
        });
      } catch (error) {
        logger.warn?.(`[dsh-https] 换取核心会话失败：${sanitizeError(error)}`);
        finish([]);
        return;
      }
      upstreamReq.setTimeout(MINT_TIMEOUT_MS, () => upstreamReq.destroy(new Error('mint timeout')));
      upstreamReq.on('response', (upstreamRes) => {
        const header = upstreamRes.headers['set-cookie'];
        upstreamRes.resume();
        const cookies = (Array.isArray(header) ? header : header ? [header] : []).filter((cookie) =>
          /^dsh-auth-/i.test(cookie),
        );
        finish(cookies);
      });
      upstreamReq.on('error', (error) => {
        logger.warn?.(`[dsh-https] 换取核心会话失败：${sanitizeError(error)}`);
        finish([]);
      });
      upstreamReq.end();
    });
  }

  /**
   * Authenticated browser without the core cookie yet: mint it and bounce once
   * to the same URL (clean address bar). If minting is unavailable, hand the
   * request to the core instead of redirecting forever.
   */
  async function finishCoreSession(req, res, url, proceed) {
    const cookies = hardenCookies(await mintDshCookies(req));
    if (cookies.length > 0) {
      redirect(res, 303, localTarget(url), { 'set-cookie': cookies });
      return;
    }
    const fallback = launchUrl(req);
    if (fallback) {
      logger.info?.('[dsh-https] 无法在服务端换取核心会话，改用核心令牌跳转');
      redirect(res, 302, fallback);
      return;
    }
    if (typeof proceed === 'function') proceed();
    else json(res, 502, { ok: false, error: 'could not establish the DSH session' });
  }

  function redirectToLogin(req, res, url) {
    const next = sanitizeNext(localTarget(url), '/');
    redirect(res, 302, `${AUTH_BASE}/login?next=${encodeURIComponent(next)}`);
  }

  async function handleLoginGet(req, res, url) {
    const hash = await store.readPasswordHash();
    configured = Boolean(hash);
    const next = sanitizeNext(url.searchParams.get('next'), '/');
    if (hash && currentSession(req)) {
      redirect(res, 303, next);
      return;
    }
    if (!hash) await store.ensureSetupToken();
    const notice = url.searchParams.has('changed')
      ? '密码已更新，请用新密码登录。'
      : url.searchParams.has('loggedout')
        ? '已退出登录。'
        : null;
    html(res, 200, renderLoginPage({ next, setup: !hash, notice, error: null }), { head: req.method === 'HEAD' });
  }

  async function handleLoginPost(req, res, url) {
    let params;
    try {
      params = await readForm(req);
    } catch {
      const page = renderErrorPage({ status: 413, title: '请求过大', messageText: '表单内容超过 4KB' });
      html(res, page.status, page.html);
      return;
    }
    const next = sanitizeNext(params.get('next'), '/');
    const ip = clientIp(req);
    let hash = await store.readPasswordHash();
    configured = Boolean(hash);

    const throttle = limiter.check(ip);
    if (!throttle.allowed) {
      await store.appendAudit('login-throttled', { ip });
      html(
        res,
        429,
        renderLoginPage({ next, setup: !hash, error: `尝试过于频繁，请 ${throttle.retryAfterSec} 秒后再试` }),
        { 'retry-after': String(throttle.retryAfterSec) },
      );
      return;
    }

    const password = params.get('password') || '';
    let ok = false;
    let reason = '';
    if (hash) {
      ok = await verifyPassword(password, hash);
      reason = '密码不正确';
    } else {
      const problem = passwordProblem(password, params.get('confirm'));
      if (problem) {
        reason = problem;
      } else if (!(await store.consumeSetupToken(params.get('setupToken') || ''))) {
        reason = '一次性口令不正确（请在服务器上查看 setup-token 文件）';
      } else {
        await store.setPassword(password);
        hash = await store.readPasswordHash();
        configured = true;
        ok = true;
        await store.appendAudit('password-created', { ip });
      }
    }

    if (!ok) {
      const state = limiter.fail(ip);
      await store.appendAudit(hash ? 'login-failed' : 'setup-failed', { ip, detail: reason });
      const suffix = state.retryAfterSec > 0 ? `（${state.retryAfterSec} 秒后可重试）` : '';
      html(res, 401, renderLoginPage({ next, setup: !hash, error: `${reason}${suffix}` }));
      return;
    }

    limiter.succeed(ip);
    await store.appendAudit('login-ok', { ip });
    const secret = store.cachedSecret();
    const expiresAt = sessionExpiry(cfg.sessionMaxAgeDays);
    const token = signSession({ sid: newSessionId(), exp: expiresAt }, secret);
    const cookies = [sessionCookie(token, expiresAt)];
    if (cfg.mintDshCookie) cookies.push(...hardenCookies(await mintDshCookies(req)));
    redirect(res, 303, next, { 'set-cookie': cookies });
  }

  function handleLogout(req, res) {
    const cookies = [sessionCookie('', 0, { clear: true })];
    // Also expire whatever DSH core session cookies this browser holds, so a
    // later "auth disabled" state does not silently let the browser back in.
    for (const name of parseCookies(req.headers.cookie).keys()) {
      if (name.startsWith('dsh-auth-')) {
        cookies.push(`${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure`);
      }
    }
    redirect(res, 303, `${AUTH_BASE}/login?loggedout=1`, { 'set-cookie': cookies });
  }

  async function handlePasswordGet(req, res, url) {
    const next = sanitizeNext(url.searchParams.get('next'), '/');
    if (!currentSession(req)) {
      redirect(res, 302, `${AUTH_BASE}/login?next=${encodeURIComponent(`${AUTH_BASE}/password`)}`);
      return;
    }
    html(res, 200, renderPasswordPage({ next }), { head: req.method === 'HEAD' });
  }

  async function handlePasswordPost(req, res, url) {
    const ip = clientIp(req);
    if (!currentSession(req)) {
      json(res, 401, { ok: false, error: 'authentication required', login: `${AUTH_BASE}/login` });
      return;
    }
    let params;
    try {
      params = await readForm(req);
    } catch {
      html(res, 413, renderPasswordPage({ error: '表单内容超过 4KB' }));
      return;
    }
    const hash = await store.readPasswordHash();
    if (!hash || !(await verifyPassword(params.get('currentPassword') || '', hash))) {
      const state = limiter.fail(ip);
      await store.appendAudit('password-change-failed', { ip });
      const suffix = state.retryAfterSec > 0 ? `（${state.retryAfterSec} 秒后可重试）` : '';
      html(res, 401, renderPasswordPage({ error: `当前密码不正确${suffix}` }));
      return;
    }
    const problem = passwordProblem(params.get('newPassword') || '', params.get('confirm'));
    if (problem) {
      html(res, 400, renderPasswordPage({ error: problem }));
      return;
    }
    limiter.succeed(ip);
    await store.setPassword(params.get('newPassword') || '');
    configured = true;
    await store.appendAudit('password-changed', { ip });
    redirect(res, 303, `${AUTH_BASE}/login?changed=1`, { 'set-cookie': [sessionCookie('', 0, { clear: true })] });
  }

  async function runAuthRoute(req, res, url) {
    const method = (req.method || 'GET').toUpperCase();
    const alias = AUTH_ALIASES.get(url.pathname);
    if (alias && alias !== url.pathname) {
      redirect(res, 302, `${alias}${url.search}`);
      return;
    }
    if (url.pathname === `${AUTH_BASE}/login`) {
      if (method === 'POST') return handleLoginPost(req, res, url);
      if (method === 'GET' || method === 'HEAD') return handleLoginGet(req, res, url);
      return json(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET, HEAD, POST' });
    }
    if (url.pathname === `${AUTH_BASE}/logout`) {
      if (method !== 'GET' && method !== 'POST') {
        return json(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET, POST' });
      }
      return handleLogout(req, res);
    }
    if (url.pathname === `${AUTH_BASE}/password`) {
      if (method === 'POST') return handlePasswordPost(req, res, url);
      if (method === 'GET' || method === 'HEAD') return handlePasswordGet(req, res, url);
      return json(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET, HEAD, POST' });
    }
    if (url.pathname === `${AUTH_BASE}/status`) {
      if (method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET' });
      if (!currentSession(req)) return json(res, 401, { ok: false, error: 'authentication required' });
      return json(res, 200, { ok: true, auth: status() });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  }

  async function prime() {
    await store.prime();
    configured = await store.hasPassword();
    return { configured };
  }

  function status() {
    return {
      enabled: cfg.enabled,
      configured,
      sessionMaxAgeDays: cfg.sessionMaxAgeDays,
      rateLimitPerMinute: cfg.rateLimitPerMinute,
      mintDshCookie: cfg.mintDshCookie,
      mintAvailable: mintAvailable(),
      publicPaths: [...DEFAULT_PUBLIC_PATHS, ...cfg.publicPaths],
      loginPath: `${AUTH_BASE}/login`,
    };
  }

  return {
    enabled: cfg.enabled,
    prime,
    status,

    handleRequest(req, res, proceed) {
      if (!cfg.enabled) return false;
      const url = requestUrl(req);
      if (!url) return false;
      if (isAuthPath(url.pathname)) {
        void runAuthRoute(req, res, url).catch((error) => {
          logger.error?.(`[dsh-https] 登录鉴权处理失败：${sanitizeError(error)}`);
          if (!res.headersSent) {
            const page = renderErrorPage({ status: 500, title: '服务器错误', messageText: '处理登录请求时出错' });
            html(res, page.status, page.html);
          } else if (!res.writableEnded) {
            res.end();
          }
        });
        return true;
      }
      if (isPublicPath(url.pathname)) return false;

      const session = currentSession(req);
      if (session) {
        // The core's own launch-token exchange must reach the core untouched.
        if (url.searchParams.has('token')) return false;
        if (hasDshCookie(req) || !cfg.mintDshCookie || !mintAvailable()) return false;
        void finishCoreSession(req, res, url, proceed).catch((error) => {
          logger.warn?.(`[dsh-https] 核心会话换取流程失败：${sanitizeError(error)}`);
          if (!res.headersSent) redirect(res, 302, localTarget(url));
          else if (!res.writableEnded) res.end();
        });
        return true;
      }

      // No session: a bare token URL is only usable when we cannot mint it for
      // the browser ourselves; otherwise the user logs in first and we mint.
      if (url.searchParams.has('token') && !mintAvailable()) return false;
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        redirectToLogin(req, res, url);
        return true;
      }
      json(res, 401, { ok: false, error: 'authentication required', login: `${AUTH_BASE}/login` });
      return true;
    },

    handleUpgrade(req, socket, head, proceed) {
      if (!cfg.enabled) return false;
      const url = requestUrl(req);
      if (!url) return false;
      if (isAuthPath(url.pathname) || isPublicPath(url.pathname)) return false;
      const session = currentSession(req);
      if (session && (hasDshCookie(req) || !cfg.mintDshCookie || !mintAvailable())) return false;
      try {
        socket.end(
          'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 12\r\nCache-Control: no-store\r\n\r\nunauthorized',
        );
      } catch {
        // Socket already gone.
      }
      void store.appendAudit('upgrade-denied', { ip: normalizeClientIp(req.socket?.remoteAddress), detail: url.pathname });
      return true;
    },

    /** Used by the settings API (JSON, current password required). */
    async changePassword({ currentPassword, newPassword, confirmPassword } = {}) {
      if (!cfg.enabled) throw new Error('登录鉴权未启用');
      const hash = await store.readPasswordHash();
      if (!hash) throw new Error('尚未设置访问密码，请先在登录页完成首次设置');
      if (!(await verifyPassword(String(currentPassword ?? ''), hash))) throw new Error('当前密码不正确');
      const problem = passwordProblem(String(newPassword ?? ''), confirmPassword === undefined ? undefined : String(confirmPassword));
      if (problem) throw new Error(problem);
      await store.setPassword(String(newPassword));
      configured = true;
      await store.appendAudit('password-changed', { ip: 'settings-api' });
      return { changed: true, relogin: true };
    },
  };
}