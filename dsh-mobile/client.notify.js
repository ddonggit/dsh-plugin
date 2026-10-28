/**
 * dsh-mobile: browser-side notifications.
 *
 * Three delivery paths, in order of preference:
 *   1. the native shell bridge (`window.DshNative`), which works on plain HTTP;
 *   2. a Service Worker notification on a secure context;
 *   3. the backup webhook, which needs no permission at all.
 *
 * Plus the pieces that keep those honest: the running->idle watcher, the host
 * feed catch-up for a tab that slept, and the permission pill in shell.overlay.
 *
 * Deciding a stalled approval or question is deliberately *not* done here: that
 * lives in the host dispatcher (`lib/notify/dispatcher.js`), which also works
 * with every browser closed.
 *
 * Every entry point degrades instead of throwing: an absent shell method, an
 * unavailable host route or a denied permission disables one path only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  chunk: 'client.notify.js',

  factory(require) {
    const React = require('react');

const SW_PATH = '/plugins/dsh-mobile/sw.js';
const HINT_DISMISSED_KEY = 'dsh-mobile:hint-dismissed';
const FEED_SINCE_KEY = 'dsh-mobile:feed-since';
const FEED_BOOT_KEY = 'dsh-mobile:feed-boot';
const DEFAULT_HTTPS_PORT = 3088;

/**
 * Browser-side notification settings.
 *
 * The host half keeps its own copy in `$DSH_HOME/dsh-mobile/settings.json`, but
 * that half only loads on a restart. These live in localStorage so the whole
 * browser feature — toast and backup webhook — works from the client alone.
 */
const SETTINGS_KEY = 'dsh-mobile:notify';
const HOST_SETTINGS_PATH = '/api/dsh-mobile/host-settings';
const HOST_SETTINGS_TIMEOUT = 8000;
const BROWSER_WEBHOOK_KINDS = ['auto', 'feishu', 'dingtalk', 'serverchan', 'generic'];

const DEFAULT_SETTINGS = {
  browser: true,
  done: true,
  ask: true,
  webhook: { enabled: false, kind: 'feishu', url: '' },
};

/**
 * Last-resort copy for private mode, where localStorage rejects every write.
 * Reads still prefer storage so another tab's edit is picked up immediately.
 */
let settingsFallback = null;
const settingsListeners = new Set();
/** In-flight host sync, so opening the settings page cannot race startup. */
let hostSync = null;

/**
 * Infer the webhook dialect from the URL so pasting a hook URL is enough.
 *
 * An explicit choice in settings still wins: `auto` only fills the gap where
 * the host name does not say anything.
 */
function inferWebhookKind(url) {
  const lower = url.toLowerCase();
  if (lower.includes('open.feishu.cn') || lower.includes('open.larksuite.com')) return 'feishu';
  if (lower.includes('oapi.dingtalk.com')) return 'dingtalk';
  if (lower.includes('sctapi.ftqq.com') || lower.includes('sct.ftqq.com')) return 'serverchan';
  return 'generic';
}

/**
 * The browser settings as they are stored: `kind` is the user's choice (`auto`
 * included), never the dialect inferred at read time.
 */
function settingsRecord(settings) {
  const webhook = settings?.webhook && typeof settings.webhook === 'object' ? settings.webhook : {};
  const choice = BROWSER_WEBHOOK_KINDS.includes(webhook.kindChoice)
    ? webhook.kindChoice
    : BROWSER_WEBHOOK_KINDS.includes(webhook.kind)
      ? webhook.kind
      : 'auto';
  return {
    browser: settings?.browser !== false,
    done: settings?.done !== false,
    ask: settings?.ask !== false,
    webhook: {
      enabled: webhook.enabled === true,
      kind: choice,
      url: typeof webhook.url === 'string' ? webhook.url.trim() : '',
    },
  };
}

/**
 * Read settings synchronously: notification delivery calls this on its hot
 * path, so this must never wait for the host. Host values are copied into this
 * cache by {@link syncHostSettings}; a failed sync simply leaves the cache.
 */
function readSettings() {
  let stored = null;
  try {
    stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  const source = stored && typeof stored === 'object' ? stored : (settingsFallback ?? {});
  const webhook = webhookOf(source);
  const url = typeof webhook.url === 'string' ? webhook.url.trim() : '';
  const chosen = BROWSER_WEBHOOK_KINDS.includes(webhook.kind)
    ? webhook.kind
    : BROWSER_WEBHOOK_KINDS.includes(webhook.kindChoice)
      ? webhook.kindChoice
      : 'auto';
  return {
    browser: source.browser !== false,
    done: source.done !== false,
    ask: source.ask !== false,
    webhook: {
      enabled: webhook.enabled === true,
      kindChoice: chosen,
      kind: chosen === 'auto' ? inferWebhookKind(url) : chosen,
      url,
    },
  };
}

function webhookOf(source) {
  return source.webhook && typeof source.webhook === 'object' ? source.webhook : {};
}

/** Write one record to memory + localStorage and tell every listener. */
function storeSettings(record) {
  settingsFallback = record;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(record));
  } catch {
    // Private mode: the in-memory value still applies for this page.
  }
  for (const listener of settingsListeners) {
    try {
      listener(readSettings());
    } catch {}
  }
}

