/**
 * Config defaults and strict validation. Fail fast at plugin load rather than
 * silently ignoring a typo that would change compaction timing.
 * @module dsh-compact-memory/config
 */

import os from 'node:os'
import path from 'node:path'

export const DEFAULTS = Object.freeze({
  enabled: true,
  memoryDir: '',
  maxCardChars: 6000,
  language: 'zh',
  injectAfterCompaction: true,
  injectOnResume: true,
  snapshotOnCompactionStart: true,
  mirrorMarkdown: true,
  historyLimit: 10,
  staleAfterTurns: 2,
  staleAfterMs: 6 * 60 * 60 * 1000,
  sourceKind: 'compact-memory',
  debug: false,
  nudge: Object.freeze({
    enabled: true,
    atNativeRatio: 0.7,
    cooldownTurns: 3,
  }),
  autoCompact: Object.freeze({
    mode: 'boundary',
    triggerAtNativeRatio: 1,
    atWindowRatio: 0.7,
    nativeThresholdRatio: 0.8,
    nativeHeadroomTokens: 65536,
    minNewSurfaceTokens: 20000,
    minTurnsSinceLast: 2,
    idleGraceMs: 2000,
    timeoutMs: 180000,
    skipSubagents: true,
  }),
})

const MODES = new Set(['native', 'boundary', 'early', 'window'])
const LANGUAGES = new Set(['zh', 'en'])

function fail(message) {
  throw new Error(`dsh-compact-memory: ${message}`)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertObject(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`)
}

function assertKnownKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`unknown ${name} key "${key}"`)
  }
}

function asBoolean(value, name) {
  if (typeof value !== 'boolean') fail(`${name} must be a boolean`)
  return value
}

function asInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in [${min}, ${max}]`)
  }
  return value
}

function asRatio(value, name, { allowZero = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value > 1 || (allowZero ? value < 0 : value <= 0)) {
    fail(`${name} must be a number in ${allowZero ? '[0, 1]' : '(0, 1]'}`)
  }
  return value
}

function asString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    fail(`${name} must be a ${allowEmpty ? '' : 'non-empty '}string`)
  }
  return value
}

function resolveMemoryDir(value, env) {
  asString(value, 'memoryDir', { allowEmpty: true })
  const home = env?.DSH_HOME && String(env.DSH_HOME).trim() !== ''
    ? path.resolve(String(env.DSH_HOME))
    : path.join(os.homedir(), '.dsh')
  if (value === '') return path.join(home, 'compact-memory')
  if (path.isAbsolute(value)) return path.resolve(value)
  const rel = value.replace(/\\/g, '/')
  if (rel.split('/').includes('..')) fail('memoryDir must not contain ".."')
  return path.resolve(home, rel)
}

/**
 * Merge user config with defaults and validate every field.
 * @param {unknown} raw - loader-provided config.
 * @param {Record<string, string | undefined>} [env] - process environment (DSH_HOME).
 * @returns {object} frozen resolved config with a `warnings` array.
 */
