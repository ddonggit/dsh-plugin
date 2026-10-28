import acme from 'acme-client';
import path from 'node:path';
import { validateCertificatePair } from './certs.js';
import { TencentDnsProvider } from './dns-tencent.js';
import { waitForTxt } from './dns-verify.js';
import { sanCovers } from './san.js';
import {
  atomicWrite,
  copyIfExists,
  daysLeft,
  ensureDir,
  normalizePem,
  readIfExists,
  sanitizeError,
} from './util.js';

const DIRECTORIES = {
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  production: 'https://acme-v02.api.letsencrypt.org/directory',
};

export function createAcmeManager({ config, certStore, logger = console, credentials, onCertificate }) {
  return new AcmeManager({ config, certStore, logger, credentials, onCertificate });
}

class AcmeManager {
  constructor({ config, certStore, logger, credentials, onCertificate }) {
    this.config = config;
    this.certStore = certStore;
    this.logger = logger;
    this.credentials = credentials;
    this.onCertificate = onCertificate;
    this.timer = null;
    this.inFlight = null;
    this.stopped = false;
    this.failures = 0;
    this.zone = config.acme.dns.zone || null;
    this.state = {
      phase: config.acme.enabled ? 'idle' : 'disabled',
      lastError: null,
      lastAttempt: null,
      lastSuccess: null,
      nextAttempt: null,
      challenge: null,
    };
  }

  get directoryUrl() {
    return this.config.acme.staging ? DIRECTORIES.staging : DIRECTORIES.production;
  }

  status() {
    return {
      enabled: this.config.acme.enabled,
      usable: this.config.acme.usable,
      phase: this.state.phase,
      staging: this.config.acme.staging,
      directory: this.directoryUrl,
      email: this.config.acme.email,
      domains: this.config.acme.domains,
      zone: this.zone,
      lastError: this.state.lastError,
      lastAttempt: this.state.lastAttempt,
      lastSuccess: this.state.lastSuccess,
      nextAttempt: this.state.nextAttempt,
      challenge: this.state.challenge,
    };
  }