function subscribeSettings(listener) {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

async function hostSettingsRequest(method, body) {
  const init = { method, credentials: 'same-origin', cache: 'no-store' };
  const signal = timeoutSignal(HOST_SETTINGS_TIMEOUT);
  if (signal) init.signal = signal;
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(HOST_SETTINGS_PATH, init);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error ? String(payload.error) : `HTTP ${response.status}`);
  }
  return payload;
}

/** The raw record this browser stored before any host sync, or null. */
function localSettingsRecord() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Fields the host has never stored but this browser has.
 *
 * The host reports its raw `browserSettings` (null when absent), so "the host
 * chose the default" and "the host has no value" stay distinguishable. Only
 * missing fields are copied: an existing host value always wins.
 */
function migrationPatch(local, hostStored) {
  const patch = {};
  if (!local || typeof local !== 'object') return patch;
  const host = hostStored && typeof hostStored === 'object' && !Array.isArray(hostStored) ? hostStored : {};
  for (const key of ['browser', 'done', 'ask']) {
    if (typeof local[key] === 'boolean' && !(key in host)) patch[key] = local[key];
  }
  const hostWebhook = host.webhook && typeof host.webhook === 'object' ? host.webhook : {};
  const localWebhook = local.webhook && typeof local.webhook === 'object' ? local.webhook : {};
  const webhook = {};
  if (typeof localWebhook.enabled === 'boolean' && !('enabled' in hostWebhook)) webhook.enabled = localWebhook.enabled;
  // Old caches store both the user's choice (`kindChoice`, may be `auto`) and
  // the dialect inferred at read time (`kind`). `kind` alone is not the user's
  // choice, so prefer `kindChoice` and keep `auto` verbatim; only fall back to
  // `kind` when there is no valid choice.
  if (!('kind' in hostWebhook)) {
    const chosen = BROWSER_WEBHOOK_KINDS.includes(localWebhook.kindChoice)
      ? localWebhook.kindChoice
      : BROWSER_WEBHOOK_KINDS.includes(localWebhook.kind)
        ? localWebhook.kind
        : null;
    if (chosen) webhook.kind = chosen;
  }
  if (typeof localWebhook.url === 'string' && !('url' in hostWebhook)) webhook.url = localWebhook.url.trim();
  if (Object.keys(webhook).length > 0) patch.webhook = webhook;
  return patch;
}

/** Copy the host's browser settings into the local cache. */
function cacheBrowserSettings(value) {
  if (!value || typeof value !== 'object') return;
  storeSettings(settingsRecord(value));
}

/**
 * Pull the host's browser settings, migrate values the host has never seen,
 * and cache the result. Runs at startup and whenever the settings page opens;
 * any failure keeps the local cache and stays silent.
 */
function syncHostSettings() {
  if (hostSync) return hostSync;
  hostSync = (async () => {
    try {
      const payload = await hostSettingsRequest('GET');
      const hostStored =
        payload.storedBrowserSettings && typeof payload.storedBrowserSettings === 'object'
          ? payload.storedBrowserSettings
          : null;
      const patch = migrationPatch(localSettingsRecord(), hostStored);
      let settings = payload.settings?.browserSettings ?? null;
      if (Object.keys(patch).length > 0) {
        try {
          const posted = await hostSettingsRequest('POST', { browserSettings: patch });
          const postedSettings = posted.settings?.browserSettings;
          if (postedSettings) {
            settings = postedSettings;
            // Only the block the host acknowledged may replace this browser's
            // record: the GET answer alone may still be the host's defaults.
            cacheBrowserSettings(settings);
          }
        } catch (error) {
          // Keep the local record. The host did not take the migration, so its
          // answer is not authoritative for the fields that were being moved.
          console.debug('[dsh-mobile] browser settings migration failed', error);
        }
      } else if (hostStored) {
        // Nothing to migrate and the host owns a block: the host wins.
        cacheBrowserSettings(settings);
      }
      return readSettings();
    } catch {
      return readSettings();
    }
  })();
  hostSync = hostSync.finally(() => {
    hostSync = null;
  });
  return hostSync;
}

/**
 * Persist a change locally first (notification delivery sees it immediately),
 * then push it to the host. A host failure keeps the local value and is
 * reported to the settings page, which shows it and lets the next sync win.
 */
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  const record = settingsRecord(next);
  storeSettings(record);
  return hostSettingsRequest('POST', { browserSettings: record }).then(
    (payload) => {
      if (payload?.settings?.browserSettings) cacheBrowserSettings(payload.settings.browserSettings);
      return { ok: true, error: '' };
    },
    (error) => {
      console.warn('[dsh-mobile] saving browser settings to the host failed', error);
      return { ok: false, error: String(error?.message ?? error) };
    },
  );
}

