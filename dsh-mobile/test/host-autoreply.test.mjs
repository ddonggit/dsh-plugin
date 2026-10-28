/**
 * Host half: the auto-answer race, with the browser forwarder in the chain.
 *
 *   node --test test/host-autoreply.test.mjs
 *
 * The bug this pins down: `dsh-api-remotes` registers its own plain listener on
 * `approval/request` / `user-questions/request` and only resolves it when an
 * open browser answers. A listener registered *after* it sits inside that wait,
 * so with every browser closed `next()` is never called and the timeout never
 * starts. `attach()` therefore prepends both listeners; the cases below build
 * the real waterfall shape (forwarder first, silent forever) and assert the
 * dispatcher still settles the step.
 *
 * A fake ctx implements cordis' waterfall composition order, so registration
 * order — including `prepend` — is what is under test, not a mock of it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDispatcher } from '../lib/notify/dispatcher.js';
import { defaultNotifyConfig } from '../lib/notify/config.js';

/** Deferred promise whose settlement the test controls. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Minimal cordis event bus: `on(name, listener, {prepend})` and a waterfall
 * that runs the outermost listener first (see `EventsService.waterfall`).
 */
function makeCtx() {
  const hooks = new Map();
  const registrations = [];
  const ctx = {
    on(name, listener, options) {
      const prepend = options === true || options?.prepend === true;
      const list = hooks.get(name) ?? [];
      const record = { listener };
      registrations.push({ name, prepend, listener });
      if (prepend) list.unshift(record);
      else list.push(record);
      hooks.set(name, list);
      return () => {
        const index = list.indexOf(record);
        if (index >= 0) list.splice(index, 1);
        return true;
      };
    },
    waterfall(name, ...args) {
      const list = [...(hooks.get(name) ?? [])];
      const inner = args.pop();
      const next = () => (list.shift()?.listener ?? inner)(...args);
      args.push(next);
      return next();
    },
    get() {
      return undefined;
    },
  };
  return { ctx, hooks, registrations };
}

/** A request-shaped object: the dispatcher reads `agent` and the payload. */
function agentFor(sessionId) {
  return { session: { header: { id: sessionId, cwd: '/tmp/dsh-autoreply' } } };
}

/**
 * Wire a dispatcher onto a fake ctx.
 *
 * `keepAlive` holds a ref'd timer: `withAutoAnswer` unrefs its own timer, and an
 * unref'd timer plus an awaited promise would not keep the process awake.
 */
function harness(t, overrides = {}) {
  const { ctx, hooks, registrations } = makeCtx();
  const lines = [];
  const config = { ...defaultNotifyConfig(), ...overrides };
  const dispatcher = createDispatcher({
    ctx,
    logger: { info() {}, warn() {}, error() {} },
    getConfig: () => config,
    feed: { push() {} },
    log: (line) => lines.push(line),
  });
  const keepAlive = setInterval(() => {}, 1000);
  let dispose = null;
  t.after(() => {
    clearInterval(keepAlive);
    dispose?.();
  });
  return {
    ctx,
    hooks,
    registrations,
    lines,
    config,
    dispatcher,
    attach() {
      dispose = dispatcher.attach();
    },
    logs: () => lines.join('\n'),
  };
}

