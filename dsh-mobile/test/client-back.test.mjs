/**
 * Browser half: the global mobile back button's decision table.
 *
 *   node --test test/client-back.test.mjs
 *
 * The DOM integration (button existence, click wiring, Escape fallback) lives in
 * client-harness.mjs; this file pins the two pure decisions that must never
 * drift: when the button is shown, and which single layer it closes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition;
    },
  },
};

await import('../client.back.js');
const api = captured.factory();
const { shouldShow, nextAction } = api;

const state = (overrides = {}) => ({
  mobile: true,
  dialog: false,
  menu: false,
  panel: false,
  drawer: false,
  rightbar: false,
  conversation: true,
  ...overrides,
});

test('the back button hides only on the plain mobile conversation', () => {
  assert.equal(shouldShow(state()), false, 'conversation');
  assert.equal(shouldShow(state({ mobile: false, panel: true })), false, 'desktop never shows it');
  assert.equal(shouldShow(state({ panel: true, conversation: false })), true, 'plugin panel');
  assert.equal(shouldShow(state({ dialog: true })), true, 'settings dialog over the conversation');
  assert.equal(shouldShow(state({ drawer: true })), true, 'drawer');
  assert.equal(shouldShow(state({ rightbar: true })), true, 'right panel');
  assert.equal(shouldShow(state({ conversation: false })), true, 'unknown full-screen page fails open');
  assert.equal(shouldShow(state({ menu: true })), false, 'a transient menu alone does not summon it');
});

test('one tap closes exactly one layer', () => {
  assert.equal(nextAction(state({ dialog: true, panel: true, drawer: true, rightbar: true })), 'dialog');
  assert.equal(nextAction(state({ menu: true, panel: true, drawer: true })), 'dialog');
  assert.equal(nextAction(state({ panel: true, drawer: true, rightbar: true })), 'drawer');
  assert.equal(nextAction(state({ panel: true, rightbar: true })), 'rightbar');
  assert.equal(nextAction(state({ panel: true })), 'panel');
  assert.equal(nextAction(state({ conversation: false })), 'reset');
});

test('the chunk registers under the plugin id', () => {
  assert.equal(captured.id, 'dsh-mobile');
  assert.equal(captured.chunk, 'client.back.js');
});
