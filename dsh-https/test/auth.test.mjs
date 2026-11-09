import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { access, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import {
  AUTH_BASE,
  MIN_PASSWORD_LENGTH,
  RateLimiter,
  SESSION_COOKIE,
  b64url,
  hashPassword,
  normalizeClientIp,
  parseCookies,
  passwordProblem,
  pseudonymizeIp,
  sanitizeNext,
  signSession,
  verifyPassword,
  verifySession,
} from '../lib/auth/core.js';
import { AuthStore } from '../lib/auth/store.js';
import { browserBaseFromHost, createAuthGate } from '../lib/auth/gate.js';
import { normalizeConfig } from '../lib/config.js';

const scrypt = promisify(scryptCb);
const tmpRoot = path.join(os.tmpdir(), `dsh-https-auth-test-${process.pid}`);

function tempDir(name) {
  return path.join(tmpRoot, name);
}

test.after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- primitives

test('hashPassword/verifyPassword: correct, wrong and malformed', async () => {
  const hash = await hashPassword('correct horse');
  assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(await verifyPassword('correct horse', hash), true);
  assert.equal(await verifyPassword('correct hors', hash), false);
  assert.equal(await verifyPassword('', hash), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'scrypt$bogus'), false);
  assert.equal(await verifyPassword('x', 'scrypt$1$1$1$aa$bb'), false);
  assert.equal(await verifyPassword('x', 'scrypt$1048576$8$1$aa$bb'), false);
  assert.equal(await verifyPassword('x', `scrypt$16384$64$1$${b64url(randomBytes(16))}$${b64url(randomBytes(32))}`), false);
  // A hash written by @fonlan/dsh-web-auth uses the same format.
  const salt = randomBytes(16);
  const key = await scrypt('interop-password', salt, 32, { N: 16384, r: 8, p: 1 });
  const foreign = `scrypt$16384$8$1$${b64url(salt)}$${b64url(key)}`;
  assert.equal(await verifyPassword('interop-password', foreign), true);
});

test('sessions: signed, tamper-proof and expiring', () => {
  const secret = b64url(randomBytes(32));
  const token = signSession({ sid: 'abc', exp: Date.now() + 60_000 }, secret);
  const payload = verifySession(token, secret);
  assert.equal(payload.sid, 'abc');
  assert.equal(verifySession(token, b64url(randomBytes(32))), null);
  assert.equal(verifySession(`${token}x`, secret), null);
  assert.equal(verifySession(token.split('.')[0], secret), null);
  assert.equal(verifySession('garbage', secret), null);
  assert.equal(verifySession(token, ''), null);
  assert.equal(verifySession(signSession({ sid: 'abc', exp: Date.now() - 1 }, secret), secret), null);
  const future = verifySession(signSession({ sid: 'abc', exp: Date.now() + 60_000, iat: Date.now() }, secret), secret);
  assert.ok(future.exp > Date.now());
});

test('sanitizeNext keeps same-origin paths only and drops tokens', () => {
  assert.equal(sanitizeNext('/a/b?x=1#f'), '/a/b?x=1#f');
  assert.equal(sanitizeNext('/a?token=SECRET'), '/a');
  assert.equal(sanitizeNext(`/a?${'tok' + 'en'}=abc&other=1`), '/a?other=1');
  assert.equal(sanitizeNext(`/a?${'tok' + 'en'}=abc`), '/a');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil', '/a\\b', 'a/b', '', 'javascript:alert(1)']) {
    assert.equal(sanitizeNext(bad), '/', `expected fallback for ${bad}`);
  }
  // Normalisation used to turn these into a protocol-relative `//evil.example`.
  for (const crafted of ['/a/..//evil.example', '/a/../..//evil.example', '/%2e%2e//evil.example', '/a/..//evil.example?x=1']) {
    assert.equal(sanitizeNext(crafted), '/', `expected fallback for ${crafted}`);
  }
  assert.equal(sanitizeNext('/a/../b'), '/b');
  assert.equal(sanitizeNext('/\u0000x'), '/');
  assert.equal(sanitizeNext(`/${'a'.repeat(600)}`), '/');
  assert.equal(sanitizeNext(null, '/dashboard'), '/dashboard');
});

