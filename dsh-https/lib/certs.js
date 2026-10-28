import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { certSanList, sanCovers } from './san.js';
import { ensureLocalCa } from './local-ca.js';
import {
  daysLeft,
  fingerprintSha256,
  normalizePem,
  readIfExists,
  sanitizeError,
  splitPemBlocks,
  statMode,
} from './util.js';

export function certificateInfo(cert) {
  const san = certSanList(cert);
  return {
    subject: String(cert.subject).replace(/\n/g, ', '),
    issuer: String(cert.issuer).replace(/\n/g, ', '),
    serialNumber: cert.serialNumber,
    notBefore: new Date(cert.validFrom),
    notAfter: new Date(cert.validTo),
    daysLeft: daysLeft(cert.validTo),
    san,
    fingerprintSha256: cert.fingerprint256,
    chainLength: 1,
  };
}

export function validateCertificatePair(certPem, keyPem) {
  const blocks = splitPemBlocks(certPem).filter((block) => block.label === 'CERTIFICATE');
  if (blocks.length === 0) throw new Error('证书文件里没有 CERTIFICATE 块');
  const cert = new X509Certificate(blocks[0].pem);
  const key = createPrivateKey(keyPem);
  if (!cert.checkPrivateKey(key)) throw new Error('证书与私钥不匹配');
  const chain = [];
  for (let index = 1; index < blocks.length; index += 1) {
    chain.push(new X509Certificate(blocks[index].pem));
  }
  if (chain.length > 0 && !cert.checkIssued(chain[0])) {
    throw new Error('证书链顺序错误：第一张中间证书未签发叶子证书');
  }
  const info = certificateInfo(cert);
  info.chainLength = blocks.length;
  info.chain = chain;
  return { certPem: normalizePem(blocks.map((block) => block.pem).join('\n')), keyPem: normalizePem(keyPem), cert, key, ...info };
}

export async function loadPublicCertFiles({ certFile, keyFile }, logger = console) {
  const [certRaw, keyRaw] = await Promise.all([readFile(certFile), readFile(keyFile)]);
  const pair = validateCertificatePair(certRaw.toString(), keyRaw.toString());
  const stat = await statMode(keyFile);
  if (stat && (stat.mode & 0o077) !== 0) {
    logger.warn?.(`[dsh-https] 私钥文件权限过宽（${stat.mode.toString(8)}），建议 chmod 600`);
  }
  return { ...pair, source: 'files', meta: { staging: null, certFile, keyFile } };
}

export class CertStore {
  constructor({ config, logger = console }) {
    this.config = config;
    this.logger = logger;
    this.local = null;
    this.localError = null;
    this.public = null;
    this.publicError = null;
    this.contexts = new Map();
    this.onUpdate = null;
  }

  async init() {
    if (this.config.localCa.enabled) {
      try {
        const local = await ensureLocalCa(this.config, this.logger);
        this.local = local;
      } catch (error) {
        this.localError = sanitizeError(error);
        this.logger.error?.(`[dsh-https] 本地 CA 初始化失败：${this.localError}`);
      }
    }

    if (this.config.publicCert.mode === 'files') {
      try {
        this.public = await loadPublicCertFiles(this.config.publicCert, this.logger);
        this.publicError = null;
      } catch (error) {
        this.publicError = sanitizeError(error);
        this.logger.error?.(`[dsh-https] 读取证书文件失败：${this.publicError}`);
      }
    } else if (this.config.publicCert.mode === 'acme' || this.config.acme.enabled) {
      try {
        const loaded = await this.loadPersistedAcme();
        if (loaded) {
          this.public = loaded;
          this.publicError = null;
        }
      } catch (error) {
        this.publicError = sanitizeError(error);
        this.logger.warn?.(`[dsh-https] 已有 ACME 证书不可用：${this.publicError}`);
      }
    }

    if (!this.getDefaultPair()) {
      throw new Error(
        this.localError
          ? `没有可用的 TLS 证书：本地 CA 失败（${this.localError}）`
          : '没有可用的 TLS 证书：请启用 localCa 或配置 publicCert',
      );
    }
  }

  /**
   * Re-load the public certificate after the settings page switched modes.
   * `mode` is the new publicCert.mode; the local CA half stays as it is.
   */
  async applyMode(mode) {
    const previous = this.public;
    if (mode === 'files') {
      try {
        this.setPublicPair(await loadPublicCertFiles(this.config.publicCert, this.logger));
      } catch (error) {
        this.publicError = sanitizeError(error);
        this.public = previous?.source === 'files' ? previous : null;
        this.contexts.clear();
        this.onUpdate?.('public');
        throw error;
      }
      return this.public;
    }
    if (mode === 'acme') {
      let persisted = null;
      try {
        persisted = await this.loadPersistedAcme();
      } catch (error) {
        this.logger.warn?.(`[dsh-https] 已有 ACME 证书不可用：${sanitizeError(error)}`);
      }
      if (persisted) {
        this.setPublicPair(persisted);
      } else if (previous?.source === 'files') {
        // Keep serving the file certificate until the first ACME issuance
        // succeeds, so switching the switch never takes HTTPS down.
        this.logger.info?.('[dsh-https] 已切换到自动证书，等待首次签发期间继续使用文件证书');
      }
      return this.public;
    }
    throw new Error(`不支持的证书模式：${mode}`);
  }

