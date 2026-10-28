/**
 * Offline integration harness for the client half: the chunk split and the
 * sidebar state machine.
 *
 *   node test/client-harness.mjs
 *
 * Reproduces the client module loader contract, React and the DOM the plugin
 * touches, then runs the real client.js entry and its chunks — so a missing
 * export, a stray reference, a broken chunk path or a drifted state machine
 * fails here instead of on a phone. No dependencies, no build step, nothing
 * written to disk.
 *
 * Reproduces the parts of the client module loader, React, the DOM and the
 * official layout service that the plugin touches, then runs the real client.js
 * entry and its chunks. A missing export, a stray reference, a broken chunk path
 * or a state machine that drifts fails here instead of on the phone. Nothing is
 * written to the plugin directory.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const dir = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const log = [];
const fail = (message) => {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
};

// ---- fake DOM -------------------------------------------------------------
let viewportMobile = true;

class FakeElement {
  constructor(tag, classes = []) {
    this.tag = tag;
    this.classes = classes;
    this.attrs = new Map();
    this.isConnected = true;
    this.parentElement = null;
    this.children = [];
    this.listeners = [];
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  remove() {
    this.isConnected = false;
  }
  matches(selector) {
    // Only the selector shapes the plugin actually uses are understood, and a
    // selector list (`button, [role="button"]`) matches when one entry does.
    return String(selector)
      .split(',')
      .some((part) => this.matchesSimple(part.trim()));
  }
  matchesSimple(part) {
    if (!part) return false;
    // Tag name (`button`).
    const tag = /^[a-z]+/.exec(part);
    if (tag) {
      if (this.tag !== tag[0]) return false;
      part = part.slice(tag[0].length);
    }
    // Everything else is a chain of `.class` and `[attribute]` tokens.
    const token = /\.([A-Za-z0-9_-]+)|\[([^\]]+)\]/g;
    let consumed = 0;
    let match;
    while ((match = token.exec(part))) {
      consumed = token.lastIndex;
      if (match[1]) {
        if (!this.classes.includes(match[1])) return false;
        continue;
      }
      const body = match[2];
      // `[class*="x"]`: the compressed CSS-module lookup.
      const containsClass = /^class\*="([^"]+)"$/.exec(body);
      if (containsClass) {
        if (!this.classes.some((name) => name.includes(containsClass[1]))) return false;
        continue;
      }
      // `[name="value"]`, `[name^="value"]`, or a bare `[name]`.
      const exact = /^([^\]=^]+)="([^"]*)"$/.exec(body);
      if (exact) {
        if (this.getAttribute(exact[1].trim()) !== exact[2]) return false;
        continue;
      }
      const prefix = /^([^\]=^]+)\^="([^"]*)"$/.exec(body);
      if (prefix) {
        const value = this.getAttribute(prefix[1].trim());
        if (value === null || !value.startsWith(prefix[2])) return false;
        continue;
      }
      const presence = /^([^\]=^\s]+)$/.exec(body.trim());
      if (presence) {
        if (!this.hasAttribute(presence[1])) return false;
        continue;
      }
      return false;
    }
    return consumed === part.length;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  addEventListener(type, fn, capture) {
    this.listeners.push({ type, fn, capture });
  }
  removeEventListener(type, fn) {
    const index = this.listeners.findIndex((item) => item.type === type && item.fn === fn);
    if (index >= 0) this.listeners.splice(index, 1);
  }
}

const frame = new FakeElement('div', ['pI_x6G_frame']);
const sidecol = new FakeElement('div', ['pI_x6G_sidebarCol']);
const center = new FakeElement('div', ['pI_x6G_centerCol']);
const rightcol = new FakeElement('div', ['pI_x6G_rightbarCol']);
sidecol.parentElement = frame;
frame.children.push(sidecol, center, rightcol);
frame.setAttribute('data-sidebar-collapsed', 'true');

const toggleButton = new FakeElement('button', ['hHd-Xa_toggle']);
const sidebarRoot = new FakeElement('div', ['hHd-Xa_root']);
sidebarRoot.parentElement = sidecol;
sidecol.children.push(sidebarRoot);
toggleButton.parentElement = sidebarRoot;
sidebarRoot.children.push(toggleButton);

// The header menu button the entry registers; the diagnostics section looks it
// up by class, and `menuMounted` flips to prove a missing button is reported.
const menuButton = new FakeElement('button', ['dshm-menu']);
let menuMounted = true;

const styleElements = [];
const documentListeners = [];
const body = new FakeElement('body');

const documentStub = {
  hidden: false,
  title: 'DSH',
  body,
  documentElement: { dataset: {}, hasAttribute: () => false, setAttribute: () => {} },
  head: {
    appendChild: (node) => {
      styleElements.push(node);
      return node;
    },
  },
  createElement: (tag) => new FakeElement(tag),
  querySelector: (selector) => {
    if (selector.includes('_sidebarCol')) return sidecol;
    if (selector === '.dshm-menu') return menuMounted ? menuButton : null;
    if (selector.includes('data-dshm-toggle')) return menuButton;
    return null;
  },
  querySelectorAll: (selector) => {
    if (selector.includes('_sidebarCol')) return [sidecol];
    return [];
  },
  addEventListener: (type, fn, capture) => documentListeners.push({ type, fn, capture }),
  removeEventListener: (type, fn) => {
    const index = documentListeners.findIndex((item) => item.type === type && item.fn === fn);
    if (index >= 0) documentListeners.splice(index, 1);
  },
  hasFocus: () => true,
};

const observers = [];
class MutationObserverStub {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }
  observe() {}
  disconnect() {}
}

const storage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};

// ---- fake module loader ---------------------------------------------------
const registrations = new Map();
const loadCache = new Map();

function makeRequire(ownerId) {
  const require = (spec) => {
    if (spec === 'react') return ReactStub;
    throw new Error(`require(${spec}) missed the module table`);
  };
  require.async = async (spec) => {
    if (!spec.startsWith('./')) throw new Error(`unexpected async spec ${spec}`);
    const file = spec.slice(2);
    if (loadCache.has(file)) return loadCache.get(file);
    const source = readFileSync(`${dir}/${file}`, 'utf8');
    vm.runInContext(source, context, { filename: file });
    const registration = registrations.get(file);
    if (!registration) throw new Error(`${file} did not register via __ModuleLoader__.load`);
    if (registration.id !== ownerId) throw new Error(`${file} registered id ${registration.id}`);
    const exports = registration.factory(makeRequire(ownerId));
    loadCache.set(file, exports);
    log.push(`materialized ${file}`);
    return exports;
  };
  return require;
}

// ---- React stub -----------------------------------------------------------
let hookCursor = 0;
let hookState = [];
let hookEffects = [];
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState(initial) {
    const index = hookCursor++;
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      hookState[index] = typeof next === 'function' ? next(hookState[index]) : next;
    };
    return [hookState[index], set];
  },
  useEffect(fn) {
    hookEffects.push(fn);
  },
};

// ---- window ---------------------------------------------------------------
const fetchCalls = [];

// A miniature host for `/api/dsh-mobile/host-settings`. The client is host-first
// now, so the fake has to answer GET/POST and keep a raw stored block; `down`
// reproduces an unreachable or not-yet-restarted host.
const hostMock = { down: true, stored: null, posts: [] };
const HOST_BROWSER_KINDS = ['auto', 'feishu', 'dingtalk', 'serverchan', 'generic'];
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const hostBrowserSettings = () => {
  const raw = hostMock.stored && typeof hostMock.stored === 'object' ? hostMock.stored : {};
  const webhook = raw.webhook && typeof raw.webhook === 'object' ? raw.webhook : {};
  return {
    browser: raw.browser !== false,
    done: raw.done !== false,
    ask: raw.ask !== false,
    webhook: {
      enabled: webhook.enabled === true,
      kind: HOST_BROWSER_KINDS.includes(webhook.kind) ? webhook.kind : 'feishu',
      url: typeof webhook.url === 'string' ? webhook.url.trim() : '',
    },
  };
};
const hostPayload = (init = {}) => {
  if (hostMock.down) return { ok: false, status: 503, json: async () => ({ ok: false, error: 'host unavailable' }) };
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'POST') {
    let body;
    try {
      body = JSON.parse(init.body ?? '{}');
    } catch {
      return { ok: false, status: 400, json: async () => ({ ok: false, error: 'body must be JSON' }) };
    }
    hostMock.posts.push(body);
    const patch = body.browserSettings ?? {};
    const stored = hostMock.stored && typeof hostMock.stored === 'object' ? { ...hostMock.stored } : {};
    for (const key of ['browser', 'done', 'ask']) if (key in patch) stored[key] = patch[key];
    if (patch.webhook) {
      const webhook = stored.webhook && typeof stored.webhook === 'object' ? stored.webhook : {};
      stored.webhook = { ...webhook, ...patch.webhook };
    }
    hostMock.stored = stored;
  }
  const settings = {
    askAutoAnswer: false,
    askTimeoutMs: 120000,
    approvalAutoAction: 'rejected',
    questionAutoPick: 'first',
    browserSettings: hostBrowserSettings(),
  };
  const body = {
    ok: true,
    settings,
    defaults: { ...settings, browserSettings: hostBrowserSettings() },
    range: { minMs: 15000, maxMs: 86400000 },
    storedBrowserSettings: hostMock.stored ? cloneJson(hostMock.stored) : null,
  };
  return { ok: true, status: 200, json: async () => cloneJson(body) };
};
const windowStub = {
  location: { origin: 'http://127.0.0.1:3081', href: 'http://127.0.0.1:3081/', hostname: '127.0.0.1', pathname: '/', search: '', hash: '' },
  isSecureContext: true,
  innerWidth: 412,
  innerHeight: 880,
  devicePixelRatio: 2.75,
  matchMedia: (query) => ({
    matches: viewportMobile && query.includes('1024'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  localStorage: storage(),
  sessionStorage: storage(),
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
  setInterval: (...args) => setInterval(...args),
  clearInterval: (...args) => clearInterval(...args),
  addEventListener: (type, fn, capture) => documentStub.addEventListener(type, fn, capture),
  removeEventListener: (type, fn) => documentStub.removeEventListener(type, fn),
  focus: () => {},
  history: { replaceState: () => {} },
  navigator: { userAgent: 'node-harness' },
  document: documentStub,
  fetch: async (url, init) => {
    fetchCalls.push({ url, init });
    if (String(url).startsWith('/plugins/dsh-mobile/meta')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, enabled: true, httpsPort: 3088, baseUrl: 'https://example.test:3088', channels: ['feishu'] }),
      };
    }
    if (String(url) === '/api/dsh-mobile/host-settings') return hostPayload(init);
    return { ok: false, status: 404, json: async () => ({}) };
  },
  console,
};

const context = vm.createContext({
  ...windowStub,
  window: windowStub,
  document: documentStub,
  navigator: windowStub.navigator,
  fetch: windowStub.fetch,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  URLSearchParams,
  AbortSignal,
  Element: FakeElement,
  MutationObserver: MutationObserverStub,
  CSS: { supports: () => true },
  __ModuleLoader__: {
    load: (registration) => {
      if (typeof registration.chunk === 'string') registrations.set(registration.chunk, registration);
      else registrations.set('client.js', registration);
    },
  },
});
context.globalThis = context;
context.window = context;
// Classes below run in the VM but must recognise the harness's element type.
context.Element = FakeElement;

// ---- run the entry -------------------------------------------------------
const entrySource = readFileSync(`${dir}/client.js`, 'utf8');
vm.runInContext(entrySource, context, { filename: 'client.js' });
const entry = registrations.get('client.js');
if (!entry) throw new Error('client.js registered no factory');
if (entry.id !== 'dsh-mobile' || entry.chunk !== undefined) fail('entry registration shape');

const effects = [];
const slots = [];
const localeMessages = {};
let toggles = 0;
// Services reachable through ctx.get(name) only — exactly the ones a cordis ctx
// refuses to expose as properties unless the plugin declares them in `inject`.
const moduleService = {
  manifest: { modules: [{ id: 'a' }, { id: 'b' }], plugins: [{ id: 'a' }] },
  importError: () => undefined,
};
// A miniature resources registry: per-address record, stable source object,
// status store. The forensics chunk wraps `source` in place, so this is what
// proves the wrapper keeps returning the original observable.
const parseProtocol = (address) => {
  try {
    const parsed = new URL(address);
    if (parsed.protocol !== 'dsh-resource:') return undefined;
    return parsed.hostname === '' ? undefined : parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
};
const resourceRecords = new Map();
const harnessFileProvider = { protocol: 'file', open: async function* open() {} };
const registeredProviders = [];
const releasedProviders = [];
const resourceService = {
  providerOf: (protocol) => (protocol === 'file' ? harnessFileProvider : undefined),
  register(provider) {
    registeredProviders.push(provider);
    return () => releasedProviders.push(provider);
  },
  source(address) {
    let record = resourceRecords.get(address);
    if (record === undefined) {
      record = { status: this.providerOf(parseProtocol(address)) === undefined ? 'none' : 'loading', listeners: new Set() };
      record.source = {
        getSnapshot: () => ({ status: record.status }),
        subscribe: (listener) => {
          record.listeners.add(listener);
          return () => record.listeners.delete(listener);
        },
      };
      resourceRecords.set(address, record);
    }
    return record.source;
  },
};
const setResourceStatus = (address, status) => {
  const record = resourceRecords.get(address);
  if (!record) return;
  record.status = status;
  for (const listener of [...record.listeners]) listener();
};
// The unwrapped implementation, captured before the plugin runs.
const pristineResourceSource = resourceService.source;
const rawResourceSource = resourceService.source.bind(resourceService);
const services = { modules: moduleService, resources: resourceService };

// The session list and the per-session status store are injected by SPIC-42's
// stale-approval assertions below; the defaults are the empty, ready snapshots
// the real list has before the first load finishes.
const sessionFeed = {
  snapshot: { ids: [], byId: {}, phase: 'ready' },
  statuses: new Map(),
  listListeners: new Set(),
  statusListeners: new Set(),
};
const publishSessions = (next) => {
  sessionFeed.snapshot = next;
  for (const listener of [...sessionFeed.listListeners]) listener();
};
const publishStatuses = (next) => {
  sessionFeed.statuses = next;
  for (const listener of [...sessionFeed.statusListeners]) listener();
};

const rawCtx = {
  effect(fn) {
    const dispose = fn();
    effects.push(dispose);
    return dispose;
  },
  get: (name) => services[name],
  logger: { info() {}, warn() {}, error() {} },
  locale: {
    register: (namespace, language, messages) => {
      localeMessages[language] = messages;
      return () => {};
    },
    bind: () => (key) => `t:${key}`,
    subscribe: () => () => {},
  },
  slots: {
    inject: (name, fn) => fn(),
    register: (definition, component) => {
      slots.push({ definition, component });
      return () => {};
    },
    subscribe: () => () => {},
  },
  layout: {
    toggleSidebar: () => {
      toggles += 1;
      // The real layout flips data-sidebar-collapsed; the observer reports it.
      if (frame.hasAttribute('data-sidebar-collapsed')) frame.removeAttribute('data-sidebar-collapsed');
      else frame.setAttribute('data-sidebar-collapsed', 'true');
      for (const observer of observers) observer.callback([{ type: 'attributes', attributeName: 'data-sidebar-collapsed' }]);
    },
  },
  sessions: {
    list: {
      getSnapshot: () => sessionFeed.snapshot,
      subscribe: (listener) => {
        sessionFeed.listListeners.add(listener);
        return () => sessionFeed.listListeners.delete(listener);
      },
    },
  },
  uiSession: {
    sessionStatus: {
      getSnapshot: () => sessionFeed.statuses,
      subscribe: (listener) => {
        sessionFeed.statusListeners.add(listener);
        return () => sessionFeed.statusListeners.delete(listener);
      },
    },
  },
  uiWorkspace: { openSession: () => {} },
};

// A cordis ctx is a proxy: reading an undeclared service as a property throws.
// Reproducing that here is what catches `ctx.modules`-style reads.
const ctx = new Proxy(rawCtx, {
  get(target, prop, receiver) {
    if (typeof prop === 'symbol' || prop in target || prop === 'then' || prop === 'toJSON') {
      return Reflect.get(target, prop, receiver);
    }
    throw new Error(`cannot get property "${String(prop)}" without inject`);
  },
});

const exportsObject = entry.factory(makeRequire('dsh-mobile'));
exportsObject.apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 80));

// ---- chunk + wiring assertions -------------------------------------------
for (const chunk of ['client.styles.js', 'client.resource-compat.js', 'client.forensics.js', 'client.sidebar.js', 'client.deeplink.js', 'client.notify.js']) {
  if (!loadCache.has(chunk)) fail(`${chunk} was not loaded at boot`);
}
if (loadCache.has('client.diagnostics.js')) fail('the diagnostics chunk must not load at boot');
if (loadCache.has('client.settings.js')) fail('client.settings.js must stay lazy');

const critical = styleElements.find((node) => node.getAttribute('data-plugin') === 'dsh-mobile-critical');
if (!critical) fail('critical CSS is not injected synchronously');
if (!critical?.textContent?.includes('data-sidebar-collapsed')) fail('critical CSS does not hide the default sidebar');
// The frame is a child of the renderer's `div[data-slot="root"]`, not of #root.
if (!critical?.textContent?.includes('div[data-slot=\"root\"] > div[style*=\"grid-template-columns\"][data-sidebar-collapsed]')) {
  fail('critical CSS does not target the real frame position');
}
if (/#root\s*>\s*div\[style/.test(critical?.textContent ?? '')) fail('critical CSS still uses the #root > frame form');
if (critical?.isConnected !== false) fail('critical CSS outlived the real skin');

const style = styleElements.find((node) => node.getAttribute('data-plugin') === 'dsh-mobile');
if (!style) fail('styles chunk did not inject the plugin stylesheet');
const css = style?.textContent ?? '';
if (!css.includes('dshm-notify')) fail('stylesheet is missing the pill rules');
if (!css.includes('data-dshm-surface="mobile"')) fail('stylesheet is not scoped by the surface marker');
if (!css.includes('[data-sidebar-collapsed]')) fail('stylesheet has no hidden-state rule');
if (css.includes('.dshm-toggle')) fail('stylesheet still carries the removed floating button');
if (css.includes('data-dshm-rail')) fail('stylesheet still references the removed rail state');
if (css.includes('--dsh-frame-leading-clearance')) fail('stylesheet still reserves the removed header band');

// Wide markdown tables: the shell hides their horizontal overflow until hover,
// which a touch screen never produces. The mobile surface must scroll instead.
const wideTableRule = /body\[data-dshm-surface="mobile"\] \.md-table-wide \{([^}]*)\}/.exec(css);
if (!wideTableRule) fail('stylesheet is missing the mobile wide-table rule');
if (!/overflow-x:\s*auto/.test(wideTableRule?.[1] ?? '')) {
  fail('wide markdown tables are not scrollable on the mobile surface');
}

// The header menu button: 40x40 transparent hot zone, 20x20 glyph, colour from
// an official token so both themes adapt. No hard-coded palette, no shadow.
const menuRule = /body\[data-dshm-surface="mobile"\] \.dshm-menu \{([^}]*)\}/.exec(css);
if (!menuRule) fail('stylesheet is missing the header menu button rule');
const menuCss = menuRule?.[1] ?? '';
if (!/background:\s*transparent/.test(menuCss)) fail('menu button is not transparent');
if (!menuCss.includes('var(--dsw-alias-label-secondary)')) fail('menu button does not use an official colour token');
if (!/width:\s*40px/.test(menuCss) || !/height:\s*40px/.test(menuCss)) fail('menu button hot zone is not 40x40');
if (/box-shadow|#fff|#000|rgba\(/.test(menuCss)) fail('menu button hard-codes a colour or a shadow');
const menuActive = /body\[data-dshm-surface="mobile"\] \.dshm-menu:active \{([^}]*)\}/.exec(css);
if (!menuActive) fail('menu button has no pressed state');
if (/box-shadow|#fff|#000|rgba\(/.test(menuActive?.[1] ?? '')) fail('menu button pressed state hard-codes a colour');
if (!css.includes('body[data-dshm-surface="mobile"] .dshm-menu svg')) fail('menu glyph size is not pinned to 20px');
if (!css.includes('var(--dsw-alias-interactive-bg-hover)')) fail('menu pressed state does not use the official hover token');
// ---- DOM contract ---------------------------------------------------------
// Only client.sidebar.js may name a compressed CSS-module class; every other
// file — the stylesheet included — has to go through the data-dshm-* markers.
const CONTRACT_CLASSES = [
  '_frame',
  '_sidebarCol',
  '_centerCol',
  '_rightbarCol',
  '_toggle',
  '_handle',
  '_newSession',
  '_panelList',
  '_regionArea',
  '_footArea',
  '_logoRow',
  '_panelIcon',
  '_railMark',
];
for (const file of ['client.js', 'client.styles.js', 'client.deeplink.js', 'client.notify.js', 'client.resource-compat.js', 'client.forensics.js', 'client.settings.js', 'client.diagnostics.js']) {
  const text = readFileSync(`${dir}/${file}`, 'utf8');
  const leaked = CONTRACT_CLASSES.filter((name) => text.includes(name));
  if (leaked.length > 0) fail(`${file} names a sidebar contract class: ${leaked.join(', ')}`);
}
const sidebarSource = readFileSync(`${dir}/client.sidebar.js`, 'utf8');
for (const name of ['_sidebarCol', '_centerCol', '_rightbarCol', '_toggle', '_handle']) {
  if (!sidebarSource.includes(name)) fail(`client.sidebar.js SEL table lost ${name}`);
}

const menuSlot = slots.find((slot) => slot.definition.id === 'dsh-mobile-menu');
const floatingSlot = slots.find((slot) => slot.definition.id === 'dsh-mobile-toggle');
const overlaySlot = slots.find((slot) => slot.definition.name === 'shell.overlay' && slot.definition.id === 'dsh-mobile-notify');
const settingsSlot = slots.find((slot) => slot.definition.name === 'settings.section');
if (!menuSlot) fail('header menu button slot not registered');
if (menuSlot.definition.name !== 'conversation.header.leading') {
  fail(`menu button registered in ${menuSlot.definition.name}, expected conversation.header.leading`);
}
if (floatingSlot) fail('the removed floating button is still registered in shell.overlay');
if (slots.some((slot) => slot.definition.name === 'shell.overlay' && slot.definition.id === 'dsh-mobile-menu')) {
  fail('the menu button must not be registered in shell.overlay');
}
if (!overlaySlot) fail('notification pill slot not registered');
if (!settingsSlot) fail('settings.section slot not registered');
if (settingsSlot?.definition.label() !== 't:sTitle') fail('settings slot label uses the locale');
if (overlaySlot.component.name !== 'NotifyHint') fail('overlay component is not NotifyHint');

// ---- locale keys ----------------------------------------------------------
// Every t('key') in the shipped sources must exist in both dictionaries: a
// missing key renders as the literal key name in the UI, which is invisible
// until the branch that uses it is actually shown.
const sourceFiles = [
  'client.js',
  'client.styles.js',
  'client.sidebar.js',
  'client.deeplink.js',
  'client.notify.js',
  'client.resource-compat.js',
  'client.forensics.js',
  'client.settings.js',
  'client.diagnostics.js',
];
const usedKeys = new Set();
for (const file of sourceFiles) {
  const text = readFileSync(`${dir}/${file}`, 'utf8');
  for (const match of text.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)) usedKeys.add(match[1]);
}
if (usedKeys.size === 0) fail('locale key scan found nothing');
for (const language of ['en', 'zh']) {
  const messages = localeMessages[language] ?? {};
  const missing = [...usedKeys].filter((key) => !(key in messages));
  if (missing.length > 0) fail(`locale ${language} is missing t() keys: ${missing.join(', ')}`);
}

// ---- markers --------------------------------------------------------------
if (body.getAttribute('data-dshm-surface') !== 'mobile') fail('surface marker not set on a narrow viewport');
if (frame.getAttribute('data-dshm-frame') === null) fail('frame not marked');
if (sidecol.getAttribute('data-dshm-sidecol') === null) fail('sidebar column not marked');
if (center.getAttribute('data-dshm-center') === null) fail('center column not marked');
if (rightcol.getAttribute('data-dshm-rightcol') === null) fail('right column not marked');

const sidebarExports = loadCache.get('client.sidebar.js');
for (const key of ['installSidebar', 'makeMenuButton', 'SEL', 'MARK']) {
  if (!sidebarExports?.[key]) fail(`sidebar missing ${key}`);
}
if (sidebarExports?.makeSidebarToggle) fail('client.sidebar.js still exports the removed floating toggle');
if (!Object.keys(sidebarExports?.MARK ?? {}).every((key) => key !== 'rail')) fail('the rail marker is still declared');
if (!/^\[class\*="_sidebarCol"\]$/.test(sidebarExports.SEL.sidebarCol)) fail('SEL.sidebarCol is not the documented selector');
if (!/^\[class\*="_toggle"\]$/.test(sidebarExports.SEL.toggle)) fail('SEL.toggle is not the documented selector');

// ---- state machine -------------------------------------------------------
// Two states only: hidden (conversation full screen) and drawer (the sidebar
// over the conversation). Both transitions are the official toggle; the plugin
// writes no state of its own, so `data-dshm-rail` must never appear.
const menuUi = menuSlot;
const renderMenu = () => {
  hookCursor = 0;
  hookState = [];
  hookEffects = [];
  return menuUi.component();
};

const button = renderMenu();
if (!button || button.type !== 'button') fail('header menu button does not render on the mobile surface');
if (button.props.className !== 'dshm-menu') fail(`unexpected menu button class: ${button.props.className}`);
if (button.props['data-dshm-toggle'] !== 'menu') fail(`unexpected toggle marker: ${button.props['data-dshm-toggle']}`);
if (button.props['aria-label'] !== 't:navHidden') fail('button label for the hidden state');

const glyph = button.children[0];
if (!glyph || glyph.type !== 'svg') fail('menu button does not render an svg glyph');
if (glyph?.props?.width !== 20 || glyph?.props?.height !== 20) fail('menu glyph is not 20x20');
if (glyph?.props?.fill !== 'none') fail('menu glyph is not stroke-only');
if (glyph?.props?.stroke !== 'currentColor') fail('menu glyph does not inherit its colour');
if (glyph?.props?.strokeWidth !== 1.6) fail('menu glyph stroke width changed');
const glyphLines = (glyph?.children ?? []).flat();
if (glyphLines.length !== 3 || glyphLines.some((line) => line.type !== 'line')) {
  fail('menu glyph is not three lines');
}

button.props.onClick();
if (toggles !== 1) fail(`hidden -> drawer should call the official toggle once, got ${toggles}`);
if (frame.hasAttribute('data-sidebar-collapsed')) fail('frame is still collapsed after opening the drawer');
if (body.getAttribute('data-dshm-rail') !== null) fail('a rail marker appeared on the way into the drawer');

// drawer -> hidden: the same official toggle, nothing else.
const drawerButton = renderMenu();
if (drawerButton.props['aria-label'] !== 't:navDrawer') fail('button label for the drawer state');
drawerButton.props.onClick();
if (toggles !== 2) fail(`drawer -> hidden should call the official toggle once, got ${toggles}`);
if (!frame.hasAttribute('data-sidebar-collapsed')) fail('frame did not collapse');
if (body.getAttribute('data-dshm-rail') !== null) fail('drawer -> hidden left a rail marker behind');

// ---- drawer tap rules ----------------------------------------------------
// Taps inside the drawer close it, taps outside close it, and the official
// collapse button is left alone because it toggles the layout itself.
const setCollapsed = (collapsed) => {
  if (collapsed) frame.setAttribute('data-sidebar-collapsed', 'true');
  else frame.removeAttribute('data-sidebar-collapsed');
  for (const observer of observers) observer.callback([{ type: 'attributes', attributeName: 'data-sidebar-collapsed' }]);
};
const fire = (type, target) => {
  for (const item of documentListeners.filter((entry) => entry.type === type)) item.fn({ target });
};
const sessionRow = new FakeElement('div', ['hHd-Xa_row']);
sessionRow.parentElement = sidebarRoot;
const conversationRow = new FakeElement('div', ['wSkVaW_root']);
conversationRow.parentElement = center;

setCollapsed(false);
fire('click', sessionRow);
if (toggles !== 3) fail(`a session tap inside the drawer should close it once, got ${toggles}`);
if (!frame.hasAttribute('data-sidebar-collapsed')) fail('a session tap did not collapse the frame');

// A menu trigger inside the drawer (the account "more" button) opens a portal
// popover anchored to itself: closing the drawer would hide the anchor and the
// popover would fall back to the top-left corner, so it must be left alone.
const menuTrigger = new FakeElement('button', ['hHd-Xa_more']);
menuTrigger.setAttribute('aria-label', '账号菜单');
menuTrigger.setAttribute('aria-haspopup', 'menu');
menuTrigger.parentElement = sidebarRoot;
const menuTriggerGlyph = new FakeElement('svg', []);
menuTriggerGlyph.parentElement = menuTrigger;
menuTrigger.children.push(menuTriggerGlyph);

setCollapsed(false);
fire('click', menuTriggerGlyph);
if (toggles !== 3) fail(`a menu trigger tap inside the drawer must not close it, got ${toggles}`);
if (frame.hasAttribute('data-sidebar-collapsed')) fail('a menu trigger tap collapsed the drawer');
const menuTriggerLabel = new FakeElement('div', ['hHd-Xa_label']);
menuTriggerLabel.setAttribute('role', 'menu');
menuTriggerLabel.parentElement = sidebarRoot;
fire('click', menuTriggerLabel);
if (toggles !== 3) fail(`a role=menu tap inside the drawer must not close it, got ${toggles}`);
if (frame.hasAttribute('data-sidebar-collapsed')) fail('a role=menu tap collapsed the drawer');

// The account menu and the settings dialog are portalled to `document.body`, so
// they are not inside the sidebar column even though a sidebar button opened
// them. A real finger tap is down … up one frame apart: the drawer hides on
// pointerdown, the anchor collapses, the menu jumps to the top-left corner and
// the click lands on the conversation instead of the menu item. The 0.5.1
// click-phase passthrough below never runs in that order — pointerdown must let
// portalled overlays through on its own.
const portalMenu = new FakeElement('div', ['_portal_4ub78_41']);
portalMenu.setAttribute('role', 'menu');
portalMenu.parentElement = body;
body.children.push(portalMenu);
const settingsItem = new FakeElement('div', ['_portal_4ub78_41_item']);
settingsItem.setAttribute('role', 'menuitem');
settingsItem.parentElement = portalMenu;
portalMenu.children.push(settingsItem);

setCollapsed(false);
fire('pointerdown', settingsItem);
if (toggles !== 3) fail(`a pointerdown on a portalled menu item must not close the drawer, got ${toggles}`);
if (frame.hasAttribute('data-sidebar-collapsed')) fail('a portalled menu item pointerdown collapsed the drawer');

const settingsDialog = new FakeElement('div', ['_portal_4ub78_41_dialog']);
settingsDialog.setAttribute('role', 'dialog');
settingsDialog.parentElement = body;
body.children.push(settingsDialog);
setCollapsed(false);
fire('pointerdown', settingsDialog);
if (toggles !== 3) fail(`a pointerdown inside the portalled settings dialog must not close the drawer, got ${toggles}`);
if (frame.hasAttribute('data-sidebar-collapsed')) fail('a settings dialog pointerdown collapsed the drawer');

// The same drawer, the same handler: an ordinary session row still closes it.
setCollapsed(false);
fire('click', sessionRow);
if (toggles !== 4) fail(`a session tap after a menu tap should still close it, got ${toggles}`);
if (!frame.hasAttribute('data-sidebar-collapsed')) fail('the drawer stayed open after a session tap');

setCollapsed(false);
fire('click', toggleButton);
if (toggles !== 4) fail('the official collapse button must be left to the official toggle');
if (frame.hasAttribute('data-sidebar-collapsed')) fail('the official toggle must not close the drawer from our handler');

setCollapsed(false);
fire('pointerdown', conversationRow);
if (toggles !== 5) fail(`a tap on the mask should close the drawer once, got ${toggles}`);
if (!frame.hasAttribute('data-sidebar-collapsed')) fail('a mask tap did not collapse the frame');

// Regression: the pointerdown passthrough must not swallow real outside taps.
// The conversation column is still an outside tap and still closes the drawer.
setCollapsed(false);
fire('pointerdown', center);
if (toggles !== 6) fail(`a pointerdown on the conversation column must still close the drawer, got ${toggles}`);
if (!frame.hasAttribute('data-sidebar-collapsed')) fail('a conversation-column pointerdown did not collapse the frame');

fire('pointerdown', conversationRow);
if (toggles !== 6) fail('an outside tap in the hidden state must not call the official toggle');

// Desktop: no button at all.
// Desktop: no button at all.
viewportMobile = false;
for (const observer of observers) observer.callback([{ type: 'childList' }]);
await new Promise((resolve) => setTimeout(resolve, 30));
hookCursor = 0;
hookState = [];
if (menuUi.component() !== null) fail('header menu button still renders on a desktop viewport');
if (body.getAttribute('data-dshm-surface') !== null) fail('surface marker survived the desktop resize');
viewportMobile = true;
for (const observer of observers) observer.callback([{ type: 'childList' }]);
await new Promise((resolve) => setTimeout(resolve, 30));

// ---- settings section stays lazy ----------------------------------------
hookCursor = 0;
hookState = [];
hookEffects = [];
const settingsRender = settingsSlot.component({});
if (settingsRender !== null) fail('settings section should render null before its chunk arrives');
for (const effect of hookEffects) effect();
await new Promise((resolve) => setTimeout(resolve, 60));
if (!loadCache.has('client.settings.js')) fail('settings chunk did not load on first render');
hookCursor = 0;
hookEffects = [];
if (!settingsSlot.component({})) fail('settings section rendered nothing after its chunk arrived');

// ---- notification API ---------------------------------------------------
const notifyApi = loadCache.get('client.notify.js')?.api;
for (const key of [
  'openSession',
  'makeNotifyHint',
  'watchNotifications',
  'watchFeed',
  'installServiceWorkerMessages',
  'registerServiceWorker',
  'readSettings',
  'writeSettings',
  'subscribeSettings',
  'pushWebhook',
  'fallbackNotice',
  'probeSecurePort',
  'secureUrlFor',
  'notificationState',
  'fetchSampleNotice',
]) {
  if (!notifyApi || typeof notifyApi[key] !== 'function') fail(`notify api missing ${key}`);
}
const deeplinkExports = loadCache.get('client.deeplink.js');
for (const key of ['installDeepLink', 'watchHashDeepLink']) {
  if (typeof deeplinkExports?.[key] !== 'function') fail(`deeplink missing ${key}`);
}

const settings = notifyApi.readSettings();
// The auto-answer fields left `readSettings()` in 0.5.4: deciding a stalled step
// is host-only now, so the browser half must not expose (or honour) them.
if (settings.browser !== true || settings.done !== true || settings.ask !== true) fail(`settings defaults changed: ${JSON.stringify(settings)}`);
if ('autoAnswer' in settings || 'timeoutSec' in settings) fail('browser auto-answer settings must be gone');
if (settings.webhook.kindChoice !== 'auto' || settings.webhook.kind !== 'generic') fail('webhook dialect inference changed');

// ---- browser settings live on the host (SPIC-41) -------------------------
const HOST_KEY = 'dsh-mobile:notify';

// 4. host value wins over the localStorage cache.
windowStub.localStorage.setItem(
  HOST_KEY,
  JSON.stringify({ browser: true, done: true, ask: true, webhook: { enabled: false, kind: 'auto', url: '' } }),
);
hostMock.down = false;
hostMock.stored = { browser: false, done: false, ask: false, webhook: { enabled: true, kind: 'dingtalk', url: 'https://ding.test/hook' } };
hostMock.posts.length = 0;
await notifyApi.syncHostSettings();
let current = notifyApi.readSettings();
if (current.browser !== false || current.done !== false || current.ask !== false) {
  fail(`host browser settings did not win: ${JSON.stringify(current)}`);
}
if (current.webhook.enabled !== true || current.webhook.kindChoice !== 'dingtalk' || current.webhook.url !== 'https://ding.test/hook') {
  fail(`host webhook settings did not win: ${JSON.stringify(current.webhook)}`);
}

// 5. host unreachable: the cache still renders and sync never throws.
windowStub.localStorage.setItem(
  HOST_KEY,
  JSON.stringify({ browser: true, done: false, ask: true, webhook: { enabled: false, kind: 'auto', url: '' } }),
);
hostMock.down = true;
await notifyApi.syncHostSettings().catch((error) => fail(`sync must not throw: ${error}`));
current = notifyApi.readSettings();
if (current.done !== false || current.browser !== true) fail(`fallback cache lost: ${JSON.stringify(current)}`);

// 6. a write POSTs browserSettings and updates the cache.
hostMock.down = false;
hostMock.stored = { browser: true, done: true, ask: true, webhook: { enabled: false, kind: 'auto', url: '' } };
hostMock.posts.length = 0;
const writeResult = await notifyApi.writeSettings({ done: false });
const post = hostMock.posts.at(-1);
if (!post?.browserSettings || post.browserSettings.done !== false) fail('write did not POST browserSettings');
if (!writeResult.ok) fail(`write reported failure: ${writeResult.error}`);
if (notifyApi.readSettings().done !== false) fail('write did not update the local cache');

// 7. a value the host never stored is migrated once; host values never are.

// 7a. Real old-cache shape: `kindChoice` is the user's `auto` choice while
// `kind` holds the dialect inferred when the value was last read. `auto` must
// survive the migration verbatim.
windowStub.localStorage.setItem(
  HOST_KEY,
  JSON.stringify({
    browser: true,
    done: false,
    ask: true,
    webhook: {
      enabled: true,
      kindChoice: 'auto',
      kind: 'dingtalk',
      url: 'https://oapi.dingtalk.com/robot/send?access_token=x',
    },
  }),
);
hostMock.stored = null;
hostMock.posts.length = 0;
await notifyApi.syncHostSettings();
const migrated = hostMock.posts[0]?.browserSettings;
if (!migrated || migrated.done !== false || migrated.webhook?.url !== 'https://oapi.dingtalk.com/robot/send?access_token=x') {
  fail(`local values were not migrated: ${JSON.stringify(hostMock.posts)}`);
}
if (migrated.webhook.kind !== 'auto') {
  fail(`old cache choice was frozen to the inferred dialect: ${JSON.stringify(migrated.webhook)}`);
}
console.log(`SPIC-41 old kindChoice=auto, kind=dingtalk -> migrated kind=${migrated.webhook.kind}`);

// 7b. An explicit old choice migrates as-is.
windowStub.localStorage.setItem(
  HOST_KEY,
  JSON.stringify({ browser: true, done: false, ask: true, webhook: { enabled: true, kindChoice: 'feishu', kind: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' } }),
);
hostMock.stored = null;
hostMock.posts.length = 0;
await notifyApi.syncHostSettings();
if (hostMock.posts[0]?.browserSettings?.webhook?.kind !== 'feishu') {
  fail(`explicit old choice was lost: ${JSON.stringify(hostMock.posts)}`);
}
console.log(`SPIC-41 old kindChoice=feishu -> migrated kind=${hostMock.posts[0].browserSettings.webhook.kind}`);

// 7c. New-cache shape: only `kind`, without `kindChoice`.
windowStub.localStorage.setItem(
  HOST_KEY,
  JSON.stringify({ browser: true, done: false, ask: true, webhook: { enabled: true, kind: 'auto', url: 'https://old.test/hook' } }),
);
hostMock.stored = null;
hostMock.posts.length = 0;
await notifyApi.syncHostSettings();
if (hostMock.posts[0]?.browserSettings?.webhook?.kind !== 'auto') {
  fail(`new cache auto was frozen to the inferred dialect: ${JSON.stringify(hostMock.posts)}`);
}
console.log(`SPIC-41 new kind=auto (no kindChoice) -> migrated kind=${hostMock.posts[0].browserSettings.webhook.kind}`);

// 7d. The host already has the kind: that subfield is not uploaded, even when
// another webhook subfield (url) is still missing and does get migrated.
windowStub.localStorage.setItem(
  HOST_KEY,
  JSON.stringify({ browser: true, done: true, ask: true, webhook: { enabled: false, kind: 'auto', url: 'https://local.test/hook' } }),
);
hostMock.stored = { browser: true, done: true, ask: true, webhook: { kind: 'dingtalk' } };
hostMock.posts.length = 0;
await notifyApi.syncHostSettings();
const partialMigration = hostMock.posts[0]?.browserSettings;
if (!partialMigration?.webhook || 'kind' in partialMigration.webhook) {
  fail(`migration uploaded a kind the host already had: ${JSON.stringify(hostMock.posts)}`);
}
if (hostMock.stored.webhook.kind !== 'dingtalk') fail('host kind was overwritten by migration');
console.log(`SPIC-41 host kind=dingtalk + local kind=auto -> POST webhook=${JSON.stringify(partialMigration.webhook)}`);

// A host that already has every field receives nothing at all.
windowStub.localStorage.setItem(
  HOST_KEY,
  JSON.stringify({ browser: true, done: true, ask: true, webhook: { enabled: false, kind: 'auto', url: '' } }),
);
hostMock.stored = { browser: false, done: false, ask: false, webhook: { enabled: true, kind: 'feishu', url: 'https://host.test/hook' } };
hostMock.posts.length = 0;
await notifyApi.syncHostSettings();
if (hostMock.posts.length !== 0) fail('migration overwrote values the host already had');
if (notifyApi.readSettings().browser !== false) fail('an existing host value did not win over the local cache');

await new Promise((resolve) => setTimeout(resolve, 1300));
if (!fetchCalls.some((call) => String(call.url).startsWith('/api/dsh-mobile/feed'))) fail('feed catch-up did not start');

// ---- stale approval cleanup (SPIC-42) ------------------------------------
// The host auto-answered: `running` drops to false while the approval stays
// pending, and the panel has to abort itself after the settle window. A human
// being asked keeps `running` true, so that one must survive.
const sessionWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const abortLog = [];
const approvalOf = (key, extra = {}) => ({
  key,
  kind: 'approval',
  toolName: 'bash',
  displayReason: 'please',
  abort(reason) {
    abortLog.push({ key, reason });
  },
  ...extra,
});
const rowOf = (running) => ({ displayTitle: '请立刻调用 bash 工具执行命令', cwd: '/tmp/dshm', running });
const snapshotOf = (rows, phase = 'ready') => {
  const byId = {};
  const ids = Object.keys(rows);
  for (const id of ids) byId[id] = rows[id];
  return { ids, byId, phase };
};
const statusOf = (entries) => new Map(entries.map(([id, status]) => [id, status]));

// 1 + 6. running true -> false and the first-paint idle case, one window.
abortLog.length = 0;
publishSessions(snapshotOf({ s1: rowOf(true), s2: rowOf(false) }));
publishStatuses(statusOf([
  ['s1', { pendingInteraction: approvalOf('a1') }],
  ['s2', { pendingInteraction: approvalOf('a2') }],
]));
await sessionWait(1000);
if (abortLog.length !== 0) fail('an approval was aborted before the settle window');
publishSessions(snapshotOf({ s1: rowOf(false), s2: rowOf(false) }));
await sessionWait(3200);
if (abortLog.length !== 2) fail(`expected both stale approvals to close once, got ${abortLog.length}`);
if (abortLog.map((entry) => entry.key).sort().join(',') !== 'a1,a2') fail(`unexpected stale approvals cleared: ${JSON.stringify(abortLog)}`);
if (!String(abortLog[0].reason?.message ?? '').includes('面板已过期')) fail('abort was not given the expired-panel reason');
publishStatuses(statusOf([
  ['s1', { pendingInteraction: approvalOf('a1') }],
  ['s2', { pendingInteraction: approvalOf('a2') }],
]));
await sessionWait(80);
if (abortLog.length !== 2) fail('the same approval was cleared more than once');
console.log('SPIC-42 running->idle and first-paint approvals -> aborted exactly once');

// 2 + 4. A human is being asked (running stays true); and no questions.
abortLog.length = 0;
publishSessions(snapshotOf({ s3: rowOf(true), s4: rowOf(false), s5: rowOf(false) }));
publishStatuses(statusOf([
  ['s3', { pendingInteraction: approvalOf('a3') }],
  ['s4', { pendingInteraction: { key: 'q1', kind: 'question', questions: [{ header: 'pick' }], dismiss() {} } }],
  ['s5', { pendingInteraction: { key: 'p1', kind: 'plan-review', abort: (reason) => abortLog.push({ key: 'p1', reason }) } }],
]));
await sessionWait(3200);
if (abortLog.length !== 0) fail(`question / plan-review / live approval must not be aborted: ${JSON.stringify(abortLog)}`);
console.log('SPIC-42 running approval, question and plan-review left alone');

// 3. The list is not ready yet: do not touch anything.
abortLog.length = 0;
publishSessions(snapshotOf({ s7: rowOf(false) }, 'loading'));
publishStatuses(statusOf([['s7', { pendingInteraction: approvalOf('a7') }]]));
await sessionWait(3200);
if (abortLog.length !== 0) fail('an approval was aborted while the session list was still loading');
console.log('SPIC-42 phase=loading -> no abort');

// 5. The turn resumes inside the window: the clock starts over.
abortLog.length = 0;
publishSessions(snapshotOf({ s8: rowOf(false) }));
publishStatuses(statusOf([['s8', { pendingInteraction: approvalOf('a8') }]]));
await sessionWait(1200);
publishSessions(snapshotOf({ s8: rowOf(true) }));
await sessionWait(2000);
if (abortLog.length !== 0) fail('a session that went back to running was cleared as stale');
publishSessions(snapshotOf({ s8: rowOf(false) }));
await sessionWait(3200);
if (abortLog.length !== 1) fail('the restarted settle window did not clear the approval');
console.log('SPIC-42 resumed turn cancels the window, the next idle window still clears');

// 7. abort throws when the interaction already settled: scan keeps working.
abortLog.length = 0;
let abortThrows = 0;
publishSessions(snapshotOf({ s9: rowOf(false) }));
publishStatuses(statusOf([
  ['s9', {
    pendingInteraction: approvalOf('a9', {
      abort() {
        abortThrows += 1;
        throw new Error('already settled');
      },
    }),
  }],
]));
await sessionWait(3200);
if (abortThrows !== 1) fail(`a throwing abort ran ${abortThrows} times, expected 1`);
publishSessions(snapshotOf({ s10: rowOf(false) }));
publishStatuses(statusOf([['s10', { pendingInteraction: approvalOf('a10') }]]));
await sessionWait(3200);
if (abortLog.length !== 1 || abortLog[0].key !== 'a10') fail('scanning stopped working after abort threw');
console.log('SPIC-42 a throwing abort does not break later scans');

publishSessions(snapshotOf({}));
publishStatuses(new Map());

// ---- diagnostics (P3) ----------------------------------------------------
const diagnostics = await makeRequire('dsh-mobile').async('./client.diagnostics.js');
for (const key of ['createPanel', 'collect']) {
  if (typeof diagnostics?.[key] !== 'function') fail(`diagnostics missing ${key}`);
}

// ---- forensics recorder --------------------------------------------------
const forensicsModule = loadCache.get('client.forensics.js');
for (const key of ['install', 'current']) {
  if (typeof forensicsModule?.[key] !== 'function') fail(`forensics missing ${key}`);
}
const recorder = forensicsModule.current();
if (!recorder) fail('the entry did not install the forensics recorder');

// The wrapper has to stay invisible: same observable object, same notification
// semantics, so the official resource hook keeps its identity-keyed cache.
const sampleAddress = 'dsh-resource://file/session/s1/home/me/notes.md';
const wrapped = services.resources.source(sampleAddress);
if (wrapped !== rawResourceSource(sampleAddress)) fail('resources.source no longer returns the original observable');
if (wrapped.subscribe === undefined || wrapped.getSnapshot === undefined) fail('the wrapped source lost its observable shape');

let beats = 0;
const stop = wrapped.subscribe(() => {
  beats += 1;
});
setResourceStatus(sampleAddress, 'live');
if (beats !== 1) fail(`wrapped subscribe changed the notification count: ${beats}`);
if (wrapped.getSnapshot().status !== 'live') fail('wrapped getSnapshot does not read through to the record');
stop();
setResourceStatus(sampleAddress, 'loading');
if (beats !== 1) fail('unsubscribe no longer stops notifications');
setResourceStatus(sampleAddress, 'live');

const recorded = recorder.rows().find((row) => row.address === sampleAddress);
if (!recorded) fail('the recorder did not record the subscription');
if (recorded?.protocol !== 'file') fail(`recorded protocol ${recorded?.protocol}`);
if (recorded?.providerAtSubscribe !== 'yes') fail(`recorded provider-at-subscribe ${recorded?.providerAtSubscribe}`);
const recordedStatuses = recorded?.states?.map((state) => state.status) ?? [];
if (recordedStatuses[0] !== 'loading' || !recordedStatuses.includes('live')) {
  fail(`recorded status sequence ${recordedStatuses.join(' -> ')}`);
}

// ---- resource compat: the empty-host protocol key (Huawei browsers) -------
// The official registry keys a record by the URL host, and this build's
// providerOf() answers nothing for the `undefined` key. The fakes below keep
// that shape, so the alias is proven against the real contract.
const compatModule = loadCache.get('client.resource-compat.js');
for (const key of ['install', 'parserBroken', 'current']) {
  if (typeof compatModule?.[key] !== 'function') fail(`resource-compat missing ${key}`);
}
const bootCompat = compatModule.current();
if (!bootCompat) fail('the entry did not install the resource compat shim');
if (bootCompat.active) fail('the compat alias activated although the URL parser is normal');
if (registeredProviders.length !== 0) fail('the compat shim registered an alias on a normal parser');
if (compatModule.parserBroken() !== false) fail('the probe reports a broken parser under Node');
if (bootCompat.report().detail !== 'no (url parser normal)') fail(`inert alias detail: ${bootCompat.report().detail}`);
bootCompat.dispose();

const compatCtx = (service) => ({ get: (name) => (name === 'resources' ? service : undefined) });
const liveFrame = { ok: true, value: { absolutePath: '/home/me/notes.md', version: 1 } };
const fakeFileProvider = () => ({
  opened: [],
  protocol: 'file',
  async *open(address, opts) {
    this.opened.push({ address, opts });
    yield liveFrame;
  },
});

// 1. normal parser: no registration, even with the provider available.
const inert = compatModule.install(
  compatCtx({
    providerOf: () => ({}),
    register: () => {
      throw new Error('must not register');
    },
  }),
  { broken: false },
);
if (inert.active) fail('compat activated with an explicit normal-parser probe');
if (inert.report().detail !== 'no (url parser normal)') fail(`inert detail: ${inert.report().detail}`);
inert.dispose();

// 2. broken parser, provider present: registered under `undefined`, only after
//    the lookup bridge can answer that key; file addresses forwarded, others
//    answered with a failure frame (never a throw).
const aliasProvider = fakeFileProvider();
const registry = {
  providers: new Map([['file', aliasProvider]]),
  register(candidate) {
    const { protocol } = candidate;
    if (this.providers.has(protocol)) throw new Error(`resources: protocol "${protocol}" already has a provider`);
    this.bridgeAtRegister = this.providerOf(undefined) === candidate;
    this.providers.set(protocol, candidate);
    this.registered = candidate;
    return () => {
      this.released = candidate;
      this.providers.delete(protocol);
    };
  },
  providerOf(protocol) {
    return protocol === undefined ? undefined : this.providers.get(protocol);
  },
};
const compat = compatModule.install(compatCtx(registry), { broken: true, pollMs: 5, limitMs: 200 });
if (!compat.active) fail('compat did not activate with the file provider present');
if (compat.report().detail !== 'yes · via file provider') fail(`active detail: ${compat.report().detail}`);
if (!registry.registered) fail('compat registered no alias');
if (registry.registered?.protocol !== undefined) fail('the alias is not keyed undefined');
if (!registry.bridgeAtRegister) fail('the alias was registered before providerOf(undefined) answered it');
if (registry.providerOf(undefined) !== registry.registered) fail('providerOf(undefined) does not resolve to the alias');
if (registry.providerOf('file') !== aliasProvider) fail('the bridge stopped delegating the file key');
const forwarded = [];
for await (const frame of registry.registered.open(sampleAddress, { signal: 'sig' })) forwarded.push(frame);
if (forwarded.length !== 1 || forwarded[0] !== liveFrame) fail('the alias did not forward the official frame');
if (aliasProvider.opened[0]?.address !== sampleAddress || aliasProvider.opened[0]?.opts?.signal !== 'sig') {
  fail('the alias changed the address or dropped the signal');
}
const refused = [];
for await (const frame of registry.registered.open('dsh-resource://workspace/session/s1/home/me/notes.md', {})) {
  refused.push(frame);
}
if (refused.length !== 1 || refused[0]?.ok !== false) fail('the alias did not refuse a non-file address');
if (refused[0]?.error?.code !== 'workspace-file/unsupported-address') fail(`unexpected refusal code: ${refused[0]?.error?.code}`);
compat.dispose();
if (registry.released !== registry.registered) fail('dispose did not release the alias registration');
if (registry.providerOf(undefined) !== undefined) fail('dispose did not restore providerOf');
if (registry.providerOf('file') !== aliasProvider) fail('dispose broke the official file lookup');

// 2c. the heal itself: a preview that subscribed while the `undefined` key had
//     no provider sits at `none` (the "服务不可用" branch). The alias
//     registration re-attaches it, and the stream turns `live`.
const healingProvider = fakeFileProvider();
const healingRegistry = (() => {
  const providers = new Map([['file', healingProvider]]);
  const records = new Map();
  const start = (record) => {
    const provider = registry.providerOf(record.protocol);
    if (provider === undefined) return;
    record.status = 'loading';
    void (async () => {
      for await (const frame of provider.open(record.address, {})) {
        record.status = frame.ok ? 'live' : 'failed';
        record.value = frame.ok ? frame.value : record.value;
        for (const listener of [...record.listeners]) listener();
      }
    })();
  };
  const attach = (record) => {
    if (record.holders > 0) start(record);
    else record.status = 'loading';
  };
  const registry = {
    records,
    providerOf(protocol) {
      return protocol === undefined ? undefined : providers.get(protocol);
    },
    register(provider) {
      const { protocol } = provider;
      if (providers.has(protocol)) throw new Error(`resources: protocol "${protocol}" already has a provider`);
      providers.set(protocol, provider);
      for (const record of records.values()) if (record.protocol === protocol) attach(record);
      return () => {
        providers.delete(protocol);
        for (const record of records.values()) {
          if (record.protocol === protocol && record.holders > 0) {
            record.status = registry.providerOf(record.protocol) === undefined ? 'none' : 'loading';
          }
        }
      };
    },
    source(address) {
      let record = records.get(address);
      if (record === undefined) {
        // The ArkWeb parser: every dsh-resource address keys as undefined.
        record = { address, protocol: undefined, holders: 0, listeners: new Set(), status: 'none' };
        record.source = {
          getSnapshot: () => ({ status: record.status, value: record.value }),
          subscribe: (listener) => {
            record.listeners.add(listener);
            record.holders += 1;
            if (record.holders === 1) start(record);
            return () => {
              record.listeners.delete(listener);
              record.holders -= 1;
            };
          },
        };
        records.set(address, record);
      }
      return record.source;
    },
  };
  return registry;
})();
const healAddress = 'dsh-resource://file/session/s1/home/me/heal.md';
const healSource = healingRegistry.source(healAddress);
let healBeats = 0;
const stopHeal = healSource.subscribe(() => {
  healBeats += 1;
});
if (healSource.getSnapshot().status !== 'none') fail(`unexpected pre-alias status: ${healSource.getSnapshot().status}`);
const healer = compatModule.install(compatCtx(healingRegistry), { broken: true, pollMs: 5, limitMs: 200 });
await new Promise((resolve) => setTimeout(resolve, 40));
if (healSource.getSnapshot().status !== 'live') fail(`the alias did not heal a held record: ${healSource.getSnapshot().status}`);
if (healSource.getSnapshot().value?.absolutePath !== '/home/me/notes.md') fail('the healed record lost the frame value');
if (healBeats === 0) fail('the preview listener was not notified of the heal');
healer.dispose();
if (healSource.getSnapshot().status !== 'none') fail(`dispose left the record at ${healSource.getSnapshot().status}`);
stopHeal();

// 2b. the `undefined` key already belongs to somebody else: log, restore the
//     bridge, and never retry.
let takenAttempts = 0;
const taken = {
  providerOf: (protocol) => (protocol === undefined ? undefined : aliasProvider),
  register() {
    takenAttempts += 1;
    throw new Error('resources: protocol "undefined" already has a provider');
  },
};
const takenCompat = compatModule.install(compatCtx(taken), { broken: true, pollMs: 5, limitMs: 100 });
await new Promise((resolve) => setTimeout(resolve, 40));
if (takenCompat.active) fail('compat claims to be active although register() threw');
if (takenAttempts !== 1) fail(`register() was retried ${takenAttempts} times`);
if (taken.providerOf(undefined) !== undefined) fail('a failed register left the providerOf bridge behind');
if (!takenCompat.report().detail.startsWith('no (register failed')) fail(`unexpected failed detail: ${takenCompat.report().detail}`);
takenCompat.dispose();

// 3. provider arrives after the chunk: polling picks it up.
const late = {
  official: aliasProvider,
  ready: false,
  providerOf(protocol) {
    if (protocol === undefined || !this.ready) return undefined;
    return this.official;
  },
  register(candidate) {
    this.registered = candidate;
    return () => {
      this.released = candidate;
    };
  },
};
const lateCompat = compatModule.install(compatCtx(late), { broken: true, pollMs: 10, limitMs: 500 });
if (lateCompat.active) fail('compat activated before the file provider existed');
if (late.registered) fail('compat registered before the file provider existed');
late.ready = true;
await new Promise((resolve) => setTimeout(resolve, 60));
if (!lateCompat.active) fail('compat did not register when the provider arrived late');
if (late.registered?.protocol !== undefined) fail('the late alias is not keyed undefined');
lateCompat.dispose();
if (late.released !== late.registered) fail('dispose did not release the late alias');

// 4. no provider ever: give up at the limit instead of polling forever.
const never = compatModule.install(compatCtx({ providerOf: () => undefined, register: () => {} }), {
  broken: true,
  pollMs: 5,
  limitMs: 30,
});
await new Promise((resolve) => setTimeout(resolve, 80));
if (never.active) fail('compat activated without any provider');
if (!never.report().detail.includes('never appeared')) fail(`unexpected give-up detail: ${never.report().detail}`);
never.dispose();

// The desktop/Chromium instance whose report the diagnostics section prints.
const desktopCompat = compatModule.install(compatCtx(services.resources), { broken: false });

const cleanDeps = {
  ctx,
  forensics: recorder,
  resourceCompat: desktopCompat,
  chunkStatus: new Map([
    ['styles', { ok: true }],
    ['sidebar', { ok: true }],
    ['notify', { ok: true }],
  ]),
  menu: { slot: 'conversation.header.leading', registered: true, error: '' },
  sidebar: {
    diagnostics: () => ({
      surface: true,
      state: 'hidden',
      marked: { frame: true, sidecol: 1, center: 1, rightcol: 1 },
      selectors: { sidebarCol: 1, centerCol: 1, rightbarCol: 1, toggle: 1, handle: 0 },
    }),
  },
  api: { notificationState: () => 'granted' },
  t: (key) => `t:${key}`,
};

const clean = await diagnostics.collect(cleanDeps).catch((error) => {
  fail(`diagnostics collect threw on a proxy ctx: ${error.message}`);
  return { text: '', problems: [] };
});
if (!clean.text.includes('=== dsh-mobile diagnostics ===')) fail('diagnostics report header');
if (!clean.text.includes('-- client modules (2 rows, 1 plugins) --')) fail('diagnostics module section');
if (!clean.text.includes('import errors: none')) fail('diagnostics did not report a clean module graph');
if (!clean.text.includes('-- conclusion --')) fail('diagnostics report has no conclusion');
if (clean.problems.length !== 0) fail(`clean diagnostics raised problems: ${clean.problems.join(' | ')}`);
if (!clean.text.includes('no problems detected')) fail('clean diagnostics conclusion');
if (!clean.text.includes('file provider yes')) fail('diagnostics lost the official file provider row');
if (!clean.text.includes('unparsed alias no (url parser normal)')) {
  fail('diagnostics did not report the inert compat alias');
}
if (clean.text.includes('the compatibility alias took over')) fail('a normal parser must not report a takeover');
if (!clean.text.includes('slot conversation.header.leading')) fail('diagnostics lost the menu slot row');
if (!clean.text.includes('registered yes · mounted yes')) fail('diagnostics did not report the mounted menu button');
if (!/^state\s+hidden$/m.test(clean.text)) fail('diagnostics lost the two-state layout row');
if (/^state\s+.*rail/m.test(clean.text)) fail('diagnostics still prints a rail fact');
if (!clean.text.includes('-- resource subscriptions --')) fail('diagnostics has no resource subscriptions section');
if (!clean.text.includes('-- console --')) fail('diagnostics has no console section');
if (!clean.text.includes(sampleAddress)) fail('diagnostics dropped the recorded address');
if (!clean.text.includes('protocol file')) fail('diagnostics did not print the protocol');
if (!clean.text.includes('provider-at-subscribe yes')) fail('diagnostics did not print the provider at subscribe');
if (!/loading.*live/.test(clean.text)) fail('diagnostics did not print the status sequence');
if (!clean.text.includes('failure-moment none observed')) fail('diagnostics has no failure-moment row');
if (!clean.text.includes('errors: none')) fail('diagnostics console section');

const broken = await diagnostics
  .collect({
    ...cleanDeps,
    ctx: new Proxy(
      {
        get: (name) =>
          name === 'modules'
            ? {
                manifest: { modules: [{ id: 'x' }, { id: 'y' }], plugins: [] },
                importError: (id) => (id === 'y' ? new Error('could not load "y"') : undefined),
              }
            : undefined,
      },
      {
        get(target, prop, receiver) {
          if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
          throw new Error(`cannot get property "${String(prop)}" without inject`);
        },
      },
    ),
    chunkStatus: new Map([
      ['styles', { ok: true }],
      ['settings', { ok: false, error: 'HTTP 404' }],
    ]),
  })
  .catch((error) => {
    fail(`diagnostics collect threw on a failing graph: ${error.message}`);
    return { text: '', problems: [] };
  });
if (!broken.text.includes('FAILED y')) fail('diagnostics did not list the failing module');
if (!broken.text.includes('could not load "y"')) fail('diagnostics dropped the loader message');
if (!broken.text.includes('FAILED settings')) fail('diagnostics did not list the failing chunk');
if (!broken.text.includes('HTTP 404')) fail('diagnostics dropped the chunk error');
if (!broken.problems.some((item) => item.includes('client module'))) fail('conclusion missed the module failure');
if (!broken.problems.some((item) => item.includes('chunk'))) fail('conclusion missed the chunk failure');
if (!broken.problems.some((item) => item.includes('resources'))) fail('conclusion missed the missing resources service');

// ---- forensics: a console error does not turn the report red -----------------
const errorListeners = documentListeners.filter((item) => item.type === 'error');
if (errorListeners.length === 0) fail('no window error listener was installed');
for (const listener of errorListeners) {
  try {
    listener.fn({ message: 'boom from the harness', error: new Error('boom from the harness') });
  } catch (error) {
    fail(`error listener threw: ${error.message}`);
  }
}
const withConsole = await diagnostics.collect({ ...cleanDeps, forensics: recorder });
if (!withConsole.text.includes('[dsh-mobile]') && !withConsole.text.includes('boom from the harness')) {
  fail('diagnostics dropped the console error');
}
if (withConsole.problems.length !== 0) fail(`a console row must stay out of the conclusion: ${withConsole.problems.join(' | ')}`);

// A mobile surface whose header menu button never reached the DOM is a finding:
// it is the only way into the sidebar now.
menuMounted = false;
const noMenu = await diagnostics.collect({ ...cleanDeps });
menuMounted = true;
if (!noMenu.text.includes('mounted no')) fail('diagnostics did not report the missing menu button');
if (!noMenu.problems.some((item) => item.includes('header menu button'))) {
  fail('a missing header menu button is not in the conclusion');
}
if (!withConsole.text.includes('no problems detected')) fail('a console row made the report fail');

// ---- forensics: the failure moment keeps its own snapshot -------------------
body.textContent = '右侧面板：文件资源服务不可用';
for (const observer of observers) observer.callback([{ type: 'childList', target: body, addedNodes: [] }]);
const moment = recorder.failure();
if (!moment) fail('the failure moment was not recorded');
if (!String(moment?.needle).includes('文件资源服务不可用')) fail(`wrong failure needle: ${moment?.needle}`);
if (!moment?.snapshot?.some((row) => row.address === sampleAddress)) fail('the failure snapshot is missing the subscription');
const withFailure = await diagnostics.collect({ ...cleanDeps, forensics: recorder });
if (!withFailure.text.includes('failure-moment ')) fail('diagnostics did not print the failure moment');
if (!withFailure.text.includes('snapshot at that moment')) fail('diagnostics did not print the snapshot at the failure moment');
if (!withFailure.problems.some((item) => item.includes('文件资源服务不可用'))) fail('the conclusion missed the failure moment');

// ---- forensics: a subscription that never leaves none ----------------------
const stuckAddress = 'dsh-resource://workspace/session/s1/home/me/notes.md';
const stopStuck = services.resources.source(stuckAddress).subscribe(() => {});
const withStuck = await diagnostics.collect({ ...cleanDeps, forensics: recorder });
if (!withStuck.text.includes('protocol workspace')) fail('the recorder did not print the odd protocol');
if (!withStuck.problems.some((item) => item.includes(stuckAddress))) fail('a subscription stuck at none is not reported');
stopStuck();

// ---- compat alias in the report ------------------------------------------
// A record keyed `undefined` (empty URL host) is what the Huawei parser makes of
// every file address; with the alias active the report explains why that record
// still reaches the file provider, without turning the conclusion red.
const activeCompat = { report: () => ({ broken: true, active: true, status: 'active', note: '', detail: 'yes · via file provider' }) };
const noHostAddress = 'dsh-resource:///session/s1/home/me/empty-host.md';
const stopNoHost = services.resources.source(noHostAddress).subscribe(() => {});
const withAlias = await diagnostics.collect({ ...cleanDeps, resourceCompat: activeCompat });
if (!withAlias.text.includes('unparsed alias yes · via file provider')) fail('diagnostics lost the active alias row');
if (!withAlias.text.includes('protocol no-protocol')) fail('diagnostics did not record the empty-host protocol');
if (!withAlias.text.includes('note: the compatibility alias took over')) {
  fail('diagnostics did not explain the healed empty-host subscription');
}
stopNoHost();

// A broken parser whose alias never registered is a finding, not a silent one.
const failedCompat = { report: () => ({ broken: true, active: false, status: 'failed', note: 'register failed: taken', detail: 'no (register failed: taken)' }) };
const withFailedAlias = await diagnostics.collect({ ...cleanDeps, resourceCompat: failedCompat });
if (!withFailedAlias.problems.some((item) => item.includes('compatibility alias is not active'))) {
  fail('a failed alias did not reach the conclusion');
}
desktopCompat.dispose();

// Settings page -> diagnostics chunk wiring: the card asks the entry's loader
// on the first click, then renders the panel it gets back.
let panelLoads = 0;
function MarkerPanel() {
  return { type: 'div', props: { className: 'marker' }, children: [] };
}
const settingsExports = loadCache.get('client.settings.js');
settingsExports.install(notifyApi, {
  ctx: cleanDeps.ctx,
  chunkStatus: cleanDeps.chunkStatus,
  sidebar: cleanDeps.sidebar,
  loadDiagnostics: () => {
    panelLoads += 1;
    return Promise.resolve({ createPanel: () => MarkerPanel });
  },
});

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};
const findElement = (tree, predicate) => {
  let found = null;
  walk(tree, (node) => {
    if (!found && node.type && predicate(node)) found = node;
  });
  return found;
};
const renderHooks = (component, props, reset) => {
  if (reset) hookState = [];
  hookCursor = 0;
  hookEffects = [];
  const tree = component(props);
  for (const effect of hookEffects) effect();
  return tree;
};

const page = renderHooks(settingsExports.makeSettingsPage((key) => `t:${key}`), {}, true);
if (!page) fail('settings page rendered nothing');
// The page's mount effect syncs with the host; let it settle before the next
// component's hook state is inspected (this fake React keys state by index).
await new Promise((resolve) => setTimeout(resolve, 50));
const card = findElement(page, (node) => typeof node.type === 'function' && node.type.name === 'DiagnosticsSection');
if (!card) fail('settings page has no diagnostics card');

let cardTree = renderHooks(card.type, {}, true);
const openButton = findElement(cardTree, (node) => node.type === 'button' && node.props.className === 'dshm-btn');
if (!openButton) fail('diagnostics card has no open button');
openButton.props.onClick();
if (panelLoads !== 1) fail(`diagnostics loader called ${panelLoads} times, expected 1`);
await new Promise((resolve) => setTimeout(resolve, 20));
cardTree = renderHooks(card.type, {}, false);
if (!findElement(cardTree, (node) => node.type === MarkerPanel)) fail('diagnostics panel did not render after loading');


// ---- disposal ------------------------------------------------------------
for (const dispose of effects.reverse()) {
  try {
    if (typeof dispose === 'function') dispose();
  } catch (error) {
    fail(`dispose threw: ${error.message}`);
  }
}
if (body.getAttribute('data-dshm-rail') !== null) fail('a rail marker existed at all');
if (services.resources.source !== pristineResourceSource) fail('dispose did not restore resources.source');

console.log(log.join('\n'));
console.log(process.exitCode ? 'HARNESS FAILED' : 'HARNESS OK');
