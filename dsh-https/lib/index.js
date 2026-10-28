import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { registerApi } from './api.js';
import { CertStore, loadPublicCertFiles } from './certs.js';
import { normalizeConfig, publicConfigSummary } from './config.js';
import { createAcmeManager } from './acme.js';
import { HttpsProxyServer } from './https-server.js';
import { registerPublicRoutes } from './public-routes.js';
import {
  MODES,
  loadSettingsSync,
  mergeRawConfig,
  sanitizeSettings,
  saveSettings,
} from './settings.js';
import { loadSecretsSync, saveSecrets, maskSecret } from './secret-store.js';
import { isPlainObject, sleep, sanitizeError, statMode } from './util.js';

export const name = 'dsh-https';
export const inject = ['connection', 'webServer'];

const VERSION = '0.2.0';
const START_RETRIES = 6;

function makeLogger(ctx) {
  const base = ctx.logger;
  if (base && typeof base.info === 'function') {
    return {
      info: (...args) => base.info(...args),
      warn: (...args) => base.warn(...args),
      error: (...args) => base.error(...args),
    };
  }
  return {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

function resolveHome(ctx) {
  try {
    const service = ctx.get('dshHomePath');
    if (typeof service === 'function') {
      const value = service();
      if (value) return value;
    }
  } catch {
    // Fall back to environment/home below.
  }
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function parseCredentialsText(text) {
  const out = {};
  const trimmed = String(text).trim();
  if (!trimmed) return out;
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed);
      for (const [key, value] of Object.entries(json)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    } catch {
      return out;
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    const separator = clean.indexOf('=');
    if (separator < 0) continue;
    const key = clean.slice(0, separator).trim();
    let value = clean.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function pickCredential(map, names) {
  for (const name of names) {
    if (typeof map[name] === 'string' && map[name]) return map[name];
  }
  return '';
}

async function resolveCredentials(ctx, config, logger) {
  let secretId = '';
  let secretKey = '';
  // Keys saved on the settings page win: the user just typed them there, and
  // the file is 0600. Fall back to the credentials file, the credentials
  // service and the environment below.
  if (config.dataDir) {
    const stored = loadSecretsSync(config.dataDir, logger);
    secretId = stored.secretId;
    secretKey = stored.secretKey;
  }
  if (!secretId || !secretKey) {
    if (config.acme.dns.credentialsFile) {
      try {
        const info = await statMode(config.acme.dns.credentialsFile);
        if (info && (info.mode & 0o077) !== 0) {
          logger.warn?.(`[dsh-https] 凭据文件权限过宽（${info.mode.toString(8)}），建议 chmod 600`);
        }
        const map = parseCredentialsText(await readFile(config.acme.dns.credentialsFile, 'utf8'));
        secretId = pickCredential(map, [
          config.acme.dns.secretIdRef,
          'TENCENT_DNSPOD_SECRET_ID',
          'TENCENT_SECRET_ID',
          'SAVED_Tencent_SecretId',
          'SECRET_ID',
          'secretId',
        ]);
        secretKey = pickCredential(map, [
          config.acme.dns.secretKeyRef,
          'TENCENT_DNSPOD_SECRET_KEY',
          'TENCENT_SECRET_KEY',
          'SAVED_Tencent_SecretKey',
          'SECRET_KEY',
          'secretKey',
        ]);
      } catch (error) {
        logger.warn?.(`[dsh-https] 读取凭据文件失败：${sanitizeError(error)}`);
      }
    }
  }

  if (!secretId || !secretKey) {
    try {
      const credentials = ctx.get('credentials');
      if (credentials?.resolve) {
        const id = await credentials.resolve(config.acme.dns.secretIdRef);
        const key = await credentials.resolve(config.acme.dns.secretKeyRef);
        secretId = secretId || id?.value || '';
        secretKey = secretKey || key?.value || '';
      }
    } catch {
      // Credentials service is optional.
    }
  }
  if (!secretId) secretId = process.env[config.acme.dns.secretIdRef] || '';
  if (!secretKey) secretKey = process.env[config.acme.dns.secretKeyRef] || '';
  return { secretId, secretKey };
}

export function apply(ctx, rawConfig) {
  const logger = makeLogger(ctx);
  const homePath = resolveHome(ctx);
  let webServerPort;
  try {
    webServerPort = ctx.get('webServer')?.port;
  } catch {
    webServerPort = undefined;
  }
  const normalized = normalizeConfig(rawConfig, { homePath, upstreamPort: webServerPort });
  const { config } = normalized;
  // Settings the user changed on the settings page win over the profile's
  // defaults; they live in <dataDir>/settings.json so a restart keeps them.
  const settings = loadSettingsSync(config.dataDir, logger);
  const secrets = loadSecretsSync(config.dataDir, logger);  const mergedSource = mergeRawConfig(rawConfig, settings);
  const merged = normalizeConfig(mergedSource, { homePath, upstreamPort: webServerPort });
  // Re-apply the runtime overrides on top of whatever the profile merges in.
  Object.assign(config.publicCert, merged.config.publicCert);
  Object.assign(config.acme, merged.config.acme);
  Object.assign(config.acme.dns, merged.config.acme.dns);
  const warnings = [...merged.warnings];
  const errors = [...merged.errors];
  // Values the settings page owns. They live in <dataDir>/settings.json plus the
  // 0600 Tencent keypair file, so a restart keeps whatever the user chose.
  const runtime = { settings, secrets };
  const seenWarnings = new Set(warnings);
  // Runtime warnings can repeat on every hot-reload tick; keep the status page
  // readable instead of growing the array without bound.
  const addWarning = (message) => {
    if (!message || seenWarnings.has(message) || warnings.length >= 50) return;
    seenWarnings.add(message);
    warnings.push(message);
    logger.warn?.(`[dsh-https] ${message}`);
  };

  const state = {
    version: VERSION,
    started: false,
    listener: {
      running: false,
      host: config.listen.host,
      port: config.listen.port,
      actualPort: null,
      error: null,
    },
    error: null,
    errors,
    warnings,
    certStore: null,
    server: null,
    acme: null,
    status() {
      const certs = this.certStore?.status?.() ?? {
        public: { available: false, error: null },
        local: { enabled: config.localCa.enabled, available: false, error: null },
        defaultSource: null,
      };
      const acme = this.acme?.status?.() ?? {
        enabled: config.acme.enabled,
        usable: config.acme.usable,
        phase: config.acme.enabled ? 'starting' : 'disabled',
        staging: config.acme.staging,
        domains: config.acme.domains,
        nextAttempt: null,
        lastError: null,
      };
      const port = this.server?.port ?? config.listen.port;
      const hosts = [];
      for (const item of certs.public?.san || []) {
        if (item.type === 'dns' && !item.value.startsWith('*.')) hosts.push(item.value);
      }
      for (const item of certs.local?.sans || []) {
        if (item.type === 'dns' && !item.value.startsWith('*.')) hosts.push(item.value);
      }
      const urls = [...new Set(hosts)].map((host) => `https://${host.includes(':') ? `[${host}]` : host}:${port}/`);
      return {
        ok: !this.error && errors.length === 0,
        version: VERSION,
        started: this.started,
        error: this.error,
        errors,
        warnings,
        listener: { ...this.listener, actualPort: port },
        upstream: config.upstream,
        publicUrls: { https: urls, caPagePath: '/dsh-https/' },
        certs,
        acme,
        settings: this.settingsStatus(),
        config: publicConfigSummary(config),
      };
    },
    settingsStatus() {
      return {
        mode: config.publicCert.mode,
        modeEditable: true,
        files: {
          certFile: config.publicCert.certFile || '',
          keyFile: config.publicCert.keyFile || '',
          watchIntervalSec: config.publicCert.watchIntervalSec,
        },
        acme: {
          enabled: config.acme.enabled,
          staging: config.acme.staging,
          email: config.acme.email,
          domains: config.acme.domains,
          zone: config.acme.dns.zone,
        },
        credentials: {
          configured: Boolean(runtime.secrets.secretId && runtime.secrets.secretKey),
          secretIdHint: maskSecret(runtime.secrets.secretId),
          writable: true,
        },
        restartRequired: false,
      };
    },
    acmeUsable() {
      return Boolean(config.acme.enabled && config.acme.usable && this.acme);
    },
    acmeError() {
      if (!config.acme.enabled) return 'ACME 未启用';
      if (!config.acme.usable) {
        return this.acme?.status?.().lastError || 'ACME 配置不完整（email/domains/agreeTos）';
      }
      return this.acme?.status?.().lastError || null;
    },
    caPem() {
      return this.certStore?.caPem?.() ?? null;
    },
  };

  const disposers = [];
  // Actions the HTTP API calls. They run against the live config object, so a
  // settings change takes effect without a restart.
  const actions = {
    acme: null,
    saveSettings: async (input) => {
      const body = isPlainObject(input) ? input : {};
      const patch = isPlainObject(body.acme) ? body.acme : {};
      const next = sanitizeSettings({
        mode: typeof body.mode === 'string' ? body.mode : config.publicCert.mode,
        acme: { ...runtime.settings.acme, ...patch },
      });
      if (!MODES.has(next.mode)) throw new Error('证书模式只能是 files 或 acme');
      const candidate = normalizeConfig(mergeRawConfig(rawConfig, next), { homePath, upstreamPort: webServerPort });
      if (candidate.errors.length > 0) throw new Error(candidate.errors.join('；'));
      if (next.mode === 'acme' && !candidate.config.acme.usable) {
        throw new Error('自动证书配置不完整：需要有效的邮箱和域名，且 DNS 提供商为 tencent');
      }
      // Apply the certificate first, persist second: a broken certificate path
      // must not leave a saved mode that cannot start on the next launch.
      const previous = { publicCert: { ...config.publicCert }, acme: { ...config.acme }, dns: { ...config.acme.dns } };
      Object.assign(config.publicCert, candidate.config.publicCert);
      Object.assign(config.acme, candidate.config.acme);
      Object.assign(config.acme.dns, candidate.config.acme.dns);
      try {
        if (state.certStore) {
          await state.certStore.applyMode(config.publicCert.mode);
        }
      } catch (error) {
        Object.assign(config.publicCert, previous.publicCert);
        Object.assign(config.acme, previous.acme);
        config.acme.dns = previous.dns;
        throw error;
      }
      await saveSettings(config.dataDir, next);
      runtime.settings = next;
      for (const warning of candidate.warnings) addWarning(warning);
      if (config.publicCert.mode === 'files') {
        stopFileWatcher();
        startFileWatcher();
      } else {
        stopFileWatcher();
      }
      if (config.acme.enabled && config.acme.usable) {
        state.acme?.resume?.();
      } else {
        state.acme?.stop?.();
      }
      return { saved: true, mode: config.publicCert.mode, restartRequired: false };
    },
    saveCredentials: async (input) => {
      const body = isPlainObject(input) ? input : {};
      const saved = await saveSecrets(config.dataDir, body, runtime.secrets);
      runtime.secrets = { secretId: saved.secretId, secretKey: saved.secretKey };
      // A pending failure was probably "no API key": retry once, soon.
      if (config.acme.enabled && state.acme) state.acme.resume(3000);
      return {
        saved: true,
        credentials: {
          configured: Boolean(runtime.secrets.secretId && runtime.secrets.secretKey),
          secretIdHint: maskSecret(runtime.secrets.secretId),
        },
      };
    },
  };
  try {
    disposers.push(...registerApi({ ctx, state, actions }));
  } catch (error) {
    addWarning(`状态 API 注册失败：${sanitizeError(error)}`);
  }
  try {
    disposers.push(...registerPublicRoutes({ ctx, state }));
  } catch (error) {
    addWarning(`CA 引导页注册失败：${sanitizeError(error)}`);
  }

  let watchTimer = null;
  let upstreamTimer = null;
  let disposed = false;
  let startPromise = null;

  // Hot-reload of the certificate files. It runs only in files mode; a runtime
  // switch to files calls it again once the new paths are in place.
  const stopFileWatcher = () => {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  };
  const startFileWatcher = () => {
    if (watchTimer) return;
    if (config.publicCert.mode !== 'files' || !(config.publicCert.watchIntervalSec > 0)) return;
    let signature = '';
    const tick = async () => {
      try {
        const certStat = await statMode(config.publicCert.certFile);
        const keyStat = await statMode(config.publicCert.keyFile);
        const next = `${certStat?.mtimeMs ?? 0}:${certStat?.size ?? 0}:${keyStat?.mtimeMs ?? 0}:${keyStat?.size ?? 0}`;
        if (!signature) {
          signature = next;
          return;
        }
        if (next === signature) return;
        signature = next;
        const pair = await loadPublicCertFiles(config.publicCert, logger);
        state.certStore?.setPublicPair(pair);
        logger.info?.(`[dsh-https] 已热加载证书文件：${path.basename(config.publicCert.certFile)}`);
      } catch (error) {
        addWarning(`证书文件热加载失败：${sanitizeError(error)}`);
      }
    };
    void tick();
    watchTimer = setInterval(() => void tick(), config.publicCert.watchIntervalSec * 1000);
    watchTimer.unref?.();
  };

  const start = async () => {
    if (errors.length > 0) {
      state.error = errors.join('；');
      state.listener.error = state.error;
      logger.error?.(`[dsh-https] 配置错误：${state.error}`);
      return;
    }

    const certStore = new CertStore({ config, logger });
    state.certStore = certStore;
    const server = new HttpsProxyServer({ config, certStore, logger });
    state.server = server;
    const acme = createAcmeManager({
      config,
      certStore,
      logger,
      credentials: () => resolveCredentials(ctx, config, logger),
      onCertificate: () => {
        server.reloadDefault();
      },
    });
    state.acme = acme;
    actions.acme = acme;
    certStore.onUpdate = () => server.reloadDefault();

    try {
      await certStore.init();
    } catch (error) {
      state.error = sanitizeError(error);
      state.listener.error = state.error;
      logger.error?.(`[dsh-https] TLS 证书初始化失败：${state.error}`);
      return;
    }

    let lastError = null;
    for (let attempt = 0; attempt < START_RETRIES; attempt += 1) {
      try {
        await server.start();
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE' || attempt === START_RETRIES - 1) break;
        await sleep(500);
      }
    }
    if (lastError) {
      state.error = sanitizeError(lastError);
      state.listener.error = state.error;
      logger.error?.(`[dsh-https] HTTPS 监听失败：${state.error}`);
      return;
    }

    state.started = true;
    state.listener.running = true;
    state.listener.actualPort = server.port;

    // The DSH webserver can bind its port after this plugin applies (its port
    // is undefined until then). Learn the real port from the live service and
    // keep it in sync, unless the profile pinned upstream.port explicitly.
    const pinnedUpstreamPort = rawConfig?.upstream?.port;
    if (pinnedUpstreamPort === undefined || pinnedUpstreamPort === null || pinnedUpstreamPort === '') {
      const syncUpstreamPort = () => {
        let livePort;
        try {
          livePort = Number(ctx.get('webServer')?.port);
        } catch {
          return true;
        }
        if (!Number.isInteger(livePort) || livePort <= 0) return false;
        if (livePort === config.listen.port) {
          addWarning(`上游端口与 listen.port 相同（${livePort}），请修改其中之一`);
          return true;
        }
        if (livePort !== config.upstream.port) {
          config.upstream.port = livePort;
          logger.info?.(`[dsh-https] 上游端口取自 DSH Web 监听：${livePort}`);
        }
        return true;
      };
      if (!syncUpstreamPort()) {
        let attempts = 0;
        upstreamTimer = setInterval(() => {
          attempts += 1;
          if (syncUpstreamPort() || attempts >= 300) {
            clearInterval(upstreamTimer);
            upstreamTimer = null;
          }
        }, 1000);
        upstreamTimer.unref?.();
      }
    }

    logger.info?.(`[dsh-https] HTTPS 已监听 ${config.listen.host}:${server.port}，上游 ${config.upstream.protocol}://${config.upstream.host}:${config.upstream.port}`);

    try {
      await acme.start();
    } catch (error) {
      addWarning(`ACME 启动失败：${sanitizeError(error)}`);
    }

    if (config.publicCert.mode === 'files' && config.publicCert.watchIntervalSec > 0) {
      startFileWatcher();
    }
  };

  startPromise = start().catch((error) => {
    state.error = sanitizeError(error);
    state.listener.error = state.error;
    logger.error?.(`[dsh-https] 启动失败：${state.error}`);
  });

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    stopFileWatcher();
    if (upstreamTimer) clearInterval(upstreamTimer);
    upstreamTimer = null;
    state.acme?.stop?.();
    try {
      await startPromise;
    } catch {
      // start() already records failures.
    }
    await state.server?.stop?.();
    state.started = false;
    state.listener.running = false;
    for (const entry of disposers.reverse()) {
      try {
        entry?.();
      } catch {
        // Ignore cleanup failures.
      }
    }
  };

  // Cordis owns plugin lifetime: route registrations created via ctx.effect are
  // disposed automatically, but the raw TLS listener is not. Tie the listener
  // teardown to the same lifecycle so HMR/disable/uninstall cannot leak a port.
  ctx.effect(() => () => {
    void dispose();
  }, 'dsh-https lifecycle');

  return dispose;
}
