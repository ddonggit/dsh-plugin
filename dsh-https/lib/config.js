import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isPlainObject } from './util.js';

export const DEFAULT_CONFIG = Object.freeze({
  listen: { host: '0.0.0.0', port: 3088 },
  upstream: { host: '127.0.0.1', port: null, protocol: 'http' },
  dataDir: null,
  publicCert: { mode: 'local', certFile: '', keyFile: '', watchIntervalSec: 30 },
  localCa: {
    enabled: true,
    commonName: 'DSH Local CA',
    organization: 'DSH',
    hosts: [],
    rootDays: 3650,
    leafDays: 397,
    renewBeforeDays: 30,
  },
  acme: {
    enabled: false,
    staging: true,
    email: '',
    domains: [],
    agreeTos: false,
    renewBeforeDays: 30,
    checkIntervalHours: 6,
    propagationTimeoutSec: 180,
    propagationDelaySec: 15,
    dns: {
      provider: 'tencent',
      zone: '',
      credentialsFile: '',
      secretIdRef: 'TENCENT_DNSPOD_SECRET_ID',
      secretKeyRef: 'TENCENT_DNSPOD_SECRET_KEY',
      recordLine: '默认',
      ttl: 600,
      endpoint: 'https://dnspod.tencentcloudapi.com',
    },
  },
  proxy: { keepAlive: true, connectTimeoutMs: 10000, maxConnections: 512, addSecureCookie: true },
});

const CERT_MODES = new Set(['local', 'files', 'acme']);
const DNS_HOST_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function object(value) {
  return isPlainObject(value) ? value : {};
}

function str(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function integer(value, fallback, min, max, field, errors) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    errors.push(`${field} 必须是 ${min}..${max} 的整数`);
    return fallback;
  }
  return parsed;
}

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}

function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
}

export function isDnsName(value) {
  const name = normalizeName(value);
  if (!name || name.length > 253) return false;
  if (isIP(name)) return true;
  return DNS_HOST_RE.test(name);
}

export function isIpLiteral(value) {
  const raw = String(value ?? '').trim().replace(/^\[|\]$/g, '');
  return isIP(raw) !== 0;
}

function resolvePath(value, base) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