  async start() {
    if (!this.config.acme.enabled) {
      this.state.phase = 'disabled';
      return;
    }
    if (!this.config.acme.usable) {
      this.state.phase = 'misconfigured';
      this.state.lastError =
        this.config.publicCert?.mode === 'files'
          ? 'publicCert.mode=files 时不运行 ACME 自动签发'
          : 'ACME 配置不完整（email/domains/zone/agreeTos）';
      return;
    }
    this.state.phase = 'idle';
    this.schedule(5000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Re-arm the manager after stop(), or after the settings page changed the
   * ACME fields at runtime. A short delay makes a mode switch start issuance
   * without waiting for the regular check interval.
   */
  resume(delayMs = 5000) {
    this.stopped = false;
    if (this.inFlight) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.config.acme.enabled || !this.config.acme.usable) {
      this.state.phase = this.config.acme.enabled ? 'misconfigured' : 'disabled';
      this.state.nextAttempt = null;
      return;
    }
    this.state.phase = 'idle';
    this.schedule(delayMs);
  }

  // Failed issuances back off exponentially (5, 10, 20, ... minutes) up to the
  // regular check interval, so a broken DNS/API setup does not hammer Let's
  // Encrypt and burn its rate limits.
  nextDelay() {
    const base = this.config.acme.checkIntervalHours * 3_600_000;
    if (this.failures <= 0) return base;
    const backoff = 5 * 60_000 * 2 ** Math.min(this.failures - 1, 10);
    return Math.max(60_000, Math.min(base, backoff));
  }

  schedule(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = delayMs ?? this.nextDelay();
    this.state.nextAttempt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check({ reason: 'timer' }).catch((error) => {
        this.logger.error?.(`[dsh-https] ACME 定时检查失败：${sanitizeError(error)}`);
      });
    }, delay);
    this.timer.unref?.();
  }

  needsRenewal() {
    const publicInfo = this.certStore.public;
    if (!publicInfo || publicInfo.source !== 'acme') return true;
    if (publicInfo.meta?.staging !== this.config.acme.staging) return true;
    if (daysLeft(publicInfo.notAfter) <= this.config.acme.renewBeforeDays) return true;
    if (!this.config.acme.domains.every((domain) => sanCovers(publicInfo.san, domain))) return true;
    return false;
  }

  async check({ force = false, reason = 'timer' } = {}) {
    if (this.stopped) return { status: 'stopped' };
    if (this.inFlight) return { status: 'busy' };
    if (!this.config.acme.enabled || !this.config.acme.usable) {
      this.state.phase = 'misconfigured';
      return { status: 'misconfigured' };
    }
    if (!force && !this.needsRenewal()) {
      this.state.phase = 'valid';
      this.schedule();
      return { status: 'valid' };
    }
    const promise = this.issue(reason)
      .then(() => {
        this.failures = 0;
        return { status: 'issued' };
      })
      .catch((error) => {
        this.failures += 1;
        this.state.phase = 'error';
        this.state.lastError = sanitizeError(error);
        this.logger.error?.(`[dsh-https] ACME 签发失败：${this.state.lastError}`);
        return { status: 'error', error: this.state.lastError };
      })
      .finally(() => {
        this.inFlight = null;
        this.schedule();
      });
    this.inFlight = promise;
    return { status: 'started', promise };
  }

  async loadAccountKey() {
    const dir = path.join(this.config.dataDir, 'acme');
    const file = path.join(dir, 'account.key');
    const existing = await readIfExists(file);
    if (existing && existing.toString().trim()) return normalizePem(existing.toString());
    const key = await acme.crypto.createPrivateKey();
    const pem = normalizePem(key.toString());
    await ensureDir(dir, 0o700);
    await atomicWrite(file, pem, 0o600);
    return pem;
  }

  async ensureAccount(client) {
    try {
      client.getAccountUrl();
      return;
    } catch {
      // No account URL cached yet; create (or look up) the account below.
    }
    await client.createAccount({
      termsOfServiceAgreed: true,
      contact: [`mailto:${this.config.acme.email}`],
    });
  }

  async issue(reason) {
    this.state.phase = 'issuing';
    this.state.lastAttempt = new Date().toISOString();
    this.state.lastError = null;
    this.state.challenge = null;
    this.logger.info?.(`[dsh-https] ACME 开始签发（${reason}，${this.directoryUrl}）`);

    const records = new Map();
    let dns = null;
    try {
      const credentials = await this.credentials();
      if (!credentials?.secretId || !credentials?.secretKey) {
        throw new Error('腾讯云 DNSPod 凭据未配置');
      }
      dns = new TencentDnsProvider({
        zone: this.config.acme.dns.zone,
        recordLine: this.config.acme.dns.recordLine,
        ttl: this.config.acme.dns.ttl,
        endpoint: this.config.acme.dns.endpoint,
        secretId: credentials.secretId,
        secretKey: credentials.secretKey,
      });
      this.zone = await dns.detectZone(this.config.acme.domains);
      this.logger.info?.(`[dsh-https] ACME 使用 DNSPod zone：${this.zone}`);

      const client = new acme.Client({
        directoryUrl: this.directoryUrl,
        accountKey: await this.loadAccountKey(),
        backoffAttempts: 3,
        backoffMin: 2000,
        backoffMax: 30000,
      });
      await this.ensureAccount(client);

      const [keyRaw, csr] = await acme.crypto.createCsr({
        commonName: this.config.acme.domains[0],
        altNames: this.config.acme.domains,
      });
      const keyPem = normalizePem(keyRaw.toString());

      const challengeCreateFn = async (authz, challenge, keyAuthorization) => {
        const identifier = authz.identifier.value;
        const recordName = `_acme-challenge.${identifier}`;
        this.state.challenge = recordName;
        this.logger.info?.(`[dsh-https] ACME 创建 TXT ${recordName}`);
        const record = await dns.createTxt(recordName, keyAuthorization);
        records.set(challenge.token, {
          recordName,
          recordId: record.recordId,
          owned: !record.existed,
          value: keyAuthorization,
        });
        await waitForTxt(recordName, keyAuthorization, {
          timeoutMs: this.config.acme.propagationTimeoutSec * 1000,
          initialDelayMs: this.config.acme.propagationDelaySec * 1000,
          logger: this.logger,
        });
      };

      const challengeRemoveFn = async (authz, challenge) => {
        const record = records.get(challenge.token);
        if (record) this.logger.info?.(`[dsh-https] ACME 校验结束后清理 TXT ${record.recordName}`);
        // Records are removed together in finally() after the whole order finishes.
      };

      const certRaw = await client.auto({
        csr,
        email: this.config.acme.email,
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        skipChallengeVerification: true,
        challengeCreateFn,
        challengeRemoveFn,
      });

      const pair = validateCertificatePair(certRaw.toString(), keyPem);
      if (pair.chainLength < 2) throw new Error('ACME 返回的证书链不完整（缺少中间证书）');
      await this.writeCertificate(pair, { zone: this.zone });
      this.certStore.setPublic(pair.certPem, pair.keyPem, {
        source: 'acme',
        staging: this.config.acme.staging,
        email: this.config.acme.email,
        domains: this.config.acme.domains,
        zone: this.zone,
        issuedAt: new Date().toISOString(),
        directoryUrl: this.directoryUrl,
      });
      this.state.phase = 'valid';
      this.state.lastSuccess = new Date().toISOString();
      this.state.challenge = null;
      this.logger.info?.(`[dsh-https] ACME 签发成功：${pair.subject}，有效期至 ${pair.notAfter.toISOString()}`);
      this.onCertificate?.();
      return pair;
    } finally {
      if (dns) {
        for (const record of records.values()) {
          if (!record.owned) continue;
          try {
            await dns.deleteTxt(record.recordId);
          } catch (error) {
            this.logger.warn?.(`[dsh-https] 清理 TXT ${record.recordName} 失败：${sanitizeError(error)}`);
          }
        }
      }
      this.state.challenge = null;
    }
  }

  async writeCertificate(pair, meta) {
    const dir = path.join(this.config.dataDir, 'acme');
    const previous = path.join(dir, 'previous');
    await ensureDir(dir, 0o700);
    await ensureDir(previous, 0o700);
    for (const name of ['fullchain.pem', 'privkey.pem', 'meta.json']) {
      await copyIfExists(path.join(dir, name), path.join(previous, name));
    }
    const record = {
      issuedAt: new Date().toISOString(),
      staging: this.config.acme.staging,
      email: this.config.acme.email,
      domains: this.config.acme.domains,
      zone: meta?.zone ?? this.zone,
      subject: pair.subject,
      issuer: pair.issuer,
      san: pair.san,
      notAfter: pair.notAfter.toISOString(),
      directoryUrl: this.directoryUrl,
    };
    await atomicWrite(path.join(dir, 'privkey.pem'), pair.keyPem, 0o600);
    await atomicWrite(path.join(dir, 'fullchain.pem'), pair.certPem, 0o644);
    await atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(record, null, 2), 0o644);
    return record;
  }
}
