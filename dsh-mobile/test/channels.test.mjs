/**
 * Channel adapters: the payload each dialect actually puts on the wire.
 *
 *   node --test test/channels.test.mjs
 *
 * The ntfy regression this pins down: the old adapter sent the title as an HTTP
 * header, and every title starts with an emoji. `fetch` validates header values
 * as ByteString, so the request threw before it was sent and the channel could
 * never deliver anything. The replacement publishes JSON at the server root.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { deliver } from '../lib/notify/channels.js';
import { createNotice } from '../lib/notify/compose.js';

/** Swap the global fetch for one recording stub; restore it after the test. */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const sampleNotice = () =>
  createNotice({
    variant: 'done',
    sessionId: 'session-1',
    sessionTitle: '修复登录超时',
    task: '修一下登录过期后自动重登',
    result: '已修复 token 刷新逻辑，`npm test` 全绿。',
    facts: { workspace: 'workspace', durationMs: 133000, turn: 3, tools: 12, tokens: 8923, model: 'deepseek-v4-flash' },
  });

test('ntfy publishes JSON to the server root instead of a Unicode header', async (t) => {
  const notice = sampleNotice();
  const fake = stubFetch(() => jsonResponse({ id: 'msg-1', event: 'message', topic: 'demo' }));
  t.after(() => fake.restore());

  const result = await deliver(
    'ntfy',
    { enabled: true, server: 'https://ntfy.example', topic: 'demo-topic', token: 'tk_secret' },
    notice,
  );
  assert.deepEqual(result, { ok: true, detail: 'ok' });
  assert.equal(fake.calls.length, 1);

  const [{ url, init }] = fake.calls;
  assert.equal(url, 'https://ntfy.example/');
  assert.equal(init.method, 'POST');

  // Building Headers from the outgoing set is the check that failed before:
  // a non-Latin-1 value throws a TypeError here.
  const headers = new Headers(init.headers);
  assert.equal(headers.get('title'), null, 'the title must not be an HTTP header');
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(headers.get('authorization'), 'Bearer tk_secret');

  const body = JSON.parse(init.body);
  assert.equal(body.topic, 'demo-topic');
  assert.equal(body.title, notice.payloads.ntfy.title);
  assert.match(body.title, /✅/);
  assert.equal(body.message, notice.payloads.ntfy.body);
  assert.deepEqual(body.tags, [notice.payloads.ntfy.tags]);
  assert.equal(body.priority, notice.payloads.ntfy.priority);
});

test('ntfy keeps the click link and omits authorization without a token', async (t) => {
  const notice = createNotice({
    variant: 'ask',
    sessionId: 'session-2',
    sessionTitle: '等待确认',
    waitText: '工具 bash 需要授权',
    link: 'https://dsh.example/#session=session-2',
  });
  const fake = stubFetch(() => jsonResponse({ id: 'msg-2' }));
  t.after(() => fake.restore());

  const result = await deliver('ntfy', { enabled: true, server: 'https://ntfy.example/', topic: 'demo', token: '' }, notice);
  assert.equal(result.ok, true);
  const [{ url, init }] = fake.calls;
  assert.equal(url, 'https://ntfy.example/');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), null);
  const body = JSON.parse(init.body);
  assert.equal(body.click, 'https://dsh.example/#session=session-2');
  assert.equal(body.topic, 'demo');
});

test('ntfy reports a provider error as a failed delivery', async (t) => {
  const fake = stubFetch(() => jsonResponse({ error: 'invalid topic' }, 400));
  t.after(() => fake.restore());
  const result = await deliver(
    'ntfy',
    { enabled: true, server: 'https://ntfy.example', topic: 'bad topic', token: '' },
    sampleNotice(),
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /^HTTP 400/);
});
