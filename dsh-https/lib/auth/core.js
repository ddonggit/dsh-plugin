// Auth primitives for the dsh-https login gate: password hashing, stateless
// signed sessions, cookie parsing, redirect sanitising and login throttling.
// Everything here is pure Node standard library so the gate never blocks the
// event loop for long and never depends on a third-party crypto package.

import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32, saltBytes: 16 });
// A stored hash is attacker-controlled only in the sense that the file is ours,
// but never let a hand-edited file make us allocate gigabytes of memory:
// scrypt needs roughly 128 * N * r bytes, so allow N<=32768 and N*r<=262144.
const MAX_SCRYPT_N = 32768;
const MAX_SCRYPT_NR = 262144;
export const SESSION_COOKIE = 'dsh_https_auth';
export const AUTH_BASE = '/dsh-https/auth';
export const SESSION_VERSION = 1;
export const MIN_PASSWORD_LENGTH = 8;
export const SESSION_MAX_NEXT_LENGTH = 512;

export function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromB64url(text) {
  return Buffer.from(String(text), 'base64url');
}

export function safeEqualBytes(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function safeEqualText(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function randomToken(bytes = 16) {
  return b64url(randomBytes(bytes));
}

export function createSecret() {
  return b64url(randomBytes(32));
}

export function newSessionId() {
  return b64url(randomBytes(12));
}

/**
 * Hash a password with scrypt. Format (also accepted by @fonlan/dsh-web-auth):
 *   scrypt$N$r$p$<b64url salt>$<b64url hash>
 */
export async function hashPassword(password, params = SCRYPT) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  const salt = randomBytes(params.saltBytes);
  const key = await scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p });
  return ['scrypt', params.N, params.r, params.p, b64url(salt), b64url(key)].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length === 0) return false;
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 1024 || N > MAX_SCRYPT_N || r < 1 || r > 32 || p < 1 || p > 16) return false;
  if (N * r > MAX_SCRYPT_NR) return false;
  const salt = fromB64url(parts[4]);
  const expected = fromB64url(parts[5]);
  if (salt.length === 0 || expected.length === 0 || expected.length > 128) return false;
  let key;
  try {
    key = await scrypt(password, salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return safeEqualBytes(key, expected);
}

export function sessionExpiry(maxAgeDays, now = Date.now()) {
  const days = Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : 30;
  return now + Math.round(days * 86_400_000);
}

export function signSession({ sid, exp, iat = Date.now() }, secret) {
  const body = b64url(JSON.stringify({ v: SESSION_VERSION, sid, iat, exp }));
  const signature = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${signature}`;
}

export function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !token || !secret) return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0 || separator === token.length - 1) return null;
  const body = token.slice(0, separator);
  const signature = fromB64url(token.slice(separator + 1));
  const expected = createHmac('sha256', secret).update(body).digest();
  if (!safeEqualBytes(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.v !== SESSION_VERSION) return null;
  if (typeof payload.sid !== 'string' || payload.sid.length === 0) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;
  return payload;
}

export function parseCookies(header) {
  const out = new Map();
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

export function countCookiePrefix(cookies, prefix) {
  let count = 0;
  for (const name of cookies.keys()) {
    if (name.startsWith(prefix)) count += 1;
  }
  return count;
}

/**
 * Keep only same-origin, relative redirect targets. Anything that could leave
 * the site (`//host`, `https://host`, `/\host`, control characters) falls back,
 * and a `token` query parameter is dropped so the launch token never lands in
 * our login page URL or the browser history.
 */
export function sanitizeNext(value, fallback = '/') {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !raw.startsWith('/')) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  if (raw.includes('\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  if (raw.length > SESSION_MAX_NEXT_LENGTH) return fallback;
  try {
    const parsed = new URL(raw, 'http://placeholder.local');
    parsed.searchParams.delete('token');
    const search = parsed.searchParams.toString();
    return `${parsed.pathname}${search ? `?${search}` : ''}${parsed.hash}` || fallback;
  } catch {
    return fallback;
  }
}

export function passwordProblem(password, confirm) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `密码至少需要 ${MIN_PASSWORD_LENGTH} 位`;
  }
  if (password.length > 256) return '密码过长';
  if (confirm !== undefined && password !== confirm) return '两次输入的密码不一致';
  return null;
}

export function normalizeClientIp(address) {
  const raw = String(address ?? '').trim();
  if (!raw) return 'unknown';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  if (raw === '::1') return '127.0.0.1';
  const zone = raw.indexOf('%');
  return zone > 0 ? raw.slice(0, zone) : raw;
}

export function pseudonymizeIp(ip, key) {
  return createHmac('sha256', key).update(String(ip)).digest('base64url').slice(0, 16);
}

/**
 * Failure-counting throttle with exponential backoff, keyed by client address.
 * State is intentionally in-process: a restart resets it (documented).
 */
export class RateLimiter {
  constructor({ limit = 5, windowMs = 60_000, maxDelayMs = 30 * 60_000, maxEntries = 4096 } = {}) {
    this.limit = Math.max(1, limit);
    this.windowMs = Math.max(1000, windowMs);
    this.maxDelayMs = Math.max(this.windowMs, maxDelayMs);
    this.maxEntries = Math.max(16, maxEntries);
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  prune(now) {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (now >= entry.blockedUntil && now - entry.last > this.windowMs) this.entries.delete(key);
    }
  }

  check(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true, retryAfterSec: 0 };
    if (now < entry.blockedUntil) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  fail(key, now = Date.now()) {
    const entry = this.entries.get(key) ?? { failures: 0, first: now, last: now, blockedUntil: 0 };
    if (now - entry.first > this.windowMs) {
      entry.failures = 0;
      entry.first = now;
    }
    entry.failures += 1;
    entry.last = now;
    // `limit` failures are tolerated inside the window; from the next request on
    // the caller is locked out with exponential backoff.
    const over = entry.failures - this.limit + 1;
    if (over > 0) {
      const delay = Math.min(this.maxDelayMs, this.windowMs * 2 ** Math.min(over - 1, 16));
      entry.blockedUntil = now + delay;
    }
    this.entries.set(key, entry);
    this.prune(now);
    return { failures: entry.failures, blockedUntil: entry.blockedUntil, retryAfterSec: Math.max(0, Math.ceil((entry.blockedUntil - now) / 1000)) };
  }

  succeed(key) {
    this.entries.delete(key);
  }

  reset() {
    this.entries.clear();
  }
}