/** Reject instead of hanging when a waterfall never settles. */
function within(ms, promise, message) {
  let timer;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * The browser forwarder, registered the way `dsh-api-remotes` does it: plain
 * `ctx.on`, resolving only when a browser answers. `hang` is never settled in
 * the closed-browser cases.
 */
function registerBrowserForwarder(ctx, name, hang) {
  ctx.on(name, (request, next) => {
    if (typeof next !== 'function') throw new TypeError('waterfall next missing');
    return hang.promise;
  });
}

test('approval: prepended listener answers after askTimeoutMs while the forwarder never resolves', async (t) => {
  const h = harness(t, { askAutoAnswer: true, askTimeoutMs: 60, approvalAutoAction: 'allowed-once' });
  registerBrowserForwarder(h.ctx, 'approval/request', deferred());
  h.attach();

  const started = Date.now();
  const outcome = await within(
    2000,
    h.ctx.waterfall(
      'approval/request',
      { agent: agentFor('s-approval'), toolName: 'shell', reason: 'write outside the workspace' },
      () => Promise.resolve('unavailable'),
    ),
    'the approval waterfall never settled: the auto-answer timer did not start',
  );
  const elapsed = Date.now() - started;

  assert.equal(outcome, 'allowed-once', 'the timeout must produce the configured decision');
  assert.ok(elapsed >= 50, `answered too early to be the timeout: ${elapsed}ms`);
  assert.match(h.logs(), /auto approval allowed-once "allowed-once"/);
});

test('approval: rejected action is honoured', async (t) => {
  const h = harness(t, { askAutoAnswer: true, askTimeoutMs: 40, approvalAutoAction: 'rejected' });
  registerBrowserForwarder(h.ctx, 'approval/request', deferred());
  h.attach();

  const outcome = await h.ctx.waterfall(
    'approval/request',
    { agent: agentFor('s-reject'), toolName: 'shell' },
    () => Promise.resolve('unavailable'),
  );

  assert.equal(outcome, 'rejected');
  assert.match(h.logs(), /auto approval rejected "rejected"/);
});

test('question: intent.approve wins over the first option', async (t) => {
  const h = harness(t, { askAutoAnswer: true, askTimeoutMs: 50, questionAutoPick: 'first' });
  registerBrowserForwarder(h.ctx, 'user-questions/request', deferred());
  h.attach();

  const request = {
    agent: agentFor('s-plan'),
    questions: [
      {
        id: 'plan',
        header: 'Review the plan',
        question: 'Apply this plan?',
        options: [{ label: 'Revise' }, { label: 'Approve plan' }],
        intent: { kind: 'plan-review', approve: 'Approve plan' },
      },
    ],
  };
  const answer = await within(
    2000,
    h.ctx.waterfall('user-questions/request', request, () => Promise.reject(new Error('no provider'))),
    'the question waterfall never settled: the auto-answer timer did not start',
  );

  assert.deepEqual(answer, { answers: [{ id: 'plan', selected: ['Approve plan'] }] });
  assert.match(h.logs(), /auto question \{.*"Approve plan"/);
});

test('question: without a plan-review intent the first option is picked', async (t) => {
  const h = harness(t, { askAutoAnswer: true, askTimeoutMs: 50 });
  registerBrowserForwarder(h.ctx, 'user-questions/request', deferred());
  h.attach();

  const request = {
    agent: agentFor('s-pick'),
    questions: [
      { id: 'q1', header: 'Pick', question: 'Which one?', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
      { id: 'q2', header: 'Pick again', question: 'And this?', options: [{ label: 'Gamma' }] },
    ],
  };
  const answer = await h.ctx.waterfall('user-questions/request', request, () =>
    Promise.reject(new Error('no provider')),
  );

  assert.deepEqual(answer, {
    answers: [
      { id: 'q1', selected: ['Alpha'] },
      { id: 'q2', selected: ['Gamma'] },
    ],
  });
});

test('a human answer before the timeout voids the timer: no second answer, no auto log', async (t) => {
  const h = harness(t, { askAutoAnswer: true, askTimeoutMs: 120, approvalAutoAction: 'allowed-once' });
  const human = deferred();
  // The forwarder resolves the way the browser UI does when the human taps.
  h.ctx.on('approval/request', () => human.promise);
  h.attach();

  human.resolve('rejected');
  const answered = await h.ctx.waterfall(
    'approval/request',
    { agent: agentFor('s-human'), toolName: 'shell' },
    () => Promise.resolve('unavailable'),
  );
  assert.equal(answered, 'rejected', 'the human answer must win');

  // Wait past the timeout: a leaked timer would log and resolve a second value.
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.doesNotMatch(h.logs(), /auto approval/, 'the timer must be cancelled by the human answer');
});

test('askAutoAnswer=false: a hung forwarder stays hung, the plugin does not answer', async (t) => {
  const h = harness(t, { askAutoAnswer: false, askTimeoutMs: 30 });
  const hang = deferred();
  registerBrowserForwarder(h.ctx, 'approval/request', hang);
  h.attach();

  let settled = null;
  const pending = h.ctx
    .waterfall('approval/request', { agent: agentFor('s-off'), toolName: 'shell' }, () => Promise.resolve('unavailable'))
    .then((value) => {
      settled = value;
      return value;
    });

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(settled, null, 'the plugin must not answer while the switch is off');
  assert.doesNotMatch(h.logs(), /auto approval/);

  // Release the downstream: the answer is whatever the chain produced, untouched.
  hang.resolve('unavailable');
  assert.equal(await pending, 'unavailable');
});

test('attach() prepends both listeners ahead of an already-registered forwarder', (t) => {
  const h = harness(t);
  registerBrowserForwarder(h.ctx, 'approval/request', deferred());
  registerBrowserForwarder(h.ctx, 'user-questions/request', deferred());
  h.attach();

  // Cordis unshifts prepended hooks, so ours is list[0] and the forwarder is
  // list[1] — the order that puts the timer outside the browser wait.
  for (const name of ['approval/request', 'user-questions/request']) {
    const ours = h.registrations.find((item) => item.name === name && item.prepend);
    assert.ok(ours, `${name} must be registered with prepend`);
    const list = h.hooks.get(name);
    assert.equal(list.length, 2, `${name} should have the forwarder plus ours`);
    assert.equal(list[0].listener, ours.listener, `${name}: ours must run outermost`);
  }
});

test("approvalAutoAction='none' never decides: the request stays with the browser", async (t) => {
  const h = harness(t, { askAutoAnswer: true, askTimeoutMs: 30, approvalAutoAction: 'none' });
  const hang = deferred();
  registerBrowserForwarder(h.ctx, 'approval/request', hang);
  h.attach();

  let settled = null;
  const pending = h.ctx
    .waterfall(
      'approval/request',
      { agent: agentFor('s-none-approval'), toolName: 'shell' },
      () => Promise.resolve('unavailable'),
    )
    .then((value) => {
      settled = value;
      return value;
    });

  // Past the timeout: nothing may be decided on the user's behalf.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(settled, null, "'none' must not produce an answer");
  assert.doesNotMatch(h.logs(), /auto approval/, "'none' must not log an automatic decision");

  // The browser remains the only answerer; a rejected click still works.
  hang.resolve('rejected');
  assert.equal(await pending, 'rejected');
});

test("questionAutoPick='none' (不回答) never answers the timed-out question", async (t) => {
  const h = harness(t, { askAutoAnswer: true, askTimeoutMs: 30, questionAutoPick: 'none' });
  const hang = deferred();
  registerBrowserForwarder(h.ctx, 'user-questions/request', hang);
  h.attach();

  let settled = null;
  const pending = h.ctx
    .waterfall(
      'user-questions/request',
      {
        agent: agentFor('s-none-question'),
        questions: [{ id: 'q1', header: 'Pick', question: 'Which?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
      },
      () => Promise.reject(new Error('no provider')),
    )
    .then((value) => {
      settled = value;
      return value;
    });

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(settled, null, "'none' must not pick the first option");
  assert.doesNotMatch(h.logs(), /auto question/);

  const answer = { answers: [{ id: 'q1', selected: ['Beta'], custom: 'typed by the human' }] };
  hang.resolve(answer);
  assert.deepEqual(await pending, answer);
});