/**
 * Compose the backup-push body for one supported webhook dialect.
 *
 * When the host composed the notice, `message.payloads[dialect]` already holds
 * the exact payload (Feishu card, DingTalk markdown, …), so this function only
 * assembles a minimal body when that route is unavailable.
 */
function webhookBody(kind, message) {
  const preset = message.payloads?.[kind];
  if (preset) return preset;
  const text = message.text || [message.title, message.summary].filter(Boolean).join('\n');
  // Host notices already end with the link; only append it when it is missing.
  const withLink = message.link && !text.includes(message.link) ? `${text}\n${message.link}` : text;
  if (kind === 'feishu') return { msg_type: 'text', content: { text: withLink } };
  if (kind === 'dingtalk') return { msgtype: 'markdown', markdown: { title: message.title, text: message.markdown || withLink } };
  if (kind === 'serverchan') return { title: message.title, desp: message.markdown || withLink };
  return {
    source: 'dsh-mobile',
    event: message.kind ?? 'done',
    sessionId: message.sessionId ?? '',
    title: message.title,
    summary: message.summary ?? '',
    body: text,
    link: message.link ?? '',
    at: new Date().toISOString(),
  };
}

/**
 * Push one notification to the configured backup webhook.
 *
 * Deliberately fire-and-forget: a broken webhook must never surface as a UI
 * error or block the notification path it exists to back up.
 */
async function pushWebhook(message) {
  const settings = readSettings();
  const webhook = settings.webhook;
  if (!webhook.enabled || !webhook.url) return { ok: false, detail: 'disabled' };
  try {
    const isForm = webhook.kind === 'serverchan';
    const body = webhookBody(webhook.kind, message);
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: isForm ? { 'content-type': 'application/x-www-form-urlencoded' } : { 'content-type': 'text/plain;charset=UTF-8' },
      body: isForm ? new URLSearchParams(body).toString() : JSON.stringify(body),
      mode: 'cors',
      credentials: 'omit',
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    // 飞书/钉钉 report logical failures inside a 200 response.
    const text = await response.text();
    let code = 0;
    try {
      const payload = JSON.parse(text);
      const reported = payload?.code ?? payload?.StatusCode ?? payload?.errcode;
      if (typeof reported === 'number') code = reported;
    } catch {
      // Non-JSON success bodies are fine.
    }
    if (code === 0) return { ok: true, detail: 'sent' };

    // A tenant that rejects the interactive card still accepts plain text; the
    // browser half has no retry layer above this function.
    if (webhook.kind === 'feishu' && message.payloads?.feishu) {
      const plain = { msg_type: 'text', content: { text: message.text || message.title } };
      const retry = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(plain),
        mode: 'cors',
        credentials: 'omit',
      });
      if (retry.ok) return { ok: true, detail: `sent (text fallback, card code ${code})` };
    }
    return { ok: false, detail: `code ${code}` };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  }
}

/** Session link for the message body, when the current origin can host it. */
function sessionLink(sessionId) {
  if (!sessionId) return '';
  return `${window.location.origin}/#session=${sessionId}`;
}

/** Short elapsed time for the fallback line. */
function formatSpan(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${Math.max(1, total)}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** Variants that must never produce a message (turns that did not finish). */
const SILENT_VARIANTS = new Set(['aborted', 'blocked', 'interrupted', 'forked']);

/**
 * Notifications this tab already showed, keyed `${sessionId}:${kind}`.
 *
 * The host feed and the running->idle watcher observe the same events from two
 * directions. Without this registry one completion alerts twice: the second
 * banner reuses the same tag, so it replaces the first and (with `renotify`)
 * buzzes again. The feed entry is what must yield: the watcher sees the edge
 * first and has richer local context.
 */
const shownLocally = new Map();
const SHOWN_TTL_MS = 120000;

function markShown(sessionId, kind) {
  const now = Date.now();
  shownLocally.set(`${sessionId}:${kind}`, now);
  for (const [key, at] of shownLocally) {
    if (now - at > SHOWN_TTL_MS) shownLocally.delete(key);
  }
}

function shownRecently(sessionId, kind) {
  const at = shownLocally.get(`${sessionId}:${kind}`);
  return at !== undefined && Date.now() - at < SHOWN_TTL_MS;
}

const HOST_NOTICE_TIMEOUT = 700;

function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  } catch {}
  return undefined;
}

