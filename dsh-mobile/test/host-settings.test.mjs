/**
 * Host-side auto-answer: validation and the read-merge-write contract.
 *
 *   node --test test/host-settings.test.mjs
 *
 * The merge is the risky part: settings.json also holds channel webhooks and
 * tokens entered in the UI, so a patch from the browser must never be able to
 * drop them.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HOST_TIMEOUT_MAX_MS,
  HOST_TIMEOUT_MIN_MS,
  applyHostPatch,
  browserSettingDefaults,
  hostSettingDefaults,
  pickBrowserSettings,
  pickHostSettings,
  redactPatch,
  validateBrowserSettingsPatch,
  validateHostPatch,
} from '../lib/notify/host-settings.js';
import { loadSettings } from '../lib/notify/store.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'dsh-mobile-host-'));
const read = (base) => JSON.parse(readFileSync(path.join(base, 'settings.json'), 'utf8'));

test('patch validation accepts the four fields and rejects everything else', () => {
  assert.deepEqual(validateHostPatch({ askAutoAnswer: true }), { ok: true, patch: { askAutoAnswer: true } });
  assert.deepEqual(validateHostPatch({ askTimeoutMs: 60000 }), { ok: true, patch: { askTimeoutMs: 60000 } });
  assert.deepEqual(validateHostPatch({ approvalAutoAction: 'allowed-once' }), {
    ok: true,
    patch: { approvalAutoAction: 'allowed-once' },
  });
  assert.deepEqual(validateHostPatch({ questionAutoPick: 'none' }), { ok: true, patch: { questionAutoPick: 'none' } });

  assert.equal(validateHostPatch({ webhook: 'x' }).ok, false, 'unknown field must be rejected');
  assert.equal(validateHostPatch({ askAutoAnswer: 'yes' }).ok, false, 'boolean only');
  assert.equal(validateHostPatch({ askTimeoutMs: HOST_TIMEOUT_MIN_MS - 1 }).ok, false, 'below the 15s floor');
  assert.equal(validateHostPatch({ askTimeoutMs: HOST_TIMEOUT_MAX_MS + 1 }).ok, false, 'above the 24h ceiling');
  assert.equal(validateHostPatch({ askTimeoutMs: 1500.5 }).ok, false, 'integers only');
  assert.equal(validateHostPatch({ approvalAutoAction: 'approve' }).ok, false, 'enum only');
  assert.equal(validateHostPatch({ questionAutoPick: 'second' }).ok, false, 'enum only');
  assert.equal(validateHostPatch({}).ok, false, 'empty patch is a mistake, not a no-op');
  assert.equal(validateHostPatch([]).ok, false, 'arrays are not patches');
});

test('merge keeps channels, secrets and unrelated keys', () => {
  const base = dir();
  writeFileSync(
    path.join(base, 'settings.json'),
    JSON.stringify(
      {
        version: 1,
        notify: {
          baseUrl: 'https://example.test:3088',
          channels: {
            feishu: { enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret' },
            telegram: { enabled: true, botToken: 'token-123', chatId: '42' },
          },
          askAutoAnswer: false,
          askTimeoutMs: 120000,
          approvalAutoAction: 'rejected',
          questionAutoPick: 'first',
        },
      },
      null,
      2,
    ),
  );

  applyHostPatch(base, { askAutoAnswer: true, askTimeoutMs: 300000 }, null);
  const document = read(base);

  assert.equal(document.version, 1);
  assert.equal(document.notify.askAutoAnswer, true);
  assert.equal(document.notify.askTimeoutMs, 300000);
  // untouched
  assert.equal(document.notify.approvalAutoAction, 'rejected');
  assert.equal(document.notify.questionAutoPick, 'first');
  assert.equal(document.notify.baseUrl, 'https://example.test:3088');
  assert.equal(document.notify.channels.feishu.webhook, 'https://open.feishu.cn/open-apis/bot/v2/hook/secret');
  assert.equal(document.notify.channels.telegram.botToken, 'token-123');

  // What the plugin will actually load agrees with the file.
  const loaded = loadSettings(base, null);
  assert.equal(loaded.askAutoAnswer, true);
  assert.equal(loaded.askTimeoutMs, 300000);
  assert.equal(loaded.channels.feishu.enabled, true);

  // 0600, no temp file left behind.
  assert.equal(statSync(path.join(base, 'settings.json')).mode & 0o777, 0o600);
});

test('a legacy bare document keeps its shape', () => {
  const base = dir();
  writeFileSync(
    path.join(base, 'settings.json'),
    JSON.stringify({ baseUrl: 'https://example.test', channels: { webhook: { enabled: true, url: 'https://x.test/y' } } }, null, 2),
  );

  applyHostPatch(base, { questionAutoPick: 'none' }, null);
  const document = read(base);

  assert.equal(document.notify, undefined, 'bare shape must not grow a notify block');
  assert.equal(document.baseUrl, 'https://example.test');
  assert.equal(document.questionAutoPick, 'none');
  assert.equal(document.channels.webhook.url, 'https://x.test/y');
  assert.equal(loadSettings(base, null).questionAutoPick, 'none');
});

test('a version-only document grows a notify block instead of drifting', () => {
  const base = dir();
  writeFileSync(path.join(base, 'settings.json'), JSON.stringify({ version: 1 }));
  applyHostPatch(base, { askAutoAnswer: true }, null);
  const document = read(base);
  assert.equal(document.version, 1);
  assert.equal(document.notify.askAutoAnswer, true);
  assert.equal(document.askAutoAnswer, undefined);
});

test('a missing settings.json is created in the documented shape', () => {
  const base = dir();
  applyHostPatch(base, { askAutoAnswer: true }, null);
  const document = read(base);
  assert.equal(document.version, 1);
  assert.equal(document.notify.askAutoAnswer, true);
});

test('a corrupt settings.json is refused, not overwritten', () => {
  const base = dir();
  const corrupt = '{"version":1,"notify":{"channels":{"feishu":{"webhook": "https://broken';
  writeFileSync(path.join(base, 'settings.json'), corrupt);

  assert.throws(
    () => applyHostPatch(base, { askAutoAnswer: true }, null),
    (error) => error.code === 'settings-unreadable',
    'a document that cannot be parsed must not be replaced',
  );
  assert.equal(readFileSync(path.join(base, 'settings.json'), 'utf8'), corrupt, 'file must be untouched');

  writeFileSync(path.join(base, 'settings.json'), '[]');
  assert.throws(() => applyHostPatch(base, { askAutoAnswer: true }, null), (error) => error.code === 'settings-unreadable');
});

test('an empty settings.json is an empty document, not a corrupt one', () => {
  const base = dir();
  writeFileSync(path.join(base, 'settings.json'), '\n');
  applyHostPatch(base, { askAutoAnswer: true }, null);
  assert.equal(read(base).notify.askAutoAnswer, true);
});

test('pickHostSettings normalizes whatever it is given', () => {
  assert.deepEqual(pickHostSettings(undefined), hostSettingDefaults());
  assert.deepEqual(pickHostSettings({ askAutoAnswer: 'yes', askTimeoutMs: '300000', approvalAutoAction: 'approve' }), {
    askAutoAnswer: false,
    askTimeoutMs: hostSettingDefaults().askTimeoutMs,
    approvalAutoAction: 'rejected',
    questionAutoPick: 'first',
  });
  assert.equal(pickHostSettings({ askTimeoutMs: 60000 }).askTimeoutMs, 60000);
});


test('browser settings default to the documented object', () => {
  assert.deepEqual(browserSettingDefaults(), {
    browser: true,
    done: true,
    ask: true,
    webhook: { enabled: false, kind: 'feishu', url: '' },
  });
  assert.deepEqual(pickBrowserSettings(undefined), browserSettingDefaults());
  assert.deepEqual(pickBrowserSettings({ webhook: { enabled: true, kind: 'dingtalk', url: ' https://x.test ' } }), {
    browser: true,
    done: true,
    ask: true,
    webhook: { enabled: true, kind: 'dingtalk', url: 'https://x.test' },
  });
});

test('browser settings merge partially and never drop other settings', () => {
  const base = dir();
  writeFileSync(
    path.join(base, 'settings.json'),
    JSON.stringify(
      {
        version: 1,
        notify: {
          baseUrl: 'https://example.test:3088',
          channels: {
            feishu: { enabled: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret' },
          },
          browserSettings: { browser: false, done: true, ask: true, webhook: { enabled: true, kind: 'dingtalk', url: 'https://x.test' } },
        },
      },
      null,
      2,
    ),
  );

  applyHostPatch(base, { browserSettings: { done: false } }, null);
  let document = read(base);
  assert.deepEqual(document.notify.browserSettings, {
    browser: false,
    done: false,
    ask: true,
    webhook: { enabled: true, kind: 'dingtalk', url: 'https://x.test' },
  });
  assert.equal(document.notify.baseUrl, 'https://example.test:3088');
  assert.equal(document.notify.channels.feishu.webhook, 'https://open.feishu.cn/open-apis/bot/v2/hook/secret');

  const validated = validateHostPatch({ browserSettings: { webhook: { url: '  https://y.test/hook  ' } } });
  applyHostPatch(base, validated.patch, null);
  document = read(base);
  assert.deepEqual(document.notify.browserSettings, {
    browser: false,
    done: false,
    ask: true,
    webhook: { enabled: true, kind: 'dingtalk', url: 'https://y.test/hook' },
  });
});

test('browser settings validation names the offending field', () => {
  const cases = [
    [{ browser: 'yes' }, 'browserSettings.browser'],
    [{ webhook: { kind: 'slack' } }, 'browserSettings.webhook.kind'],
    [{ webhook: { url: 42 } }, 'browserSettings.webhook.url'],
    [{ bogus: true }, 'browserSettings.bogus'],
  ];
  for (const [input, field] of cases) {
    const result = validateHostPatch({ browserSettings: input });
    assert.equal(result.ok, false, `${JSON.stringify(input)} must be rejected`);
    assert.match(result.error, new RegExp(field.replaceAll('.', '\\.')));
  }
  assert.deepEqual(validateBrowserSettingsPatch({ webhook: { url: ' https://x.test ' } }), {
    ok: true,
    patch: { webhook: { url: 'https://x.test' } },
  });
  assert.equal(validateHostPatch({ browserSettings: {} }).ok, false, 'an empty browser block is a mistake');
});


test('redactPatch masks the webhook URL and leaves everything else intact', () => {
  const patch = {
    askAutoAnswer: true,
    browserSettings: {
      done: false,
      webhook: { enabled: true, kind: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/very-secret-token' },
    },
  };
  const safe = redactPatch(patch);
  assert.deepEqual(safe, {
    askAutoAnswer: true,
    browserSettings: {
      done: false,
      webhook: { enabled: true, kind: 'feishu', url: '****oken' },
    },
  });
  // The original patch (and the settings file write) keep the real URL.
  assert.match(patch.browserSettings.webhook.url, /very-secret-token/);
  assert.equal(redactPatch({ askAutoAnswer: true }).browserSettings, undefined);
  assert.deepEqual(redactPatch({ browserSettings: { webhook: { url: '' } } }).browserSettings.webhook.url, '');
});
