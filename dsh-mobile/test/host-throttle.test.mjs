/**
 * Host dispatcher throttle shape.
 *
 *   node --test test/host-throttle.test.mjs
 *
 * `minSessionIntervalMs` is a guard against two quick turns of the same session
 * flooding a chat channel. It used to key on the session alone, so the most
 * important message could be the one that was dropped: the "already handled for
 * you" notice right before a completion, and the "waiting for you" notice right
 * after one. The window is per session *and kind* now.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDispatcher } from '../lib/notify/dispatcher.js';
import { defaultNotifyConfig } from '../lib/notify/config.js';

/** A Cordis-shaped event bus: `on`/`emit`/`waterfall`, prepend included. */
function makeCtx() {
  const hooks = new Map();
  const ctx = {
    on(name, listener, options) {
      const prepend = options === true || options?.prepend === true;
      const list = hooks.get(name) ?? [];
      const record = { listener };
      if (prepend) list.unshift(record);
      else list.push(record);
      hooks.set(name, list);
      return () => {
        const index = list.indexOf(record);
        if (index >= 0) list.splice(index, 1);
        return true;
      };
    },
    emit(name, ...args) {
      for (const record of [...(hooks.get(name) ?? [])]) record.listener(...args);
    },
    waterfall(name, ...args) {
      const list = [...(hooks.get(name) ?? [])];
      const inner = args.pop();
      const next = () => (list.shift()?.listener ?? inner)(...args);
      args.push(next);
      return next();
    },
    get(name) {
      if (name === 'sessionTitle') return { get: () => ({ title: 'T' }) };
      return undefined;
    },
  };
  return ctx;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const event = (ctx, session, type, data) => ctx.emit('session/event', session, { type, data });

function harness(t, overrides = {}) {
  const ctx = makeCtx();
  const feed = [];
  const lines = [];
  const config = { ...defaultNotifyConfig(), debounceMs: 10, minSessionIntervalMs: 10000, ...overrides };
  const dispatcher = createDispatcher({
    ctx,
    logger: { info() {}, warn() {}, error() {} },
    getConfig: () => config,
    feed: { push(entry) { feed.push(entry); } },
    log: (line) => lines.push(line),
  });
  const dispose = dispatcher.attach();
  t.after(() => dispose());
  return { ctx, feed, lines, config, agentFor: (id) => ({ session: { header: { id, cwd: '/tmp/dsh-throttle' } }, status: 'idle' }) };
}

function completeTurn(ctx, session, agent, turn) {
  event(ctx, session, 'turn/start', { turn });
  event(ctx, session, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'carry on' }] });
  event(ctx, session, 'assistant/message', {
    turn,
    message: { content: [{ type: 'text', text: 'done' }], source: { model: 'm' } },
    usage: { totalTokens: 10 },
  });
  event(ctx, session, 'turn/end', { turn, reason: { kind: 'completed' } });
  ctx.emit('agent/status', { agent, status: 'idle' });
}

test('an auto-answered approval must not throttle the completion that follows it', async (t) => {
  const h = harness(t, { askAutoAnswer: true, askTimeoutMs: 30, approvalAutoAction: 'allowed-once' });
  // The web half with no browser attached: the auto answer is the only answer.
  h.ctx.on('approval/request', () => new Promise(() => {}));

  const agent = h.agentFor('s-auto-done');
  agent.status = 'running';
  const outcome = await h.ctx.waterfall(
    'approval/request',
    { agent, toolName: 'shell' },
    () => Promise.resolve('unavailable'),
  );
  assert.equal(outcome, 'allowed-once');
  await sleep(20);
  // At this point the feed has the ask and the auto notices; both started the
  // old per-session window.
  assert.deepEqual(h.feed.map((entry) => entry.kind), ['ask', 'auto']);

  completeTurn(h.ctx, agent.session, { ...agent, status: 'idle' }, 2);
  await sleep(80);

  assert.deepEqual(
    h.feed.map((entry) => entry.kind),
    ['ask', 'auto', 'done'],
    'the completion must survive the auto notice',
  );
  assert.doesNotMatch(h.lines.join('\n'), /skip\(throttle\) done/);
});

test('a completion must not throttle the "waiting for you" notice after it', async (t) => {
  const h = harness(t, { askAutoAnswer: false });
  const agent = h.agentFor('s-done-ask');
  completeTurn(h.ctx, agent.session, agent, 1);
  await sleep(80);
  assert.deepEqual(h.feed.map((entry) => entry.kind), ['done']);

  // A hung forwarder keeps the approval open; only the ask notice is under test.
  h.ctx.on('approval/request', () => new Promise(() => {}));
  const pending = h.ctx.waterfall(
    'approval/request',
    { agent: { ...agent, status: 'running' }, toolName: 'shell', reason: 'write outside the workspace' },
    () => Promise.resolve('unavailable'),
  );
  await sleep(30);

  assert.deepEqual(
    h.feed.map((entry) => entry.kind),
    ['done', 'ask'],
    'the waiting notice must not be swallowed by the completion window',
  );
  assert.doesNotMatch(h.lines.join('\n'), /skip\(throttle\) ask/);
  // The waterfall is intentionally unresolved (no browser, no auto answer).
  pending.catch(() => {});
});