/**
 * Read the notice the host composed for this session.
 *
 * Same content the host path sends, so the backup webhook stops posting a
 * template without task information. Any failure (old host half, timeout,
 * stale notice) degrades to {@link fallbackNotice}.
 *
 * `fits` keeps an event from wearing another event's copy: the route returns the
 * last notice of the session, which may still be the previous turn's completion
 * when this one is waiting for an answer. A notice that does not describe this
 * event is treated as absent, so the caller falls back to its own copy.
 */
async function fetchHostNotice(sessionId, fits = () => true) {
  if (!sessionId) return null;
  try {
    const init = { credentials: 'same-origin', cache: 'no-store' };
    const signal = timeoutSignal(HOST_NOTICE_TIMEOUT);
    if (signal) init.signal = signal;
    const response = await fetch(`/api/dsh-mobile/notice?sessionId=${encodeURIComponent(sessionId)}`, init);
    if (!response.ok) return null;
    const payload = await response.json();
    const notice = payload?.notice;
    if (!notice || notice.sessionId !== sessionId || typeof notice.at !== 'number') return null;
    if (Date.now() - notice.at > 30000) return null;
    if (!fits(notice)) return null;
    return notice;
  } catch {
    return null;
  }
}

/** Minimal local notice for when the host route is unavailable. */
function fallbackNotice(kind, input, sessionId, t) {
  const style = kind === 'error'
    ? { emoji: '❌', word: t('kFailed') }
    : kind === 'ask'
      ? { emoji: '❓', word: t('kWaiting') }
      : { emoji: '✅', word: t('kDone') };
  const title = input.displayTitle ? `${style.emoji} ${style.word} · ${input.displayTitle}` : `${style.emoji} ${style.word}`;
  const elapsed = formatSpan(input.durationMs);
  const summary = [input.workspace, elapsed ? `${t('kElapsed')} ${elapsed}` : ''].filter(Boolean).join(' · ') || t('kEnded');
  const detail = input.detail || (kind === 'ask' ? t('askFallback') : '');
  return {
    kind,
    variant: kind === 'ask' ? 'ask' : 'done',
    sessionId,
    title,
    summary,
    text: [title, detail, summary, sessionLink(sessionId)].filter(Boolean).join('\n'),
    link: sessionLink(sessionId),
  };
}

/**
 * Native shell bridge (HarmonyOS ArkWeb and any other host that injects one).
 *
 * A shell registers a plain object on `window.DshNative` with `registerJavaScriptProxy`.
 * The whole feature below treats it as an optional accelerator: when the object or
 * one of its methods is absent — desktop browser, plain mobile Safari, an older
 * shell build — every call site falls back to the Service Worker path.
 *
 * The contract is append-only on purpose: the shell ships rarely, the web half
 * ships constantly, so the web side must be able to run ahead of the shell and
 * degrade for anything the shell does not implement yet.
 *
 * Methods (all optional, all synchronous unless stated):
 *   ready()                    -> true when the shell has its notification stack up
 *   permission()               -> 'granted' | 'denied' | 'default' | 'unsupported'
 *   requestPermission()        -> Promise<'granted'|'denied'> (may show a system dialog)
 *   notify({title, body, tag, sessionId, at}) -> boolean
 *   close({tag})               -> boolean
 *   setBadge(number)           -> boolean
 *   openSession(sessionId)     -> boolean, for notifications the shell posted itself
 *   version()                  -> string, for diagnostics
 */
function nativeBridge() {
  const bridge = window.DshNative;
  if (!bridge || typeof bridge !== 'object') return null;
  const call = (name, ...args) => {
    const fn = bridge[name];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(bridge, args);
    } catch (error) {
      console.debug(`[dsh-mobile] DshNative.${name} failed`, error);
      return undefined;
    }
  };
  const usable = call('ready');
  // A shell that exposes the object but has no working notification stack (denied
  // permission, Push Kit not configured) must not swallow the browser path.
  if (usable === false) return null;
  return { call };
}

/** Normalise the shell's permission answer into the same vocabulary as the browser. */
function nativePermission(bridge) {
  const value = bridge?.call('permission');
  if (value === 'granted' || value === 'denied' || value === 'default') return value;
  // Missing `permission()` means an early shell build: assume it can post, since
  // `ready()` already said its stack is up.
  return value === undefined && bridge ? 'granted' : 'unsupported';
}

