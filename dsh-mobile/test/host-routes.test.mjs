/**
 * Host half: the auto-answer settings route, end to end inside Node.
 *
 *   node --test test/host-routes.test.mjs
 *
 * Runs the real `apply()` against a fake ctx (effect/on/webServer/connection),
 * then drives the registered HTTP handlers with real Request objects. That
 * covers what a restart would otherwise be needed to check: the route contract,
 * the read-merge-write, and that a browser request cannot drop channel secrets.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';

function fakeCtx(home) {
  const publicRoutes = [];
  const fetchRoutes = [];
  const listeners = new Map();
  const connection = {
    fetch: {
      register(route) {
        fetchRoutes.push(route);
        return () => {};
      },
    },
  };
  const ctx = {
    // `inject` delivers the requested services immediately here; the real
    // runtime calls back once the service exists (that timing is the bug this
    // plugin previously shipped, so the fake must go through inject too).
    inject(dependencies, callback) {
      callback(ctx);
      return () => {};
    },
    connection,
    effect(fn) {
      const dispose = fn();
      return dispose;
    },
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    get(name) {
      if (name === 'dshHomePath') return () => home;
      if (name === 'connection') return connection;
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {} },
    webServer: {
      register(route) {
        publicRoutes.push(route);
        return () => {};
      },
    },
  };
  return { ctx, publicRoutes, fetchRoutes, listeners };
}

const settingsFile = (home) => path.join(home, 'dsh-mobile', 'settings.json');
const readSettings = (home) => JSON.parse(readFileSync(settingsFile(home), 'utf8'));

function callPublic(route, { method = 'GET', url = route.path } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        if (body) chunks.push(Buffer.from(body));
        resolve({ status: this.status, headers: this.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      },
    };
    route.handler({ method, url, headers: { host: '127.0.0.1:3081' } }, res);
  });
}

async function callFetch(route, { method = 'GET', body } = {}) {
  const request = new Request(`http://127.0.0.1:3081${route.path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await route.fetch(request);
  return { status: response.status, body: await response.json() };
}

function setup(initialSettings) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-mobile-home-'));
  if (initialSettings) {
    mkdirSync(path.join(home, 'dsh-mobile'), { recursive: true });
    writeFileSync(settingsFile(home), JSON.stringify(initialSettings, null, 2));
  }
  const { ctx, publicRoutes, fetchRoutes } = fakeCtx(home);
  apply(ctx, { notify: { baseUrl: 'https://example.test:3088' } });
  const metaRoute = publicRoutes.find((route) => route.path === '/plugins/dsh-mobile/meta');
  const hostRoute = fetchRoutes.find((route) => route.path === '/api/dsh-mobile/host-settings');
  return { home, metaRoute, hostRoute, fetchRoutes, publicRoutes };
}

test('meta exposes the four host fields', async () => {
  const { metaRoute } = setup({ version: 1, notify: { askAutoAnswer: true, askTimeoutMs: 300000 } });
  const { status, body } = await callPublic(metaRoute);
  assert.equal(status, 200);
  assert.equal(body.askAutoAnswer, true);
  assert.equal(body.askTimeoutMs, 300000);
  assert.equal(body.approvalAutoAction, 'rejected');
  assert.equal(body.questionAutoPick, 'first');
  // Public route: no secret material.
  assert.equal(JSON.stringify(body).includes('webhook/secret'), false);
});

test('GET returns settings, defaults and the allowed range', async () => {
  const { hostRoute } = setup();
  const { status, body } = await callFetch(hostRoute);
  assert.equal(status, 200);
  assert.deepEqual(body.range, { minMs: 15000, maxMs: 86400000 });
  assert.equal(typeof body.settings.askAutoAnswer, 'boolean');
  assert.equal(body.defaults.approvalAutoAction, 'rejected');
  // Nothing stored yet: the route reports the documented browser defaults and
  // tells the client the host has never seen this block.
  assert.deepEqual(body.settings.browserSettings, {
    browser: true,
    done: true,
    ask: true,
    webhook: { enabled: false, kind: 'feishu', url: '' },
  });
  assert.equal(body.storedBrowserSettings, null);
});

test('POST merges into settings.json and keeps channel secrets', async () => {
  const { hostRoute, home, metaRoute } = setup();
  writeFileSync(
    settingsFile(home),
    JSON.stringify(
      {
        version: 1,
        notify: {
          channels: {
            feishu: { enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret' },
            serverchan: { enabled: true, sendKey: 'SCT-secret' },
          },
          askAutoAnswer: false,
        },
      },
      null,
      2,
    ),
  );

  const { status, body } = await callFetch(hostRoute, {
    method: 'POST',
    body: { askAutoAnswer: true, askTimeoutMs: 300000, approvalAutoAction: 'allowed-once' },
  });
  assert.equal(status, 200);
  assert.equal(body.settings.askAutoAnswer, true);
  assert.equal(body.settings.askTimeoutMs, 300000);
  assert.equal(body.settings.approvalAutoAction, 'allowed-once');

  const document = readSettings(home);
  assert.equal(document.notify.askAutoAnswer, true);
  assert.equal(document.notify.channels.feishu.webhook, 'https://open.feishu.cn/open-apis/bot/v2/hook/secret');
  assert.equal(document.notify.channels.serverchan.sendKey, 'SCT-secret');

  // Effective immediately: the public meta route already reports the new value.
  const meta = await callPublic(metaRoute);
  assert.equal(meta.body.askAutoAnswer, true);
});

test('browser settings merge partially and never drop channels or baseUrl', async () => {
  const { hostRoute, home } = setup({
    version: 1,
    notify: {
      baseUrl: 'https://example.test:3088',
      channels: {
        feishu: { enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret' },
        telegram: { enabled: true, botToken: 'token-123', chatId: '42' },
      },
    },
  });

  const first = await callFetch(hostRoute, { method: 'POST', body: { browserSettings: { done: false } } });
  assert.equal(first.status, 200);
  assert.equal(first.body.settings.browserSettings.done, false);
  assert.equal(first.body.settings.browserSettings.browser, true);
  assert.equal(first.body.settings.browserSettings.ask, true);
  assert.deepEqual(first.body.settings.browserSettings.webhook, { enabled: false, kind: 'feishu', url: '' });

  const second = await callFetch(hostRoute, {
    method: 'POST',
    body: { browserSettings: { webhook: { enabled: true, kind: 'dingtalk', url: ' https://x.test/hook ' } } },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.settings.browserSettings.done, false, 'the first partial patch must survive');
  assert.deepEqual(second.body.settings.browserSettings.webhook, {
    enabled: true,
    kind: 'dingtalk',
    url: 'https://x.test/hook',
  });

  const document = readSettings(home);
  assert.equal(document.notify.baseUrl, 'https://example.test:3088');
  assert.equal(document.notify.channels.feishu.webhook, 'https://open.feishu.cn/open-apis/bot/v2/hook/secret');
  assert.equal(document.notify.channels.telegram.botToken, 'token-123');
  assert.equal(document.notify.browserSettings.done, false);

  const read = await callFetch(hostRoute);
  assert.deepEqual(read.body.storedBrowserSettings, document.notify.browserSettings, 'raw block is what GET reports');
});

test('POST rejects invalid browser settings with the field name', async () => {
  const { hostRoute, home } = setup();
  const before = readSettings(home);
  for (const [body, field] of [
    [{ browserSettings: { browser: 'yes' } }, 'browserSettings.browser'],
    [{ browserSettings: { webhook: { kind: 'slack' } } }, 'browserSettings.webhook.kind'],
    [{ browserSettings: { webhook: { url: 42 } } }, 'browserSettings.webhook.url'],
    [{ browserSettings: { unknown: true } }, 'browserSettings.unknown'],
  ]) {
    const result = await callFetch(hostRoute, { method: 'POST', body });
    assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.match(String(result.body.error), new RegExp(field.replaceAll('.', '\\.')), result.body.error);
  }
  assert.deepEqual(readSettings(home), before, 'a rejected browser patch must not write anything');
});

test('POST rejects bad input without touching the file', async () => {
  const { hostRoute, home } = setup();
  const before = readSettings(home);

  for (const body of [
    { askAutoAnswer: 'yes' },
    { askTimeoutMs: 1000 },
    { askTimeoutMs: 86400001 },
    { approvalAutoAction: 'approve' },
    { questionAutoPick: 'second' },
    { channels: { feishu: { enabled: false } } },
    {},
  ]) {
    const result = await callFetch(hostRoute, { method: 'POST', body });
    assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(typeof result.body.error, 'string');
  }

  const invalidJson = await callFetch(hostRoute, { method: 'POST', body: '{not json' });
  assert.equal(invalidJson.status, 400);

  assert.deepEqual(readSettings(home), before, 'a rejected patch must not write anything');
});

test('a corrupt settings.json answers 409 and is left alone', async () => {
  const { hostRoute, home } = setup();
  const corrupt = '{"version":1,"notify":{"channels":{"feishu":';
  writeFileSync(settingsFile(home), corrupt);

  const result = await callFetch(hostRoute, { method: 'POST', body: { askAutoAnswer: true } });
  assert.equal(result.status, 409);
  assert.match(String(result.body.error), /could not be read/);
  assert.equal(readFileSync(settingsFile(home), 'utf8'), corrupt);

  // The read path still answers (it reports what the host has loaded).
  const read = await callFetch(hostRoute);
  assert.equal(read.status, 200);
});

test('each of the four fields can be set on its own', async () => {
  const { hostRoute, home } = setup();
  for (const body of [
    { askAutoAnswer: true },
    { askTimeoutMs: 90000 },
    { approvalAutoAction: 'allowed-once' },
    { questionAutoPick: 'none' },
  ]) {
    const result = await callFetch(hostRoute, { method: 'POST', body });
    assert.equal(result.status, 200, JSON.stringify(body));
  }
  const document = readSettings(home);
  assert.equal(document.notify.askAutoAnswer, true);
  assert.equal(document.notify.askTimeoutMs, 90000);
  assert.equal(document.notify.approvalAutoAction, 'allowed-once');
  assert.equal(document.notify.questionAutoPick, 'none');
});

test('the settings route never writes the webhook URL to notify.log', async () => {
  const { hostRoute, home } = setup();
  const secret = 'https://open.feishu.cn/open-apis/bot/v2/hook/SECRET-TOKEN-9876';

  const result = await callFetch(hostRoute, {
    method: 'POST',
    body: { browserSettings: { webhook: { enabled: true, kind: 'feishu', url: secret } } },
  });
  assert.equal(result.status, 200);

  const log = readFileSync(path.join(home, 'dsh-mobile', 'notify.log'), 'utf8');
  assert.equal(log.includes('SECRET-TOKEN-9876'), false, 'the webhook token is a credential and must be masked');
  assert.match(log, /host auto-answer updated/);
  assert.match(log, /webhook/);

  // Masking the log must not touch what is stored.
  assert.equal(readSettings(home).notify.browserSettings.webhook.url, secret);
});
