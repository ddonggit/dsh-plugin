import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { resolveConfig } from '../lib/config.js'

const ENV = { DSH_HOME: path.join('/tmp', 'dsh-config-test') }

test('defaults are safe: boundary mode, no earlier than native', () => {
  const config = resolveConfig({}, ENV)
  assert.equal(config.enabled, true)
  assert.equal(config.autoCompact.mode, 'boundary')
  assert.equal(config.autoCompact.triggerAtNativeRatio, 1)
  assert.equal(config.autoCompact.nativeHeadroomTokens, 65536)
  assert.equal(config.memoryDir, path.join(ENV.DSH_HOME, 'compact-memory'))
  assert.equal(config.warnings.length, 0)
})

test('unknown top-level and nested keys fail fast', () => {
  assert.throws(() => resolveConfig({ nope: true }, ENV), /unknown config key/)
  assert.throws(() => resolveConfig({ autoCompact: { nope: true } }, ENV), /unknown autoCompact key/)
  assert.throws(() => resolveConfig({ nudge: { nope: true } }, ENV), /unknown nudge key/)
})

test('early mode requires a ratio below 1', () => {
  assert.throws(
    () => resolveConfig({ autoCompact: { mode: 'early', triggerAtNativeRatio: 1 } }, ENV),
    /early/,
  )
  const config = resolveConfig({ autoCompact: { mode: 'early', triggerAtNativeRatio: 0.9 } }, ENV)
  assert.equal(config.autoCompact.triggerAtNativeRatio, 0.9)
})

test('a ratio above 1 is clamped to 1 with a warning', () => {
  const config = resolveConfig({ autoCompact: { triggerAtNativeRatio: 1.2 } }, ENV)
  assert.equal(config.autoCompact.triggerAtNativeRatio, 1)
  assert.equal(config.warnings.length, 1)
  assert.match(config.warnings[0], /不会早于原生/)
})

test('unsafe source kinds and traversal paths are rejected', () => {
  assert.throws(() => resolveConfig({ sourceKind: 'Bad Kind' }, ENV), /sourceKind/)
  assert.throws(() => resolveConfig({ memoryDir: '../escape' }, ENV), /\.\./)
})

test('window mode keeps an explicit ratio and native mode passes validation', () => {
  const windowed = resolveConfig({ autoCompact: { mode: 'window', atWindowRatio: 0.5 } }, ENV)
  assert.equal(windowed.autoCompact.atWindowRatio, 0.5)
  const native = resolveConfig({ autoCompact: { mode: 'native' } }, ENV)
  assert.equal(native.autoCompact.mode, 'native')
})