function notificationState() {
  const bridge = nativeBridge();
  if (bridge) {
    const permission = nativePermission(bridge);
    if (permission !== 'unsupported') return permission;
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  return Notification.permission;
}

async function registerServiceWorker() {
  // Inside a shell the native path owns notifications, and a Service Worker only
  // adds an update/caching hazard on an origin the shell may reload often.
  if (nativeBridge()) return null;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    await navigator.serviceWorker.register(SW_PATH, { scope: '/' });
    return navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

function closeNotification(sessionId) {
  const tag = `dsh-session-${sessionId}`;
  const bridge = nativeBridge();
  if (bridge) {
    bridge.call('close', { tag });
    return;
  }
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  navigator.serviceWorker.ready
    .then((reg) => reg.getNotifications({ tag }))
    .then((list) => list.forEach((item) => item.close()))
    .catch(() => {});
}

/** Ask for notification permission on whichever surface owns it. */
async function requestNotificationPermission() {
  const bridge = nativeBridge();
  if (bridge) {
    const granted = await bridge.call('requestPermission');
    if (granted === true || granted === 'granted') return 'granted';
    if (granted === false || granted === 'denied') return 'denied';
    return nativePermission(bridge);
  }
  return Notification.requestPermission();
}

function openSession(ctx, sessionId) {
  if (!sessionId) return;
  try {
    ctx.uiWorkspace.openSession(sessionId);
    closeNotification(sessionId);
  } catch (error) {
    // A missing/collapsed session must not break notification handling.
    console.debug('[dsh-mobile] open session failed', error);
  }
}

function secureUrlFor(port) {
  const target = Number.isFinite(port) && port > 0 ? port : DEFAULT_HTTPS_PORT;
  const host = window.location.hostname;
  if (!host) return '';
  return `https://${host}:${target}${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/**
 * Show one notification: the shell bridge first, then the Service Worker.
 *
 * The Android Service Worker path needs a secure context; a native shell does not,
 * which is what makes plain-HTTP LAN access workable in a shell but not in a tab.
 */
function showNotification(ctx, options) {
  if (notificationState() !== 'granted') return;
  const { sessionId, title, body, tag } = options;

  const bridge = nativeBridge();
  if (bridge) {
    const posted = bridge.call('notify', { title, body, tag, sessionId, at: Date.now() });
    // `false` means the shell tried and failed; fall through rather than lose it.
    if (posted !== false) return;
  }

  (async () => {
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, {
          body,
          tag,
          data: { sessionId },
          icon: document.querySelector('link[rel~="icon"]')?.href,
          renotify: true,
        });
      } else if (typeof Notification !== 'undefined') {
        const item = new Notification(title, { body, tag, data: { sessionId } });
        item.onclick = () => {
          window.focus();
          openSession(ctx, sessionId);
          item.close();
        };
      }
    } catch {}
  })();
}

/**
 * Whether a listed session is a delegated child.
 *
 * Subagent sessions share the same list snapshot as root sessions and therefore
 * produce the same running→idle edge and pending-interaction entries. Delegated
 * work is not the human's task: the host dispatcher keeps those silent, and both
 * browser paths must match it. `origin` is the only reliable marker here — a
 * fork also carries a parent id but is a real session the user opened.
 */
function isSubagentSession(ctx, sessionId) {
  try {
    return ctx.sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.origin === 'subagent';
  } catch {
    return false;
  }
}

/**
 * Catch-up channel for events the tab slept through.
 *
 * The host half records every delivered notification in a small ring buffer and
 * exposes it at `/api/dsh-mobile/feed`. Polling it on wake turns "the tab was in
 * the background for an hour" into a missing-notification fix instead of a
 * permanent loss. When the host route is absent (older host half, no restart
 * yet) everything below degrades to a no-op.
 */
function watchFeed(ctx, t) {
  let bootId = sessionStorage.getItem(FEED_BOOT_KEY) ?? '';
  let since = Number.parseInt(sessionStorage.getItem(FEED_SINCE_KEY) ?? '0', 10);
  if (!Number.isFinite(since)) since = 0;
  let disabled = false;
  let inFlight = false;
  const shown = new Set();
  // When the current visible stretch began. The feed exists for the backlog a
  // sleeping tab missed, so it only suppresses entries recorded *after* this
  // point — those are live events the running->idle watcher already owns.
  let visibleSince = document.hidden ? 0 : Date.now();
  let wasHidden = document.hidden;

  const titleFor = (kind) => (kind === 'error' ? `❌ ${t('kFailed')}` : kind === 'ask' ? `❓ ${t('kWaiting')}` : `✅ ${t('kDone')}`);

  const pull = async () => {
    if (disabled || inFlight) return;
    inFlight = true;
    try {
      const response = await fetch(`/api/dsh-mobile/feed?since=${since}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) {
        if (response.status === 404) disabled = true;
        return;
      }
      const payload = await response.json();
      if (payload?.bootId && payload.bootId !== bootId) {
        bootId = payload.bootId;
        since = 0;
        sessionStorage.setItem(FEED_BOOT_KEY, bootId);
        return;
      }
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const settings = readSettings();
      for (const item of items) {
        if (item.seq <= since) continue;
        since = item.seq;
        // The host feed is root-only already; keeping the gate here covers an
        // older host half that still recorded a subagent notice.
        if (isSubagentSession(ctx, item.sessionId)) continue;
        // Only "just happened" entries are worth a toast; older ones are history.
        const fresh = Date.now() - Number(item.at ?? 0) < 120000;
        if (!fresh || shown.has(item.seq)) continue;
        shown.add(item.seq);
        if (!settings.browser || notificationState() !== 'granted') continue;
        if (item.kind === 'done' || item.kind === 'error' ? !settings.done : !settings.ask) continue;
        // A page the user is looking at gets no banner for something that
        // happened while they were watching: the watcher's gate already
        // declined it, and this replay must not override that decision. The
        // backlog from before this visible stretch is what the feed is for.
        const live = !document.hidden && document.hasFocus() && Number(item.at ?? 0) > visibleSince;
        if (live) continue;
        // An event this tab already announced (the watcher runs first) must not
        // alert a second time through the feed.
        if (shownRecently(item.sessionId, item.kind)) continue;
        markShown(item.sessionId, item.kind);
        // The host already composed the task-specific copy; only a message from
        // an older host half lacks it, and then the generic title stands alone.
        const title = item.title || titleFor(item.kind);
        const body = item.body || item.summary || titleFor(item.kind);
        showNotification(ctx, {
          sessionId: item.sessionId,
          title,
          body,
          tag: `${item.kind === 'done' || item.kind === 'error' ? 'dsh-session' : 'dsh-ask'}-${item.sessionId}`,
        });
      }
      sessionStorage.setItem(FEED_SINCE_KEY, String(since));
    } catch {
      // Offline or the route is absent: the running->idle watcher still works.
    } finally {
      inFlight = false;
    }
  };

  /**
   * The wake-up transition, not every visibilitychange, starts a new visible
   * stretch. A tab that was already visible is still "watching" its own events.
   */
  const onVisibility = () => {
    const hiddenNow = document.hidden;
    if (wasHidden && !hiddenNow) visibleSince = Date.now();
    wasHidden = hiddenNow;
    if (!hiddenNow) pull();
  };

  document.addEventListener('visibilitychange', onVisibility);
  const timer = window.setInterval(() => {
    if (!document.hidden) pull();
  }, 60000);
  // The install-time catch-up must die with the watcher: a pull that lands
  // after disposal would still show a banner for an unloaded plugin.
  const initial = window.setTimeout(pull, 1200);

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.clearInterval(timer);
    window.clearTimeout(initial);
  };
}