  async loadPersistedAcme() {
    const dir = path.join(this.config.dataDir, 'acme');
    const certPath = path.join(dir, 'fullchain.pem');
    const keyPath = path.join(dir, 'privkey.pem');
    const metaPath = path.join(dir, 'meta.json');
    const certRaw = await readIfExists(certPath);
    const keyRaw = await readIfExists(keyPath);
    if (!certRaw || !keyRaw) return null;
    const pair = validateCertificatePair(certRaw.toString(), keyRaw.toString());
    const metaRaw = await readIfExists(metaPath);
    let meta = {};
    if (metaRaw) {
      try {
        meta = JSON.parse(metaRaw.toString());
      } catch {
        meta = {};
      }
    }
    return {
      ...pair,
      source: 'acme',
      meta,
      certFile: certPath,
      keyFile: keyPath,
    };
  }

  setPublic(certPem, keyPem, meta = {}) {
    return this.setPublicPair({ ...validateCertificatePair(certPem, keyPem), source: 'acme', meta });
  }

  setPublicPair(pair) {
    this.public = pair;
    this.publicError = null;
    this.contexts.clear();
    this.onUpdate?.('public');
    return this.public;
  }

  clearPublic(error) {
    this.public = null;
    this.publicError = error ? sanitizeError(error) : null;
    this.contexts.clear();
    this.onUpdate?.('public');
  }

  setLocal(local) {
    this.local = local;
    this.localError = null;
    this.contexts.clear();
    this.onUpdate?.('local');
  }

  isUsable(pair) {
    return Boolean(pair) && pair.daysLeft > 0;
  }

  getDefaultPair() {
    if (this.local) return { cert: this.local.leafPem, key: this.local.leafKeyPem, source: 'local' };
    if (this.isUsable(this.public)) return { cert: this.public.certPem, key: this.public.keyPem, source: 'public' };
    return null;
  }

  contextFor(pair, source) {
    const key = `${source}:${pair.leafFingerprintSha256 || pair.fingerprintSha256}`;
    if (!this.contexts.has(key)) {
      this.contexts.set(
        key,
        tls.createSecureContext({
          cert: pair.certPem || pair.leafPem,
          key: pair.keyPem || pair.leafKeyPem,
          minVersion: 'TLSv1.2',
        }),
      );
    }
    return this.contexts.get(key);
  }

  getContextForHostname(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (this.public && this.isUsable(this.public) && host && sanCovers(this.public.san, host)) {
      return this.contextFor(this.public, 'public');
    }
    if (this.local) {
      if (!host || sanCovers(this.local.sans, host)) return this.contextFor(this.local, 'local');
    }
    return this.getDefaultContext();
  }

  getDefaultContext() {
    if (this.local) return this.contextFor(this.local, 'local');
    if (this.isUsable(this.public)) return this.contextFor(this.public, 'public');
    return undefined;
  }

  getDefaultPairForTls() {
    const pair = this.getDefaultPair();
    return pair ? { cert: pair.cert, key: pair.key } : null;
  }

  publicInfo() {
    if (!this.public) {
      return { available: false, source: null, error: this.publicError };
    }
    const usable = this.isUsable(this.public);
    return {
      available: usable,
      source: this.public.source,
      certFile: this.public.meta?.certFile ?? null,
      subject: this.public.subject,
      issuer: this.public.issuer,
      san: this.public.san,
      notBefore: this.public.notBefore,
      notAfter: this.public.notAfter,
      daysLeft: this.public.daysLeft,
      fingerprintSha256: this.public.fingerprintSha256,
      chainLength: this.public.chainLength,
      staging: this.public.meta?.staging ?? null,
      error: this.publicError ?? (usable ? null : '证书已过期'),
    };
  }

  localInfo() {
    if (!this.config.localCa.enabled) return { enabled: false, available: false };
    if (!this.local) return { enabled: true, available: false, error: this.localError };
    return {
      enabled: true,
      available: true,
      caFile: this.local.paths.caCert,
      caFingerprintSha256: this.local.caFingerprintSha256,
      caNotAfter: this.local.caNotAfter,
      leafNotAfter: this.local.leafNotAfter,
      leafDaysLeft: daysLeft(this.local.leafNotAfter),
      sans: this.local.sans,
      caKeyMode: this.local.caKeyMode,
      regenerated: this.local.regenerated,
    };
  }

  caPem() {
    return this.local?.caPem ?? null;
  }

  defaultSource() {
    return this.local ? 'local' : this.isUsable(this.public) ? 'public' : null;
  }

  status() {
    return {
      public: this.publicInfo(),
      local: this.localInfo(),
      defaultSource: this.defaultSource(),
    };
  }
}
