import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeThresholds,
  percent,
  shouldCompact,
  statusText,
  waitIdle,
} from '../lib/scheduler.js'

const W = 1_048_576
const O = 384_000
const B = 65_536

function thresholds(mode = 'boundary', extra = {}) {
  return computeThresholds({
    contextWindow: W,
    outputReserve: O,
    headroomTokens: B,
    nativeThresholdRatio: 0.8,
    mode,
    triggerAtNativeRatio: 1,
    atWindowRatio: 0.7,
    ...extra,
  })
}

test('native threshold is capacity-bound at 599040 (57.13%)', () => {
  const result = thresholds()
  assert.equal(result.ok, true)
  assert.equal(result.native, 599040)
  assert.equal(result.trigger, 599040)
  assert.equal(result.binding, 'capacity')
  assert.equal(result.nativePercent, 57.13)
  assert.equal(result.triggerPercent, 57.13)
})

test('boundary and native never trigger before native', () => {
  for (const mode of ['boundary', 'early', 'window']) {
    const result = thresholds(mode)
    assert.equal(result.ok, true)
    assert.ok(result.trigger <= result.native, `${mode} trigger > native`)
    if (mode === 'boundary') assert.equal(result.trigger, result.native)
  }
})

test('early 0.9 triggers at 539136 (51.42%)', () => {
  const result = thresholds('early', { triggerAtNativeRatio: 0.9 })
  assert.equal(result.trigger, 539136)
  assert.equal(result.triggerPercent, 51.42)
})

test('window 0.5 triggers at 524288 (50%)', () => {
  const result = thresholds('window', { atWindowRatio: 0.5 })
  assert.equal(result.trigger, 524288)
  assert.equal(result.triggerPercent, 50)
  assert.equal(result.capped, false)
})

test('window 0.7 is capped by the native threshold', () => {
  const result = thresholds('window', { atWindowRatio: 0.7 })
  assert.equal(result.trigger, 599040)
  assert.equal(result.capped, true)
  assert.equal(result.triggerPercent, 57.13)
})

test('unknown output reserve falls back to the 80% nominal cap', () => {
  const result = computeThresholds({
    contextWindow: W,
    outputReserve: 0,
    headroomTokens: 0,
    nativeThresholdRatio: 0.8,
    mode: 'boundary',
  })
  assert.equal(result.native, 838860)
  assert.equal(result.nativePercent, 80)
})

test('W-O-B <= 0 is rejected as permanent', () => {
  const result = computeThresholds({
    contextWindow: 1000,
    outputReserve: 900,
    headroomTokens: 200,
    nativeThresholdRatio: 0.8,
    mode: 'boundary',
  })
  assert.equal(result.ok, false)
  assert.equal(result.permanent, true)
})

test('native mode is not schedulable', () => {
  const result = thresholds('native')
  assert.equal(result.ok, false)
  assert.equal(result.permanent, false)
})

test('triggerAtNativeRatio above 1 clamps to native in the pure function', () => {
  const result = thresholds('early', { triggerAtNativeRatio: 1.2 })
  assert.equal(result.trigger, result.native)
})

test('shouldCompact enforces pressure, cooldown, and growth gates', () => {
  const base = { ok: true, trigger: 1000, native: 1000 }
  assert.equal(shouldCompact({ thresholds: base, pressure: 999 }).ok, false)
  assert.equal(shouldCompact({ thresholds: base, pressure: 1000 }).ok, true)
  assert.equal(shouldCompact({ thresholds: base, pressure: 999, requested: { turn: 1 } }).ok, true)
  assert.equal(
    shouldCompact({
      thresholds: base,
      pressure: 1000,
      turn: 2,
      lastCompaction: { turn: 1 },
      minTurnsSinceLast: 2,
    }).ok,
    false,
  )
  assert.equal(
    shouldCompact({
      thresholds: base,
      pressure: 1000,
      surfaceTokens: 100,
      lastCompaction: { surfaceTokensAfter: 50 },
      minNewSurfaceTokens: 100,
    }).ok,
    false,
  )
})

test('waitIdle resolves on idle, times out on busy, and follows whenIdle', async () => {
  assert.equal(await waitIdle({ status: 'idle' }, 10), true)
  assert.equal(await waitIdle({ status: 'running', whenIdle: () => new Promise(() => {}) }, 10), false)
  const late = {
    status: 'running',
    async whenIdle() {
      this.status = 'idle'
    },
  }
  assert.equal(await waitIdle(late, 50), true)
})

test('statusText prints the percentage and the binding cap', () => {
  const result = thresholds()
  const text = statusText({
    thresholds: result,
    pressure: 600000,
    card: { lastCompaction: null, updatedAt: 1, source: 'snapshot' },
    config: { autoCompact: { mode: 'boundary' } },
  })
  assert.match(text, /原生阈值=599040/)
  assert.match(text, /57.13%/)
  assert.match(text, /57.22%/)
  assert.equal(percent(0, 0), null)
})