function watchNotifications(ctx, t) {
  const previous = new Map();
  const pending = new Map();
  const lastAsk = new Map();
  // Running edge: the fallback line needs an elapsed time and the browser half
  // has no turn timing of its own.
  const startedAt = new Map();

  const push = (message) => {
    pushWebhook(message).then((result) => {
      if (!result.ok && result.detail !== 'disabled') {
        console.debug('[dsh-mobile] webhook push failed', result.detail);
      }
    });
  };

  /**
   * Announce one event on every enabled surface.
   *
   * `input` carries what the fallback needs (displayTitle/cwd/durationMs/detail)
   * and never the copy itself: the host notice is what the webhook and the
   * toast should show, so the title/body are derived once, from one source.
   */
  const notify = (sessionId, kind, input) => {
    // One gate for every trigger (done / ask): the host dispatcher never
    // announces a subagent, and neither may this half.
    if (isSubagentSession(ctx, sessionId)) return;
    const settings = readSettings();
    if (!settings.webhook.enabled && !settings.browser) return;
    const local = fallbackNotice(kind, input, sessionId, t);
    /**
     * Which host notices describe this event.
     *
     * `/api/dsh-mobile/notice` returns the last notice of the session, which is
     * still the previous turn's completion when the host skipped composing an
     * `ask` one. Wearing that copy would announce a completion where the user is
     * actually being waited on. A done edge only knows "the agent went idle", so
     * it accepts a structured failure too (the host knows better than the
     * browser) and the silent variants (suppressed by deliverNotice — a quiet
     * turn must stay quiet). `auto` rides with ask for the same reason.
     */
    const fits = (notice) => {
      if (kind === 'ask') return notice.kind === 'ask' || notice.kind === 'auto';
      return notice.kind === 'done' || notice.kind === 'error' || SILENT_VARIANTS.has(notice.variant);
    };
    let settled = false;
    const deliverNotice = (notice) => {
      if (settled) return;
      settled = true;
      if (SILENT_VARIANTS.has(notice.variant)) return;
      if (settings.webhook.enabled) push(notice);
      if (!settings.browser) return;
      if (notificationState() !== 'granted') return;
      if (!document.hidden && document.hasFocus()) return;
      // The feed may already have announced this event when the tab woke up;
      // one alert per event is the contract. The webhook above is not gated: it
      // is a separate delivery path and the feed never drives it.
      const shownKind = notice.kind || kind;
      if (shownRecently(sessionId, shownKind)) return;
      markShown(sessionId, shownKind);
      const tagPrefix = kind === 'ask' ? 'dsh-ask' : 'dsh-session';
      // The banner already shows the title; repeat only the content below it.
      const body = notice.toast || notice.summary || notice.text || '';
      showNotification(ctx, {
        sessionId,
        title: notice.title,
        body,
        tag: `${tagPrefix}-${sessionId}`,
      });
    };

    // The toast may wait briefly for the host copy, but never long: a slow or
    // missing route must not delay the notification itself.
    const timer = window.setTimeout(() => deliverNotice(local), HOST_NOTICE_TIMEOUT + 200);
    fetchHostNotice(sessionId, fits).then((notice) => {
      window.clearTimeout(timer);
      deliverNotice(notice ?? local);
    });
  };

  const statusSnapshot = () => {
    try {
      return ctx.uiSession?.sessionStatus?.getSnapshot?.() ?? new Map();
    } catch {
      return new Map();
    }
  };

  const workspaceOf = (row) => {
    const cwd = typeof row?.cwd === 'string' ? row.cwd.replace(/[\\/]+$/, '') : '';
    return cwd ? cwd.slice(cwd.lastIndexOf('/') + 1) || cwd : '';
  };

  /** One phrase for the blocked step, from the pending interaction itself. */
  const askDetail = (interaction) => {
    if (!interaction) return '';
    if (interaction.kind === 'approval') {
      const tool = interaction.toolName || 'tool';
      const reason = interaction.displayReason || interaction.reason || '';
      return reason ? `${tool} · ${reason}` : tool;
    }
    const questions = Array.isArray(interaction.questions) ? interaction.questions : [];
    const first = questions[0];
    const text = first?.header || first?.question || '';
    const extra = questions.length > 1 ? ` (+${questions.length - 1})` : '';
    return `${text}${extra}`.trim();
  };

  // --- stale approval cleanup ---------------------------------------------
  // The host's auto answer ends the turn, but the approval listener the web
  // half registered keeps its Promise unsettled, so the panel would stay
  // forever (and the gateway re-sends the pending event on every new client).
  // A blocked approval never leaves `running`, so `running === false` plus an
  // approval still pending means nobody is being asked any more. A short
  // settle window absorbs the first paint, where the list can read as idle.
  const STALE_APPROVAL_MS = 3000;
  const staleTimers = new Map();
  const staleCleared = new Set();
  const staleHandle = (id, interaction) => `${id}\u0000${interaction.key}`;

  /** The interaction to abort, or undefined when it must be left alone. */
  const staleApproval = (id, snapshot, statuses) => {
    if (snapshot?.phase !== 'ready') return undefined;
    if (snapshot?.byId?.[id]?.running === true) return undefined;
    const interaction = statuses.get(id)?.pendingInteraction;
    if (!interaction || interaction.kind !== 'approval') return undefined;
    if (interaction.answerable === false) return undefined;
    if (typeof interaction.abort !== 'function') return undefined;
    return interaction;
  };

  const staleApprovalNow = (id) => {
    try {
      return staleApproval(id, ctx.sessions.list.getSnapshot(), statusSnapshot());
    } catch {
      return undefined;
    }
  };

  const disarmStale = (id) => {
    const armed = staleTimers.get(id);
    if (!armed) return;
    window.clearTimeout(armed.timer);
    staleTimers.delete(id);
  };

  const armStale = (id, handle) => {
    const timer = window.setTimeout(() => {
      staleTimers.delete(id);
      try {
        const current = staleApprovalNow(id);
        if (!current || staleHandle(id, current) !== handle) return;
        // Remember before aborting: an already-settled interaction throws, and
        // a throw must not re-arm the same panel on the next scan.
        staleCleared.add(handle);
        try {
          current.abort(new Error('dsh-mobile: 宿主已处理该审批，面板已过期'));
        } catch {
          // Already settled: nothing left to close.
        }
        console.debug('[dsh-mobile] cleared stale approval', id, current.key);
      } catch {
        // The callback must never become an uncaught error in the page.
      }
    }, STALE_APPROVAL_MS);
    staleTimers.set(id, { handle, timer });
  };

  const scan = () => {
    const snapshot = ctx.sessions.list.getSnapshot();
    const ids = snapshot?.ids ?? [];
    const statuses = statusSnapshot();
    const settings = readSettings();

    for (const id of ids) {
      const row = snapshot?.byId?.[id];
      if (!row) continue;
      const running = row.running === true;
      const was = previous.get(id);
      previous.set(id, running);
      if (running && was !== true) startedAt.set(id, Date.now());

      if (was === true && !running) {
        if (settings.done && !isSubagentSession(ctx, id)) {
          notify(id, 'done', {
            displayTitle: row.displayTitle,
            workspace: workspaceOf(row),
            durationMs: Date.now() - (startedAt.get(id) ?? Date.now()),
          });
        }
      }

      // A blocked approval or a pending question never leaves `running`, so the
      // running->idle edge above can never fire for it.
      const interaction = statuses.get(id)?.pendingInteraction;
      const key = interaction?.key ?? interaction?.kind ?? '';
      const had = pending.get(id);
      pending.set(id, key);

      if (key) {
        if (key !== had) {
          if (settings.ask && !isSubagentSession(ctx, id)) {
            const now = Date.now();
            if (now - (lastAsk.get(id) ?? 0) > 30000) {
              lastAsk.set(id, now);
              notify(id, 'ask', { displayTitle: row.displayTitle, workspace: workspaceOf(row), detail: askDetail(interaction) });
            }
          }
        }
      } else {
        lastAsk.delete(id);
      }

      // Only approvals: a PendingQuestion is dismissed through `dismiss()`,
      // which merely hides the composer seat for cards with a callId and does
      // not end the request. Aborting it would be a different promise.
      const stale = staleApproval(id, snapshot, statuses);
      const handle = stale ? staleHandle(id, stale) : '';
      if (!stale || staleCleared.has(handle)) {
        disarmStale(id);
      } else {
        const armed = staleTimers.get(id);
        // Same session + same interaction: keep the running clock.
        if (!armed) armStale(id, handle);
        else if (armed.handle !== handle) {
          disarmStale(id);
          armStale(id, handle);
        }
      }
    }

    for (const id of [...startedAt.keys()]) {
      if (!snapshot?.byId?.[id]) startedAt.delete(id);
    }
    for (const id of [...staleTimers.keys()]) {
      if (!snapshot?.byId?.[id]) disarmStale(id);
    }
  };

  const off = ctx.sessions.list.subscribe(scan);
  const statusOff = (() => {
    try {
      return ctx.uiSession?.sessionStatus?.subscribe?.(scan) ?? (() => {});
    } catch {
      return () => {};
    }
  })();
  scan();
  return () => {
    off();
    statusOff();
    for (const id of [...staleTimers.keys()]) disarmStale(id);
  };
}