export function normalizeConfig(raw = {}, options = {}) {
  const source = object(raw);
  const errors = [];
  const warnings = [];
  const homePath = options.homePath || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const dataDir = resolvePath(str(source.dataDir, ''), process.cwd()) || path.join(homePath, 'https');

  const listenRaw = object(source.listen);
  const listenHost = str(listenRaw.host, DEFAULT_CONFIG.listen.host);
  const listenPort = integer(listenRaw.port, DEFAULT_CONFIG.listen.port, 0, 65535, 'listen.port', errors);

  const upstreamRaw = object(source.upstream);
  const upstreamHost = str(upstreamRaw.host, DEFAULT_CONFIG.upstream.host);
  // `options.upstreamPort` comes from the live webserver listener. At plugin
  // apply time the listener may not be bound yet, so the value can be
  // `undefined` (or 0). Treat anything outside 1..65535 as "not discovered"
  // instead of turning it into a fake config error and an unusable port 0.
  const discoveredUpstreamPort =
    typeof options.upstreamPort === 'number' &&
    Number.isInteger(options.upstreamPort) &&
    options.upstreamPort > 0 &&
    options.upstreamPort <= 65535
      ? options.upstreamPort
      : undefined;
  const upstreamPort = integer(
    upstreamRaw.port ?? discoveredUpstreamPort ?? DEFAULT_CONFIG.upstream.port,
    discoveredUpstreamPort ?? 3081,
    1,
    65535,
    'upstream.port',
    errors,
  );
  const upstreamProtocol = str(upstreamRaw.protocol, 'http').toLowerCase();
  if (upstreamProtocol !== 'http' && upstreamProtocol !== 'https') {
    errors.push('upstream.protocol 只能是 http 或 https');
  }
  if (listenPort !== 0 && listenPort === upstreamPort) {
    errors.push('listen.port 不能与 upstream.port 相同');
  }

  const publicRaw = object(source.publicCert);
  const mode = str(publicRaw.mode, 'local');
  if (!CERT_MODES.has(mode)) errors.push('publicCert.mode 只能是 local、files 或 acme');
  const certFile = resolvePath(str(publicRaw.certFile, ''), dataDir);
  const keyFile = resolvePath(str(publicRaw.keyFile, ''), dataDir);
  if (mode === 'files' && (!certFile || !keyFile)) {
    errors.push('publicCert.mode=files 时必须配置 certFile 与 keyFile');
  }
  const watchIntervalSec = integer(publicRaw.watchIntervalSec, 30, 0, 3600, 'publicCert.watchIntervalSec', errors);

  const localRaw = object(source.localCa);
  const localEnabled = boolean(localRaw.enabled, true);
  if (!localEnabled && mode === 'local') errors.push('localCa.enabled=false 时 publicCert.mode 不能是 local');
  const localHosts = list(localRaw.hosts);
  const validLocalHosts = [];
  for (const entry of localHosts) {
    const name = normalizeName(entry);
    if (!isDnsName(name)) warnings.push(`localCa.hosts 忽略非法名称：${entry}`);
    else if (!validLocalHosts.includes(name)) validLocalHosts.push(name);
  }
  // Browsers reject leaf certificates valid for more than 398 days. Accept
  // larger values so an existing config keeps loading, but clamp and warn.
  let leafDays = integer(localRaw.leafDays, 397, 1, 3970, 'localCa.leafDays', errors);
  if (leafDays > 397) {
    warnings.push(`localCa.leafDays=${leafDays} 超过浏览器 398 天上限，已收敛为 397`);
    leafDays = 397;
  }
  const localRenewBeforeDays = integer(localRaw.renewBeforeDays, 30, 0, 365, 'localCa.renewBeforeDays', errors);
  if (localRenewBeforeDays >= leafDays) {
    warnings.push('localCa.renewBeforeDays 不小于 leafDays，站点证书每次启动都会重签');
  }
  const localCa = {
    enabled: localEnabled,
    commonName: str(localRaw.commonName, DEFAULT_CONFIG.localCa.commonName),
    organization: str(localRaw.organization, DEFAULT_CONFIG.localCa.organization),
    hosts: validLocalHosts,
    rootDays: integer(localRaw.rootDays, 3650, 30, 7300, 'localCa.rootDays', errors),
    leafDays,
    renewBeforeDays: localRenewBeforeDays,
  };

  const acmeRaw = object(source.acme);
  const dnsRaw = object(acmeRaw.dns);
  const domains = [];
  for (const entry of list(acmeRaw.domains)) {
    const name = normalizeName(entry);
    if (isIpLiteral(name)) {
      warnings.push(`acme.domains 不接受 IP（${name}），已忽略；IP 访问由本地 CA 覆盖`);
      continue;
    }
    if (!isDnsName(name)) {
      warnings.push(`acme.domains 忽略非法域名：${name}`);
      continue;
    }
    if (!domains.includes(name)) domains.push(name);
  }
  const zone = normalizeName(dnsRaw.zone);
  if (zone && !isDnsName(zone)) errors.push('acme.dns.zone 不是合法域名');
  for (const name of domains) {
    if (zone && name !== zone && !name.endsWith(`.${zone}`)) {
      warnings.push(`域名 ${name} 不在 zone ${zone} 内，DNS-01 记录将无法创建`);
    }
  }
  const email = str(acmeRaw.email, '');
  if (acmeRaw.enabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    warnings.push('acme.email 缺失或无效，ACME 不会启动');
  }
  if (mode === 'files' && boolean(acmeRaw.enabled, false)) {
    warnings.push('publicCert.mode=files 时不会运行 ACME；需要自动签发请把 mode 改成 acme');
  }
  const acmeUsable = Boolean(
    boolean(acmeRaw.enabled, false) &&
      mode !== 'files' &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
      domains.length > 0 &&
      boolean(acmeRaw.agreeTos, false),
  );
  if (!acmeUsable && boolean(acmeRaw.enabled, false)) {
    warnings.push('ACME 配置不完整（email/domains/agreeTos），将只使用本地/已有证书');
  }
  const acme = {
    enabled: boolean(acmeRaw.enabled, false),
    usable: acmeUsable,
    staging: boolean(acmeRaw.staging, true),
    email,
    domains,
    agreeTos: boolean(acmeRaw.agreeTos, false),
    renewBeforeDays: integer(acmeRaw.renewBeforeDays, 30, 1, 90, 'acme.renewBeforeDays', errors),
    checkIntervalHours: integer(acmeRaw.checkIntervalHours, 6, 1, 168, 'acme.checkIntervalHours', errors),
    propagationTimeoutSec: integer(acmeRaw.propagationTimeoutSec, 180, 30, 600, 'acme.propagationTimeoutSec', errors),
    propagationDelaySec: integer(acmeRaw.propagationDelaySec, 15, 0, 300, 'acme.propagationDelaySec', errors),
    dns: {
      provider: str(dnsRaw.provider, 'tencent').toLowerCase(),
      zone,
      credentialsFile: resolvePath(str(dnsRaw.credentialsFile, ''), dataDir),
      secretIdRef: str(dnsRaw.secretIdRef, 'TENCENT_DNSPOD_SECRET_ID'),
      secretKeyRef: str(dnsRaw.secretKeyRef, 'TENCENT_DNSPOD_SECRET_KEY'),
      recordLine: str(dnsRaw.recordLine, '默认'),
      ttl: integer(dnsRaw.ttl, 600, 60, 86400, 'acme.dns.ttl', errors),
      endpoint: str(dnsRaw.endpoint, 'https://dnspod.tencentcloudapi.com').replace(/\/+$/, ''),
    },
  };
  if (acme.dns.provider !== 'tencent') {
    warnings.push('acme.dns.provider 目前只实现 tencent，其他值不会启动 ACME');
    acme.usable = false;
  }

  const proxyRaw = object(source.proxy);
  const proxy = {
    keepAlive: boolean(proxyRaw.keepAlive, true),
    connectTimeoutMs: integer(proxyRaw.connectTimeoutMs, 10000, 1000, 120000, 'proxy.connectTimeoutMs', errors),
    maxConnections: integer(proxyRaw.maxConnections, 512, 16, 10000, 'proxy.maxConnections', errors),
    addSecureCookie: boolean(proxyRaw.addSecureCookie, true),
  };

  const config = {
    listen: { host: listenHost, port: listenPort },
    upstream: { host: upstreamHost, port: upstreamPort, protocol: upstreamProtocol },
    dataDir,
    publicCert: { mode, certFile, keyFile, watchIntervalSec },
    localCa,
    acme,
    proxy,
  };

  return { config, errors, warnings };
}

