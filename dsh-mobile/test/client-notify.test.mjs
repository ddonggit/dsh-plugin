/**
 * Browser half: notification routing and the host-settings cache.
 *
 *   node --test test/client-notify.test.mjs
 *
 * The chunk is a plain browser script (`window.__ModuleLoader__.load`), so this
 * file installs a small DOM/fetch/storage stub BEFORE importing it and drives
 * the exported `api` directly. Three behaviours are pinned down here:
 *
 *   - the host feed is a catch-up channel, not a second notifier: it must stay
 *     quiet on a page the user is looking at, and must not repeat an event the
 *     running->idle watcher already announced;
 *   - an `ask` event must never wear the previous turn's completion notice
 *     (and a completion must still accept a host `error` / silent notice);
 *   - a failed settings migration must keep this browser's record instead of
 *     caching the host defaults.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const localMap = new Map();
const sessionMap = new Map();
const memoryStore = (map) => ({
  getItem: (key) => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: (key) => map.delete(key),
});

const state = {
  notifications: [],
  hidden: false,
  focused: true,
  feed: { bootId: 'boot-A', seq: 0, items: [] },
  notice: null,
  hostGet: null,
  hostPost: null,
  calls: [],
};

const documentListeners = [];
const documentStub = {
  get hidden() {
    return state.hidden;
  },
  title: 'DSH',
  hasFocus: () => state.focused,
  addEventListener(type, fn) {
    documentListeners.push({ type, fn });
  },
  removeEventListener(type, fn) {
    const index = documentListeners.findIndex((item) => item.type === type && item.fn === fn);
    if (index >= 0) documentListeners.splice(index, 1);
  },
  querySelector: () => null,
};

class NotificationStub {
  static permission = 'granted';
  constructor(title, options) {
    state.notifications.push({ title, ...options });
  }
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

let captured = null;
const windowStub = {
  localStorage: memoryStore(localMap),
  sessionStorage: memoryStore(sessionMap),
  location: { origin: 'http://localhost:3080', hostname: 'localhost', pathname: '/', search: '', hash: '' },
  isSecureContext: true,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load(definition) {
      captured = definition;
    },
  },
};

Object.defineProperty(globalThis, 'window', { value: windowStub, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true, writable: true });
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: windowStub.localStorage, configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: windowStub.sessionStorage, configurable: true });
Object.defineProperty(globalThis, 'Notification', { value: NotificationStub, configurable: true });

globalThis.fetch = async (url, init) => {
  const target = String(url);
  state.calls.push({ url: target, init });
  if (target.startsWith('/api/dsh-mobile/feed')) return jsonResponse(200, { ok: true, ...state.feed });
  if (target.startsWith('/api/dsh-mobile/notice')) {
    return state.notice ? jsonResponse(200, { ok: true, notice: state.notice }) : jsonResponse(404, { ok: false });
  }
  if (target === '/api/dsh-mobile/host-settings') {
    if (init?.method === 'POST') {
      return jsonResponse(state.hostPost?.status ?? 200, state.hostPost?.body ?? { ok: true });
    }
    return jsonResponse(200, state.hostGet);
  }
  return jsonResponse(404, { ok: false });
};

await import('../client.notify.js');
const api = captured.factory(() => ({ createElement() {}, useState() {}, useEffect() {} })).api;
const translate = (key) => key;

const DEFAULT_SETTINGS = {
  browser: true,
  done: true,
  ask: true,
  webhook: { enabled: false, kind: 'auto', url: '' },
};

function seedSettings(record = DEFAULT_SETTINGS) {
  localMap.set('dsh-mobile:notify', JSON.stringify(record));
}

function reset() {
  state.notifications = [];
  state.hidden = false;
  state.focused = true;
  state.feed = { bootId: 'boot-A', seq: 0, items: [] };
  state.notice = null;
  state.hostGet = null;
  state.hostPost = null;
  state.calls = [];
  sessionMap.clear();
  documentListeners.length = 0;
  seedSettings();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fireVisibility() {
  for (const { type, fn } of [...documentListeners]) if (type === 'visibilitychange') fn();
}

const feedItem = (seq, sessionId, kind = 'done') => ({
  seq,
  at: Date.now(),
  kind,
  sessionId,
  title: `✅ ${sessionId}`,
  summary: 'done',
  body: 'done body',
  link: '',
});

function makeCtx(sessionId) {
  const row = { id: sessionId, displayTitle: 'T', cwd: '/tmp/ws', running: false };
  const status = new Map();
  const subscriptions = new Set();
  const snapshot = { phase: 'ready', ids: [sessionId], byId: { [sessionId]: row } };
  return {
    row,
    status,
    ctx: {
      sessions: {
        list: {
          getSnapshot: () => snapshot,
          subscribe: (listener) => {
            subscriptions.add(listener);
            return () => subscriptions.delete(listener);
          },
        },
      },
      uiSession: {
        sessionStatus: {
          getSnapshot: () => status,
          subscribe: (listener) => {
            subscriptions.add(listener);
            return () => subscriptions.delete(listener);
          },
        },
      },
      uiWorkspace: { openSession() {} },
    },
    scan() {
      for (const listener of subscriptions) listener();
    },
  };
}

test('the feed does not banner a live event on a page the user is watching', async (t) => {
  reset();
  sessionMap.set('dsh-mobile:feed-boot', 'boot-A');
  sessionMap.set('dsh-mobile:feed-since', '0');
  const env = makeCtx('s-visible');
  const stop = api.watchFeed(env.ctx, translate);
  t.after(() => stop());
  // The event lands after the current visible stretch began: the watcher owns
  // it, and the feed must not replay it as a banner while the page is open.
  await sleep(10);
  state.feed = { bootId: 'boot-A', seq: 1, items: [feedItem(1, 's-visible')] };
  fireVisibility();
  await sleep(30);
  assert.equal(state.notifications.length, 0, 'a visible, focused page gets no banner from the feed');
});

test('the feed still delivers the backlog when the tab wakes up', async (t) => {
  reset();
  state.hidden = true;
  state.focused = false;
  sessionMap.set('dsh-mobile:feed-boot', 'boot-A');
  sessionMap.set('dsh-mobile:feed-since', '5');
  state.feed = { bootId: 'boot-A', seq: 6, items: [feedItem(6, 's-wake')] };
  const env = makeCtx('s-wake');
  const stop = api.watchFeed(env.ctx, translate);
  t.after(() => stop());
  // The event happened while the tab was hidden; showing it after the wake-up
  // is the whole point of the feed, so the visible-stretch gate must not eat it.
  state.hidden = false;
  state.focused = true;
  fireVisibility();
  await sleep(30);
  assert.equal(state.notifications.length, 1, 'a slept-through event is catch-up, not a replay');
  assert.match(state.notifications[0].title, /^✅/);
});

test('the feed still banners a hidden tab', async (t) => {
  reset();
  state.hidden = true;
  state.focused = false;
  sessionMap.set('dsh-mobile:feed-boot', 'boot-A');
  sessionMap.set('dsh-mobile:feed-since', '1');
  state.feed = { bootId: 'boot-A', seq: 2, items: [feedItem(2, 's-hidden')] };
  const env = makeCtx('s-hidden');
  const stop = api.watchFeed(env.ctx, translate);
  t.after(() => stop());
  // The install-time pull (1200ms) is the only one that ignores `document.hidden`.
  await sleep(1350);
  assert.equal(state.notifications.length, 1, 'a sleeping tab is exactly what the feed is for');
  assert.match(state.notifications[0].title, /^✅/);
});

test('one event alerts once: the feed yields to the running->idle watcher', async (t) => {
  reset();
  state.hidden = true;
  state.focused = false;
  sessionMap.set('dsh-mobile:feed-boot', 'boot-A');
  sessionMap.set('dsh-mobile:feed-since', '3');
  state.feed = { bootId: 'boot-A', seq: 4, items: [feedItem(4, 's-dup')] };
  const env = makeCtx('s-dup');
  const stopWatcher = api.watchNotifications(env.ctx, translate);
  t.after(() => stopWatcher());
  env.row.running = true;
  env.scan();
  const stopFeed = api.watchFeed(env.ctx, translate);
  t.after(() => stopFeed());
  env.row.running = false;
  env.scan();
  await sleep(1350);
  assert.equal(state.notifications.length, 1, 'the same event must not alert twice');
  assert.match(state.notifications[0].title, /^✅/);
});

test('an ask event never wears the previous completion notice', async (t) => {
  reset();
  state.hidden = true;
  state.focused = false;
  state.notice = {
    kind: 'done',
    variant: 'done',
    sessionId: 's-ask-mismatch',
    title: '✅ 完成 · 上一轮',
    summary: 'prev',
    text: 'prev',
    at: Date.now(),
  };
  const env = makeCtx('s-ask-mismatch');
  env.row.running = true;
  env.status.set('s-ask-mismatch', {
    running: true,
    pendingInteraction: { key: 'approval:1', kind: 'approval', toolName: 'bash', displayReason: 'why' },
  });
  const stop = api.watchNotifications(env.ctx, translate);
  t.after(() => stop());
  await sleep(60);
  assert.equal(state.notifications.length, 1);
  assert.match(state.notifications[0].title, /^❓/, 'the local ask copy must replace the stale done notice');
  assert.doesNotMatch(state.notifications[0].title, /完成/);
});

test('a completion edge accepts the host error notice', async (t) => {
  reset();
  state.hidden = true;
  state.focused = false;
  state.notice = {
    kind: 'error',
    variant: 'error',
    sessionId: 's-err-note',
    title: '❌ 失败 · X',
    summary: 'boom',
    text: 'boom',
    at: Date.now(),
  };
  const env = makeCtx('s-err-note');
  const stop = api.watchNotifications(env.ctx, translate);
  t.after(() => stop());
  env.row.running = true;
  env.scan();
  env.row.running = false;
  env.scan();
  await sleep(60);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].title, '❌ 失败 · X', 'the host knows an error when the browser only saw idle');
});

test('a silent-variant notice still keeps the turn quiet', async (t) => {
  reset();
  state.hidden = true;
  state.focused = false;
  state.notice = {
    kind: '',
    variant: 'aborted',
    sessionId: 's-abort',
    title: '⏹ 已中断',
    summary: '',
    text: '',
    at: Date.now(),
  };
  const env = makeCtx('s-abort');
  const stop = api.watchNotifications(env.ctx, translate);
  t.after(() => stop());
  env.row.running = true;
  env.scan();
  env.row.running = false;
  env.scan();
  await sleep(60);
  assert.equal(state.notifications.length, 0, 'an aborted turn must not become a "完成" banner');
});

test('a failed settings migration keeps this browser record', async (t) => {
  reset();
  // The failure is the point of this test; its console.debug is expected noise.
  const debug = console.debug;
  console.debug = () => {};
  t.after(() => {
    console.debug = debug;
  });
  seedSettings({ browser: true, done: false, ask: false, webhook: { enabled: false, kind: 'auto', url: '' } });
  state.hostGet = {
    ok: true,
    settings: {
      askAutoAnswer: false,
      askTimeoutMs: 120000,
      approvalAutoAction: 'rejected',
      questionAutoPick: 'first',
      browserSettings: { ...DEFAULT_SETTINGS },
    },
    defaults: {
      askAutoAnswer: false,
      askTimeoutMs: 120000,
      approvalAutoAction: 'rejected',
      questionAutoPick: 'first',
      browserSettings: { ...DEFAULT_SETTINGS },
    },
    range: { minMs: 15000, maxMs: 86400000 },
    storedBrowserSettings: null,
  };
  state.hostPost = {
    status: 409,
    body: { ok: false, error: 'settings.json could not be read; refusing to overwrite it' },
  };

  assert.equal(api.readSettings().done, false);
  await api.syncHostSettings();
  const after = api.readSettings();
  assert.equal(after.done, false, 'a refused migration must not cache the host defaults');
  assert.equal(after.ask, false);
  assert.ok(
    state.calls.some((call) => call.init?.method === 'POST'),
    'the migration was attempted',
  );
});