function installServiceWorkerMessages(ctx) {
  if (!('serviceWorker' in navigator)) return () => {};
  const onMessage = (event) => {
    const data = event.data;
    if (!data || data.type !== 'dsh-mobile:open-session') return;
    window.focus();
    openSession(ctx, data.sessionId);
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

/** Probe the host half for the HTTPS entry point it advertises. */
function probeSecurePort() {
  return fetch('/plugins/dsh-mobile/meta', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      const port = Number(payload?.httpsPort);
      return Number.isFinite(port) && port > 0 ? port : DEFAULT_HTTPS_PORT;
    })
    .catch(() => DEFAULT_HTTPS_PORT);
}

function makeNotifyHint(t) {
  return function NotifyHint() {
    const [state, setState] = React.useState(() => {
      if (sessionStorage.getItem(HINT_DISMISSED_KEY) === '1') return 'dismissed';
      return notificationState();
    });

    if (state === 'dismissed' || state === 'unsupported' || state === 'granted' || state === 'denied') {
      return null;
    }

    if (state === 'insecure') {
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dshm-notify',
          title: 'Notifications require a secure context (HTTPS or localhost).',
          onClick: async () => {
            const port = await probeSecurePort();
            const url = secureUrlFor(port);
            if (url) {
              window.location.href = url;
              return;
            }
            sessionStorage.setItem(HINT_DISMISSED_KEY, '1');
            setState('dismissed');
          },
        },
        t('insecure'),
      );
    }

    return React.createElement(
      'button',
      {
        type: 'button',
        className: 'dshm-notify',
        onClick: async () => {
          try {
            setState(await requestNotificationPermission());
          } catch {
            sessionStorage.setItem(HINT_DISMISSED_KEY, '1');
            setState('dismissed');
          }
        },
      },
      t('enable'),
    );
  };
}

/**
 * The host's sample notice, used by the settings page's "send test" button.
 *
 * Same fetch the notice path uses, so the test shows exactly what a real
 * completion looks like (card included) instead of a bare title.
 */
async function fetchSampleNotice() {
  try {
    const init = { credentials: 'same-origin', cache: 'no-store' };
    const signal = timeoutSignal(HOST_NOTICE_TIMEOUT);
    if (signal) init.signal = signal;
    const response = await fetch('/api/dsh-mobile/notice?sample=1', init);
    if (!response.ok) return null;
    return (await response.json())?.notice ?? null;
  } catch {
    return null;
  }
}

/**
 * Everything the other chunks may use.
 *
 * Exported as one object so the entry hands a single, stable surface to the deep
 * link and settings chunks; neither may reach into this module's internals.
 */
const api = {
  openSession,
  makeNotifyHint,
  watchNotifications,
  watchFeed,
  installServiceWorkerMessages,
  registerServiceWorker,
  readSettings,
  writeSettings,
  syncHostSettings,
  subscribeSettings,
  pushWebhook,
  fallbackNotice,
  probeSecurePort,
  secureUrlFor,
  notificationState,
  fetchSampleNotice,
};

return { api };
  },
});