export function publicConfigSummary(config) {
  return {
    listen: config.listen,
    upstream: config.upstream,
    dataDir: config.dataDir,
    publicCert: {
      mode: config.publicCert.mode,
      certFile: config.publicCert.certFile ? path.basename(config.publicCert.certFile) : '',
      keyFile: config.publicCert.keyFile ? path.basename(config.publicCert.keyFile) : '',
    },
    localCa: {
      enabled: config.localCa.enabled,
      hosts: config.localCa.hosts,
      leafDays: config.localCa.leafDays,
    },
    acme: {
      enabled: config.acme.enabled,
      usable: config.acme.usable,
      staging: config.acme.staging,
      email: config.acme.email,
      domains: config.acme.domains,
      renewBeforeDays: config.acme.renewBeforeDays,
      checkIntervalHours: config.acme.checkIntervalHours,
      dns: {
        provider: config.acme.dns.provider,
        zone: config.acme.dns.zone,
        credentialsFile: config.acme.dns.credentialsFile ? path.basename(config.acme.dns.credentialsFile) : '',
        secretIdRef: config.acme.dns.secretIdRef,
        secretKeyRef: config.acme.dns.secretKeyRef,
        endpoint: config.acme.dns.endpoint,
      },
    },
    proxy: config.proxy,
  };
}