test('passwordProblem enforces length and confirmation', () => {
  assert.ok(passwordProblem('short'));
  assert.ok(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH), 'different'));
  assert.equal(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH), 'a'.repeat(MIN_PASSWORD_LENGTH)), null);
  assert.ok(passwordProblem('a'.repeat(300)));
});

test('parseCookies takes the first value and strips quotes', () => {
  const cookies = parseCookies('a=1; b="two"; a=2; bad; c=');
  assert.equal(cookies.get('a'), '1');
  assert.equal(cookies.get('b'), 'two');
  assert.equal(cookies.get('c'), '');
  assert.equal(cookies.has('bad'), false);
});

test('RateLimiter blocks after the limit and backs off', () => {
  const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });
  const key = '203.0.113.7';
  assert.equal(limiter.check(key).allowed, true);
  limiter.fail(key);
  limiter.fail(key);
  assert.equal(limiter.check(key).allowed, true);
  limiter.fail(key);
  const blocked = limiter.check(key);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  const later = limiter.check(key, Date.now() + 10 * 60_000);
  assert.equal(later.allowed, true);
  limiter.succeed(key);
  assert.equal(limiter.size, 0);
});

test('client addresses are normalised and only ever logged pseudonymised', () => {
  assert.equal(normalizeClientIp('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(normalizeClientIp('::1'), '127.0.0.1');
  assert.equal(normalizeClientIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeClientIp(undefined), 'unknown');
  const pseudonym = pseudonymizeIp('203.0.113.9', 'k'.repeat(43));
  assert.notEqual(pseudonym, '203.0.113.9');
  assert.equal(pseudonym, pseudonymizeIp('203.0.113.9', 'k'.repeat(43)));
  assert.equal(pseudonym.length, 16);
});

// -------------------------------------------------------------------- config

test('auth config defaults to disabled and normalises explicit values', () => {
  const off = normalizeConfig({}, { homePath: '/tmp/x', upstreamPort: 3081 }).config;
  assert.equal(off.auth.enabled, false);
  assert.equal(off.auth.sessionMaxAgeDays, 30);
  assert.equal(off.auth.rateLimitPerMinute, 5);
  assert.equal(off.auth.mintDshCookie, true);
  assert.deepEqual(off.auth.publicPaths, []);

  const on = normalizeConfig(
    { auth: { enabled: true, sessionMaxAgeDays: 7, rateLimitPerMinute: 10, mintDshCookie: false, publicPaths: ['/about', 'nope'] } },
    { homePath: '/tmp/x', upstreamPort: 3081 },
  );
  assert.deepEqual(on.errors, []);
  assert.equal(on.config.auth.enabled, true);
  assert.equal(on.config.auth.sessionMaxAgeDays, 7);
  assert.equal(on.config.auth.rateLimitPerMinute, 10);
  assert.equal(on.config.auth.mintDshCookie, false);
  assert.deepEqual(on.config.auth.publicPaths, ['/about']);
  assert.ok(on.warnings.some((warning) => warning.includes('auth.publicPaths')));

  const bad = normalizeConfig({ auth: { sessionMaxAgeDays: 9999, rateLimitPerMinute: 0 } }, { homePath: '/tmp/x', upstreamPort: 3081 });
  assert.equal(bad.errors.length, 2);
});

// --------------------------------------------------------------------- store

test('AuthStore writes 0600 state, verifies logins and rotates sessions', async () => {
  const store = new AuthStore({ dir: tempDir('store'), logger: { warn() {} } });
  await store.init();
  assert.equal(await store.readPasswordHash(), null);
  assert.equal(await store.prime(), store.cachedSecret());
  const first = store.cachedSecret();

  await store.setPassword('a-long-enough-password');
  const hash = await store.readPasswordHash();
  assert.equal(await verifyPassword('a-long-enough-password', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.notEqual(store.cachedSecret(), first);

  const mode = (await stat(store.passwordFile)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal((await stat(store.secretFile)).mode & 0o777, 0o600);

  const token = await store.ensureSetupToken();
  assert.equal(await store.ensureSetupToken(), token);
  assert.equal((await stat(store.setupTokenFile)).mode & 0o777, 0o600);
  assert.equal(await store.consumeSetupToken('not-the-token'), false);
  assert.equal(await store.consumeSetupToken(token), true);
  assert.equal(await store.consumeSetupToken(token), false);
  // A consumed token is never recreated: the next first-run visit gets a new one.
  const nextToken = await store.ensureSetupToken();
  assert.ok(nextToken.length > 10);
  assert.notEqual(nextToken, token);
});

test('AuthStore picks up a secret rotated by the CLI (password reset / clear)', async () => {
  const dir = tempDir('store-cli');
  const plugin = new AuthStore({ dir, logger: { warn() {} } });
  await plugin.prime();
  await plugin.setPassword('first-long-password');
  const oldToken = signSession({ sid: 'sid-old', exp: Date.now() + 60_000 }, plugin.cachedSecret());

  // This is the provision-auth.mjs process: a second store on the same dir.
  const cli = new AuthStore({ dir, logger: { warn() {} } });
  await cli.prime();
  assert.equal(await plugin.refreshSecret(), false, 'nothing changed yet');
  await cli.setPassword('second-long-password');
  assert.equal(await plugin.refreshSecret(), true, 'the running plugin sees the new secret');
  assert.equal(verifySession(oldToken, plugin.cachedSecret()), null, 'the old session is revoked without a restart');

  // A rotation performed by --clear must survive a plugin restart too, which is
  // what the old `clearPassword()` (hash only) failed to do.
  const restart = new AuthStore({ dir, logger: { warn() {} } });
  await restart.prime();
  const liveToken = signSession({ sid: 'sid-live', exp: Date.now() + 60_000 }, restart.cachedSecret());
  assert.ok(verifySession(liveToken, restart.cachedSecret()));
  await cli.clearPassword();
  assert.equal(await restart.refreshSecret(), true, '--clear rotates the secret');
  assert.equal(await restart.readPasswordHash(), null);
  assert.equal(verifySession(liveToken, restart.cachedSecret()), null, 'sessions die even after a restart');
});

test('AuthStore audit log uses a stable pseudonym and never the raw address', async () => {
  const store = new AuthStore({ dir: tempDir('audit'), logger: { warn() {} } });
  await store.init();
  await store.appendAudit('login-failed', { ip: '198.51.100.4', detail: '密码不正确' });
  await store.appendAudit('login-ok', { ip: '198.51.100.4' });
  const text = await (await import('node:fs/promises')).readFile(store.auditFile, 'utf8');
  assert.equal(text.includes('198.51.100.4'), false);
  const lines = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'login-failed');
  assert.equal(lines[0].ip, lines[1].ip);
  assert.equal((await stat(store.auditFile)).mode & 0o777, 0o600);
});

// ---------------------------------------------------------------------- gate

function makeRequest({ url = '/', method = 'GET', headers = {}, body = '', ip = '203.0.113.50' } = {}) {
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')]);
  stream.url = url;
  stream.method = method;
  stream.headers = headers;
  stream.socket = { remoteAddress: ip, encrypted: true };
  return stream;
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
      this.headersSent = true;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(payload) {
      this.writableEnded = true;
      if (payload !== undefined) this.body += Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitEnded(res, ms = 500) {
  const deadline = Date.now() + ms;
  while (!res.writableEnded && Date.now() < deadline) await sleep(5);
  if (!res.writableEnded) throw new Error('response never ended');
  return res;
}

function cookieValue(response, name = SESSION_COOKIE) {
  const list = response.headers['set-cookie'];
  const cookies = Array.isArray(list) ? list : list ? [list] : [];
  for (const cookie of cookies) {
    const text = String(cookie);
    if (text.startsWith(`${name}=`)) return text.split(';')[0].slice(name.length + 1);
  }
  return '';
}

async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function makeGate({ name, password = 'a-long-enough-password', auth = {}, connection = null }) {
  const upstreamPort = await closedPort();
  const { config, errors } = normalizeConfig(
    {
      listen: { host: '127.0.0.1', port: 0 },
      upstream: { host: '127.0.0.1', port: upstreamPort },
      dataDir: tempDir(name),
      publicCert: { mode: 'files', certFile: '/tmp/c.pem', keyFile: '/tmp/k.pem' },
      auth: { enabled: true, ...auth },
    },
    { homePath: '/tmp/x', upstreamPort },
  );
  assert.deepEqual(errors, []);
  const store = new AuthStore({ dir: path.join(config.dataDir, 'auth'), logger: { warn() {} } });
  await store.init();
  if (password) await store.setPassword(password);
  const gate = createAuthGate({ config, store, logger: { info() {}, warn() {}, error() {} }, connection });
  await gate.prime();
  return { gate, store, config };
}

test('gate: anonymous requests are refused, public paths and auth routes pass', async () => {
  const { gate } = await makeGate({ name: 'gate-anon' });

  const matrix = ['/', '/index.html', '/assets/app.js', '/api/session', '/plugins/events', '/__bili/', '/bili/origin', '/unknown'];
  for (const pathname of matrix) {
    const res = makeResponse();
    let proceeded = false;
    const handled = gate.handleRequest(makeRequest({ url: pathname }), res, () => { proceeded = true; });
    assert.equal(handled, true, `expected the gate to own ${pathname}`);
    await waitEnded(res);
    assert.equal(res.statusCode, 302, `expected a login redirect for ${pathname}`);
    assert.match(res.headers.location, /^\/dsh-https\/auth\/login\?next=/);
    assert.equal(proceeded, false);
  }

  const publicPaths = [AUTH_BASE + '/login', AUTH_BASE + '/status', '/dsh-https', '/dsh-https/', '/dsh-https/ca.crt'];
  for (const pathname of publicPaths) {
    const res = makeResponse();
    const handled = gate.handleRequest(makeRequest({ url: pathname }), res, () => {});
    if (pathname.startsWith(AUTH_BASE)) assert.equal(handled, true, `${pathname} is owned by the gate`);
    else assert.equal(handled, false, `${pathname} is deliberately public`);
  }

  const redirected = makeResponse();
  gate.handleRequest(makeRequest({ url: '/deep/path?keep=1' }), redirected, () => {});
  await waitEnded(redirected);
  assert.equal(redirected.headers.location, `${AUTH_BASE}/login?next=%2Fdeep%2Fpath%3Fkeep%3D1`);
  assert.equal(gate.handleRequest(makeRequest({ url: '/deep/path?token=SECRET' }), makeResponse(), () => {}), false);
});

test('gate: with a mint available the launch token is never kept in the URL', async () => {
  const connection = { authenticatedUrl: (base) => `${base}/?${'tok' + 'en'}=LAUNCH-VALUE` };
  const { gate } = await makeGate({ name: 'gate-mint', connection });

  // Anonymous token URL: log in first, the gate mints afterwards.
  const res = makeResponse();
  assert.equal(gate.handleRequest(makeRequest({ url: '/deep?token=LAUNCH-VALUE' }), res, () => {}), true);
  await waitEnded(res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, `${AUTH_BASE}/login?next=%2Fdeep`);
  assert.equal(res.headers.location.includes('LAUNCH-VALUE'), false);

  // Log in, then ask for a page without the core cookie: minting fails (the
  // upstream port is closed), so the gate falls back to the core launch URL
  // instead of redirecting in a loop.
  const login = makeResponse();
  gate.handleRequest(
    makeRequest({
      url: `${AUTH_BASE}/login`,
      method: 'POST',
      body: new URLSearchParams({ password: 'a-long-enough-password' }).toString(),
    }),
    login,
    () => {},
  );
  await waitEnded(login, 3000);
  assert.equal(login.statusCode, 303);
  const token = cookieValue(login);
  assert.ok(token.length > 20);

  const bounced = makeResponse();
  const handled = gate.handleRequest(
    makeRequest({ url: '/app', headers: { cookie: `${SESSION_COOKIE}=${token}`, host: 'api.example.test:3000' } }),
    bounced,
    () => {},
  );
  assert.equal(handled, true);
  await waitEnded(bounced, 3000);
  assert.equal(bounced.statusCode, 302);
  assert.match(bounced.headers.location, /^https:\/\/api\.example\.test:3000\/\?tok/);
  assert.match(bounced.headers.location, /LAUNCH-VALUE/);

  // The core's own token exchange always passes through untouched.
  const passthrough = makeResponse();
  assert.equal(
    gate.handleRequest(
      makeRequest({ url: '/?token=LAUNCH-VALUE', headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
      passthrough,
      () => {},
    ),
    false,
  );

  // A Host header that is not a bare authority never receives the launch token.
  const badHost = makeResponse();
  let badHostProceeded = false;
  assert.equal(
    gate.handleRequest(
      makeRequest({ url: '/app', headers: { cookie: `${SESSION_COOKIE}=${token}`, host: 'evil.example/path' } }),
      badHost,
      () => { badHostProceeded = true; },
    ),
    true,
  );
  const deadline = Date.now() + 3000;
  while (!badHostProceeded && Date.now() < deadline) await sleep(10);
  assert.equal(badHostProceeded, true, 'falls back to proxying instead of an invalid host');
  assert.equal(badHost.headers.location, undefined);
});

test('browser launch base is always https and only accepts a bare authority', () => {
  assert.equal(browserBaseFromHost('api.example.test:3000'), 'https://api.example.test:3000');
  assert.equal(browserBaseFromHost('[::1]:3000'), 'https://[::1]:3000');
  for (const bad of ['', '   ', 'evil.example/path', 'user@evil.example', 'http://evil.example', 'evil.example?x=1', 'a b']) {
    assert.equal(browserBaseFromHost(bad), null, `expected null for ${bad}`);
  }
});

test('gate: non-GET without a session gets JSON 401, WebSocket upgrades are refused', async () => {
  const { gate } = await makeGate({ name: 'gate-methods' });
  const res = makeResponse();
  gate.handleRequest(makeRequest({ url: '/api/session', method: 'POST', body: '{}' }), res, () => {});
  await waitEnded(res);
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.match(res.body, /authentication required/);

  const socket = { ended: '', end(value) { this.ended += value; }, destroy() {} };
  const handled = gate.handleUpgrade(makeRequest({ url: '/api/remote.mux', headers: { upgrade: 'websocket' } }), socket, null, () => {});
  assert.equal(handled, true);
  assert.match(socket.ended, /^HTTP\/1\.1 401 Unauthorized/);
});

test('gate: login flow, session cookie, logout and password change', async () => {
  const { gate, store } = await makeGate({ name: 'gate-login' });

  // Wrong password: 401 and nothing is set.
  const wrong = makeResponse();
  gate.handleRequest(
    makeRequest({
      url: `${AUTH_BASE}/login`,
      method: 'POST',
      body: new URLSearchParams({ password: 'nope', next: '/deep' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }),
    wrong,
    () => {},
  );
  await waitEnded(wrong);
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  assert.match(wrong.body, /密码不正确/);

  // Correct password: 303 to next with an HttpOnly session cookie.
  const ok = makeResponse();
  gate.handleRequest(
    makeRequest({
      url: `${AUTH_BASE}/login`,
      method: 'POST',
      body: new URLSearchParams({ password: 'a-long-enough-password', next: '/deep?x=1' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }),
    ok,
    () => {},
  );
  await waitEnded(ok);
  assert.equal(ok.statusCode, 303);
  assert.equal(ok.headers.location, '/deep?x=1');
  const token = cookieValue(ok);
  assert.ok(token.length > 20);
  const setCookie = ok.headers['set-cookie'].join(' ');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
  assert.equal(setCookie.includes('a-long-enough-password'), false);

  // With the session the same request is proxied upstream.
  const allowed = makeResponse();
  let proceeded = false;
  const handled = gate.handleRequest(
    makeRequest({ url: '/deep?x=1', headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
    allowed,
    () => { proceeded = true; },
  );
  assert.equal(handled, false);
  assert.equal(proceeded, false, 'the proxy continues on its own for false');

  // status endpoint reflects the configuration but never leaks secrets.
  const status = makeResponse();
  gate.handleRequest(makeRequest({ url: `${AUTH_BASE}/status`, headers: { cookie: `${SESSION_COOKIE}=${token}` } }), status, () => {});
  await waitEnded(status);
  assert.equal(status.statusCode, 200);
  const body = JSON.parse(status.body);
  assert.equal(body.auth.configured, true);
  assert.equal(body.auth.enabled, true);
  assert.equal(status.body.includes('a-long-enough-password'), false);
  assert.equal(status.body.includes(store.cachedSecret()), false);

  // Logout clears the cookie (and any core cookie the browser held).
  const logout = makeResponse();
  gate.handleRequest(
    makeRequest({ url: `${AUTH_BASE}/logout`, headers: { cookie: `${SESSION_COOKIE}=${token}; dsh-auth-abc=xyz` } }),
    logout,
    () => {},
  );
  await waitEnded(logout);
  assert.equal(logout.statusCode, 303);
  const cleared = logout.headers['set-cookie'].join(' ');
  assert.match(cleared, new RegExp(`${SESSION_COOKIE}=;`));
  assert.match(cleared, /dsh-auth-abc=;/);

  // Password change via the settings API rotates the secret and requires the old one.
  await assert.rejects(() => gate.changePassword({ currentPassword: 'wrong', newPassword: 'another-long-password' }), /当前密码不正确/);
  await assert.rejects(() => gate.changePassword({ currentPassword: 'a-long-enough-password', newPassword: 'short' }), /至少/);
  const previousSecret = store.cachedSecret();
  const changed = await gate.changePassword({ currentPassword: 'a-long-enough-password', newPassword: 'another-long-password' });
  assert.equal(changed.changed, true);
  assert.notEqual(store.cachedSecret(), previousSecret);
  assert.equal(await verifyPassword('another-long-password', await store.readPasswordHash()), true);
  // The old session is now invalid.
  const stale = makeResponse();
  const staleHandled = gate.handleRequest(
    makeRequest({ url: '/deep', headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
    stale,
    () => {},
  );
  assert.equal(staleHandled, true);
  await waitEnded(stale);
  assert.equal(stale.statusCode, 302);
});

test('gate: first-run setup needs the one-time token', async () => {
  const { gate, store } = await makeGate({ name: 'gate-setup', password: '' });
  assert.equal(gate.status().configured, false);

  const page = makeResponse();
  gate.handleRequest(makeRequest({ url: `${AUTH_BASE}/login` }), page, () => {});
  await waitEnded(page);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /一次性口令/);
  assert.equal(page.body.includes(await store.ensureSetupToken()), false, 'the token itself is never rendered');

  const setupToken = await store.ensureSetupToken();
  const bad = makeResponse();
  gate.handleRequest(
    makeRequest({
      url: `${AUTH_BASE}/login`,
      method: 'POST',
      body: new URLSearchParams({ setupToken: 'wrong', password: 'fresh-long-password', confirm: 'fresh-long-password' }).toString(),
    }),
    bad,
    () => {},
  );
  await waitEnded(bad);
  assert.equal(bad.statusCode, 401);
  assert.match(bad.body, /一次性口令不正确/);
  assert.equal(await store.hasPassword(), false);

  const mismatch = makeResponse();
  gate.handleRequest(
    makeRequest({
      url: `${AUTH_BASE}/login`,
      method: 'POST',
      body: new URLSearchParams({ setupToken, password: 'fresh-long-password', confirm: 'other-long-password' }).toString(),
    }),
    mismatch,
    () => {},
  );
  await waitEnded(mismatch);
  assert.equal(mismatch.statusCode, 401);

  const good = makeResponse();
  gate.handleRequest(
    makeRequest({
      url: `${AUTH_BASE}/login`,
      method: 'POST',
      body: new URLSearchParams({ setupToken, password: 'fresh-long-password', confirm: 'fresh-long-password' }).toString(),
    }),
    good,
    () => {},
  );
  await waitEnded(good);
  assert.equal(good.statusCode, 303);
  assert.equal(await verifyPassword('fresh-long-password', await store.readPasswordHash()), true);
  assert.equal(gate.status().configured, true);
  // The one-time token is consumed: the file is gone.
  await assert.rejects(() => access(store.setupTokenFile), (error) => error.code === 'ENOENT');
});

test('gate: throttles repeated failures', async () => {
  const { gate } = await makeGate({ name: 'gate-throttle', auth: { rateLimitPerMinute: 2 } });
  const attempt = async () => {
    const res = makeResponse();
    gate.handleRequest(
      makeRequest({
        url: `${AUTH_BASE}/login`,
        method: 'POST',
        body: new URLSearchParams({ password: 'wrong' }).toString(),
        ip: '198.51.100.9',
      }),
      res,
      () => {},
    );
    await waitEnded(res);
    return res;
  };
  assert.equal((await attempt()).statusCode, 401);
  assert.equal((await attempt()).statusCode, 401);
  const blocked = await attempt();
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['retry-after']) >= 1);
  assert.equal(blocked.body.includes('wrong'), false);
});

test('gate: with a mint unavailable the launch token passes through untouched', async () => {
  const { gate } = await makeGate({ name: 'gate-token' });
  const res = makeResponse();
  const handled = gate.handleRequest(makeRequest({ url: '/?token=ABC' }), res, () => {});
  assert.equal(handled, false);

  const api = makeResponse();
  const allowed = gate.handleRequest(makeRequest({ url: '/api/session', headers: { cookie: `${SESSION_COOKIE}=invalid` } }), api, () => {});
  assert.equal(allowed, true);
  await waitEnded(api);
  assert.equal(api.statusCode, 302, 'an invalid cookie behaves like no session');
});

test('gate: disabled means the proxy behaves exactly as before', async () => {
  const { config, errors } = normalizeConfig(
    { listen: { host: '127.0.0.1', port: 0 }, upstream: { host: '127.0.0.1', port: 3001 }, auth: { enabled: false } },
    { homePath: '/tmp/x', upstreamPort: 3001 },
  );
  assert.deepEqual(errors, []);
  const store = new AuthStore({ dir: tempDir('gate-off'), logger: { warn() {} } });
  const gate = createAuthGate({ config, store, logger: { info() {}, warn() {}, error() {} } });
  assert.equal(gate.handleRequest(makeRequest({ url: '/' }), makeResponse(), () => {}), false);
  assert.equal(gate.handleUpgrade(makeRequest({ url: '/api/remote.mux' }), { end() {}, destroy() {} }, null, () => {}), false);
});

test('gate: /penpot uses Penpot auth and never mints the core cookie', async () => {
  const connection = { authenticatedUrl: (base) => `${base}/?${'tok' + 'en'}=LAUNCH-VALUE` };
  const { gate, store } = await makeGate({ name: 'gate-penpot', connection });
  const token = signSession({ sid: 'penpot-session', exp: Date.now() + 60_000 }, store.cachedSecret());
  const req = makeRequest({
    url: '/penpot/?file-id=x',
    headers: { cookie: `${SESSION_COOKIE}=${token}`, host: 'api.example.test:3000' },
  });
  const handled = gate.handleRequest(req, makeResponse(), () => {});
  assert.equal(handled, false, 'the gate must let /penpot reach the proxy directly');
  assert.equal(req.url, '/penpot/?file-id=x');
});

test('gate: a mint bounce is single-shot and downgrades Strict to Lax', async () => {
  const connection = { authenticatedUrl: (base) => `${base}/?${'tok' + 'en'}=LAUNCH-VALUE` };
  const { gate, store, config } = await makeGate({ name: 'gate-mint-once', connection });
  const upstream = createHttpServer((req, res) => {
    res.writeHead(200, { 'set-cookie': 'dsh-auth-test=abc; Path=/; HttpOnly; SameSite=Strict' });
    res.end('ok');
  });
  await new Promise((resolve) => upstream.listen(config.upstream.port, '127.0.0.1', resolve));
  try {
    const token = signSession({ sid: 'mint-session', exp: Date.now() + 60_000 }, store.cachedSecret());
    const first = makeResponse();
    const req1 = makeRequest({
      url: '/app',
      headers: { cookie: `${SESSION_COOKIE}=${token}`, host: 'api.example.test:3000' },
    });
    assert.equal(gate.handleRequest(req1, first, () => {}), true);
    await waitEnded(first, 3000);
    assert.equal(first.statusCode, 303);
    assert.match(first.headers.location, /__dsh_mint=1/);
    const setCookie = first.headers['set-cookie'];
    const text = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
    assert.match(text, /SameSite=Lax/i);
    assert.doesNotMatch(text, /SameSite=Strict/i);

    const second = makeResponse();
    const req2 = makeRequest({
      url: '/app?__dsh_mint=1',
      headers: { cookie: `${SESSION_COOKIE}=${token}`, host: 'api.example.test:3000' },
    });
    assert.equal(gate.handleRequest(req2, second, () => {}), false, 'the second pass must reach the upstream instead of redirecting again');
    assert.equal(req2.url, '/app');
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});