export function resolveConfig(raw = {}, env = process.env) {
  if (raw === undefined || raw === null) raw = {}
  assertObject(raw, 'config')
  assertKnownKeys(raw, Object.keys(DEFAULTS), 'config')

  const nudgeRaw = raw.nudge ?? {}
  const autoRaw = raw.autoCompact ?? {}
  assertObject(nudgeRaw, 'nudge')
  assertObject(autoRaw, 'autoCompact')
  assertKnownKeys(nudgeRaw, Object.keys(DEFAULTS.nudge), 'nudge')
  assertKnownKeys(autoRaw, Object.keys(DEFAULTS.autoCompact), 'autoCompact')

  const cfg = {
    ...DEFAULTS,
    ...raw,
    nudge: { ...DEFAULTS.nudge, ...nudgeRaw },
    autoCompact: { ...DEFAULTS.autoCompact, ...autoRaw },
  }
  const warnings = []

  cfg.enabled = asBoolean(cfg.enabled, 'enabled')
  cfg.injectAfterCompaction = asBoolean(cfg.injectAfterCompaction, 'injectAfterCompaction')
  cfg.injectOnResume = asBoolean(cfg.injectOnResume, 'injectOnResume')
  cfg.snapshotOnCompactionStart = asBoolean(cfg.snapshotOnCompactionStart, 'snapshotOnCompactionStart')
  cfg.mirrorMarkdown = asBoolean(cfg.mirrorMarkdown, 'mirrorMarkdown')
  cfg.debug = asBoolean(cfg.debug, 'debug')
  cfg.nudge.enabled = asBoolean(cfg.nudge.enabled, 'nudge.enabled')
  cfg.autoCompact.skipSubagents = asBoolean(cfg.autoCompact.skipSubagents, 'autoCompact.skipSubagents')

  cfg.maxCardChars = asInteger(cfg.maxCardChars, 'maxCardChars', { min: 500, max: 200000 })
  cfg.historyLimit = asInteger(cfg.historyLimit, 'historyLimit', { min: 0, max: 100 })
  cfg.staleAfterTurns = asInteger(cfg.staleAfterTurns, 'staleAfterTurns', { min: 0, max: 1000 })
  cfg.staleAfterMs = asInteger(cfg.staleAfterMs, 'staleAfterMs', { min: 0, max: 365 * 24 * 60 * 60 * 1000 })

  cfg.language = asString(cfg.language, 'language')
  if (!LANGUAGES.has(cfg.language)) fail(`language must be one of ${[...LANGUAGES].join(', ')}`)

  cfg.sourceKind = asString(cfg.sourceKind, 'sourceKind')
  if (!/^[a-z][a-z0-9._-]*$/.test(cfg.sourceKind)) {
    fail('sourceKind must match /^[a-z][a-z0-9._-]*$/')
  }

  cfg.nudge.atNativeRatio = asRatio(cfg.nudge.atNativeRatio, 'nudge.atNativeRatio')
  cfg.nudge.cooldownTurns = asInteger(cfg.nudge.cooldownTurns, 'nudge.cooldownTurns', { min: 0, max: 1000 })

  cfg.autoCompact.mode = asString(cfg.autoCompact.mode, 'autoCompact.mode')
  if (!MODES.has(cfg.autoCompact.mode)) {
    fail(`autoCompact.mode must be one of ${[...MODES].join(', ')}`)
  }
  cfg.autoCompact.nativeThresholdRatio = asRatio(
    cfg.autoCompact.nativeThresholdRatio,
    'autoCompact.nativeThresholdRatio',
  )
  cfg.autoCompact.nativeHeadroomTokens = asInteger(
    cfg.autoCompact.nativeHeadroomTokens,
    'autoCompact.nativeHeadroomTokens',
    { min: 0, max: 4 * 1024 * 1024 },
  )
  cfg.autoCompact.minNewSurfaceTokens = asInteger(
    cfg.autoCompact.minNewSurfaceTokens,
    'autoCompact.minNewSurfaceTokens',
    { min: 0, max: 100 * 1024 * 1024 },
  )
  cfg.autoCompact.minTurnsSinceLast = asInteger(
    cfg.autoCompact.minTurnsSinceLast,
    'autoCompact.minTurnsSinceLast',
    { min: 0, max: 10000 },
  )
  cfg.autoCompact.idleGraceMs = asInteger(cfg.autoCompact.idleGraceMs, 'autoCompact.idleGraceMs', {
    min: 0,
    max: 60000,
  })
  cfg.autoCompact.timeoutMs = asInteger(cfg.autoCompact.timeoutMs, 'autoCompact.timeoutMs', {
    min: 1000,
    max: 30 * 60 * 1000,
  })

  if (cfg.autoCompact.triggerAtNativeRatio > 1) {
    warnings.push(
      `autoCompact.triggerAtNativeRatio=${cfg.autoCompact.triggerAtNativeRatio} 已按 1.0 处理（不会早于原生）`,
    )
    cfg.autoCompact.triggerAtNativeRatio = 1
  }
  cfg.autoCompact.triggerAtNativeRatio = asRatio(
    cfg.autoCompact.triggerAtNativeRatio,
    'autoCompact.triggerAtNativeRatio',
  )

  if (cfg.autoCompact.atWindowRatio !== null && cfg.autoCompact.atWindowRatio !== undefined) {
    cfg.autoCompact.atWindowRatio = asRatio(cfg.autoCompact.atWindowRatio, 'autoCompact.atWindowRatio')
  } else if (cfg.autoCompact.mode === 'window') {
    cfg.autoCompact.atWindowRatio = DEFAULTS.autoCompact.atWindowRatio
  } else {
    cfg.autoCompact.atWindowRatio = null
  }

  if (cfg.autoCompact.mode === 'early' && cfg.autoCompact.triggerAtNativeRatio >= 1) {
    fail('autoCompact.mode="early" 需要 triggerAtNativeRatio < 1；想与原生同阈值请用 boundary')
  }

  cfg.memoryDir = resolveMemoryDir(cfg.memoryDir, env)

  Object.defineProperty(cfg, 'warnings', {
    value: Object.freeze(warnings),
    enumerable: true,
  })
  return Object.freeze(cfg)
}
