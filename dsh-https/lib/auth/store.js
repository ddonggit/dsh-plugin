// On-disk state for the login gate: password hash, session signing secret,
// one-time first-run setup token and the audit log. Every file lives in
// <dataDir>/auth with 0600 permissions and is written atomically.

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendFile, rename } from 'node:fs/promises';
import { atomicWrite, ensureDir, readIfExists, removeIfExists, sanitizeError, statMode } from '../util.js';
import { b64url, createSecret, hashPassword, pseudonymizeIp, safeEqualText } from './core.js';

const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

export class AuthStore {
  constructor({ dir, logger = console }) {
    this.dir = dir;
    this.logger = logger;
    this.secret = null;
    this.auditKeyCache = null;
  }

  get passwordFile() {
    return path.join(this.dir, 'password.hash');
  }

  get secretFile() {
    return path.join(this.dir, 'secret');
  }

  get setupTokenFile() {
    return path.join(this.dir, 'setup-token');
  }

  get auditFile() {
    return path.join(this.dir, 'audit.jsonl');
  }

  get auditKeyFile() {
    return path.join(this.dir, 'audit-key');
  }

  async init() {
    await ensureDir(this.dir, 0o700);
    return this;
  }

  /** Signing secret, from the in-memory cache (no I/O on the request path). */
  cachedSecret() {
    return this.secret;
  }

  async prime() {
    await this.init();
    this.secret = await this.readOrCreateSecret();
    return this.secret;
  }

  async readOrCreateSecret() {
    if (this.secret) return this.secret;
    const existing = await readIfExists(this.secretFile);
    const value = existing ? existing.toString('utf8').trim() : '';
    if (value) {
      this.secret = value;
      return value;
    }
    return this.rotateSecret();
  }

  /** Invalidate every existing session (password change, manual rotation). */
  async rotateSecret() {
    const secret = createSecret();
    await atomicWrite(this.secretFile, `${secret}\n`, 0o600);
    this.secret = secret;
    return secret;
  }

  async readPasswordHash() {
    const buffer = await readIfExists(this.passwordFile);
    const value = buffer ? buffer.toString('utf8').trim() : '';
    return value || null;
  }

  async hasPassword() {
    return Boolean(await this.readPasswordHash());
  }

  async setPassword(password) {
    const hash = await hashPassword(password);
    await atomicWrite(this.passwordFile, `${hash}\n`, 0o600);
    await this.rotateSecret();
    await this.clearSetupToken();
    return { changed: true };
  }

  async clearPassword() {
    await removeIfExists(this.passwordFile);
  }

  async ensureSetupToken() {
    const existing = await readIfExists(this.setupTokenFile);
    const value = existing ? existing.toString('utf8').trim() : '';
    if (value) return value;
    const token = b64url(randomBytes(24));
    await atomicWrite(this.setupTokenFile, `${token}\n`, 0o600);
    return token;
  }

  async clearSetupToken() {
    await removeIfExists(this.setupTokenFile);
  }

  async consumeSetupToken(candidate) {
    const current = await this.ensureSetupToken();
    if (!safeEqualText(candidate, current)) return false;
    await this.clearSetupToken();
    return true;
  }

  async auditKey() {
    if (this.auditKeyCache) return this.auditKeyCache;
    const existing = await readIfExists(this.auditKeyFile);
    const value = existing ? existing.toString('utf8').trim() : '';
    if (value) {
      this.auditKeyCache = value;
      return value;
    }
    const key = createSecret();
    await atomicWrite(this.auditKeyFile, `${key}\n`, 0o600);
    this.auditKeyCache = key;
    return key;
  }

  async pseudonym(ip) {
    const key = await this.auditKey();
    return pseudonymizeIp(ip, key);
  }

  async appendAudit(event, { ip = '', detail = '' } = {}) {
    try {
      const info = await statMode(this.auditFile);
      if (info && info.size > AUDIT_ROTATE_BYTES) {
        await rename(this.auditFile, `${this.auditFile}.1`);
      }
      const record = {
        ts: new Date().toISOString(),
        event: String(event).slice(0, 64),
        ip: ip ? await this.pseudonym(ip) : null,
        detail: detail ? String(detail).slice(0, 200) : null,
      };
      await appendFile(this.auditFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (error) {
      this.logger?.warn?.(`[dsh-https] 审计日志写入失败：${sanitizeError(error)}`);
    }
  }

  async status() {
    return {
      dir: this.dir,
      passwordFile: this.passwordFile,
    };
  }
}