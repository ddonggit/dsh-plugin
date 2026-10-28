/**
 * Host half of dsh-mobile.
 *
 * Two independent jobs:
 *   1. serve the Service Worker script (needed for notifications on Android,
 *      where `new Notification()` is not allowed) at a plugin path and claim the
 *      root scope via the Service-Worker-Allowed header;
 *   2. deliver task-completion notifications from the host process to whatever
 *      chat channels the user configured, so a closed browser, a sleeping phone
 *      or a laptop that is off do not lose the event.
 *
 * Configuration comes from this bundle's `cordis.patch.yml`; anything secret or
 * deployment-specific lives in `$DSH_HOME/dsh-mobile/settings.json` (0600,
 * hot-reloaded), which keeps the profile patch untouched.
 */

import { activeChannels, mergeNotifyConfig, redact } from './lib/notify/config.js';
import { createDispatcher } from './lib/notify/dispatcher.js';
import {
  applyHostPatch,
  browserSettingDefaults,
  hostSettingDefaults,
  pickBrowserSettings,
  pickHostSettings,
  redactPatch,
} from './lib/notify/host-settings.js';
import { createFeed } from './lib/notify/feed.js';
import { registerRoutes } from './lib/notify/routes.js';
import {
  appendLog,
  ensureDir,
  ensureFeedKey,
  loadSettings,
  pluginDir,
  readSettingsDocument,
  watchSettings,
} from './lib/notify/store.js';

const SW_PATH = '/plugins/dsh-mobile/sw.js';
const SW_SOURCE = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = (event.notification.data || {}).sessionId;
  const url = new URL('/', self.location.origin);
  if (sessionId) url.hash = 'session=' + encodeURIComponent(sessionId);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of wins) {
      try { await client.focus(); } catch {}
      client.postMessage({ type: 'dsh-mobile:open-session', sessionId });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
`;

export const inject = ['webServer', 'sessions'];

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
    // Fall through to the environment.
  }
  return process.env.DSH_HOME || `${process.env.HOME || '/root'}/.dsh`;
}

/** Port of the HTTPS entry point, derived from baseUrl when the user set one. */
function httpsPortOf(baseUrl) {
  if (!baseUrl) return 3088;
  try {
    const port = Number.parseInt(new URL(baseUrl).port, 10);
    return Number.isFinite(port) && port > 0 ? port : 3088;
  } catch {
    return 3088;
  }
}

export function apply(ctx, rawConfig) {
  const logger = makeLogger(ctx);
  const homePath = resolveHome(ctx);
  let dir;
  try {
    dir = ensureDir(pluginDir(homePath));
  } catch (error) {
    logger.warn(`[dsh-mobile] 无法创建数据目录，通知功能已禁用：${error?.message ?? error}`);
  }

  // Service Worker: unchanged behaviour, served from the plugin path.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: SW_PATH,
      handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
          'service-worker-allowed': '/',
        });
        res.end(SW_SOURCE);
      },
    }),
  );

  if (!dir) return;

  const log = (line) => appendLog(dir, line);
  const feedKey = ensureFeedKey(dir);
  let config = mergeNotifyConfig(rawConfig, loadSettings(dir, logger));
  const getConfig = () => config;
  const feed = createFeed();

  const dispatcher = createDispatcher({ ctx, logger, getConfig, feed, log });

  /**
   * Host-side auto-answer, readable and writable from the settings page.
   *
   * `write` merges the four fields into the existing settings.json (channel
   * secrets live in the same file) and applies them immediately — the settings
   * watcher would otherwise reload a second later, and the POST response would
   * describe a state the host is not in yet.
   */
  // `browserSettings` is not part of the dispatcher's normalized config (the
  // dispatcher never reads it), so it is read straight from the stored document.
  // Keeping it out of `normalizeNotifyConfig` is what keeps every other config
  // field byte-for-byte unchanged.
  const storedBrowserSettings = () => {
    const read = readSettingsDocument(dir);
    if (!read.ok) return null;
    const document = read.document;
    const notify = document.notify && typeof document.notify === 'object' ? document.notify : document;
    return notify.browserSettings && typeof notify.browserSettings === 'object' ? notify.browserSettings : null;
  };
  const hostSettings = {
    read: () => ({ ...pickHostSettings(config), browserSettings: pickBrowserSettings(storedBrowserSettings()) }),
    defaults: () => ({ ...hostSettingDefaults(), browserSettings: browserSettingDefaults() }),
    stored: storedBrowserSettings,
    write(patch) {
      applyHostPatch(dir, patch, logger);
      config = mergeNotifyConfig(rawConfig, loadSettings(dir, logger));
      log(`host auto-answer updated ${JSON.stringify(redactPatch(patch))}`);
      return hostSettings.read();
    },
  };

  const meta = () => {
    const current = getConfig();
    const { ready, missing } = activeChannels(current);
    return {
      enabled: current.enabled,
      events: current.events,
      baseUrl: current.baseUrl,
      httpsPort: httpsPortOf(current.baseUrl),
      // Host-side auto-answer: what the host will do when nobody answers.
      askAutoAnswer: current.askAutoAnswer,
      askTimeoutMs: current.askTimeoutMs,
      approvalAutoAction: current.approvalAutoAction,
      questionAutoPick: current.questionAutoPick,
      channels: ready,
      incomplete: missing,
      summary: Object.fromEntries(
        Object.entries(current.channels).map(([name, channel]) => [
          name,
          {
            enabled: Boolean(channel?.enabled),
            target: redact(
              channel?.webhook || channel?.botToken || channel?.sendKey || channel?.topic || channel?.url || '',
            ),
          },
        ]),
      ),
    };
  };

  ctx.effect(() => dispatcher.attach(), 'dsh-mobile: notify dispatcher');
  ctx.effect(
    () =>
      registerRoutes({
        ctx,
        logger,
        webServer: ctx.webServer,
        feed,
        getFeedKey: () => feedKey,
        dispatcher,
        meta,
        hostSettings,
      }),
    'dsh-mobile: notify routes',
  );
  ctx.effect(
    () =>
      watchSettings(
        dir,
        (next) => {
          config = mergeNotifyConfig(rawConfig, next);
          log('config reloaded from settings.json');
          const { ready } = activeChannels(config);
          logger.info(`[dsh-mobile] 通知设置已重载，启用渠道：${ready.join(', ') || '无'}`);
        },
        logger,
      ),
    'dsh-mobile: settings watcher',
  );

  const { ready, missing } = activeChannels(config);
  log(
    `started channels=${ready.join(',') || 'none'} incomplete=${missing.map((item) => item.name).join(',') || 'none'} key=****${feedKey.slice(-4)}`,
  );
  logger.info(
    `[dsh-mobile] 通知已${config.enabled ? '启用' : '停用'}；渠道：${ready.join(', ') || '无'}` +
      (missing.length > 0 ? `；配置不完整：${missing.map((item) => item.name).join(', ')}` : ''),
  );
}
