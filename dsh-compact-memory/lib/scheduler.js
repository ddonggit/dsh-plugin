/**
 * Threshold math and the optional boundary-first compaction scheduler.
 *
 * The native backend uses `floor(min(W * 0.8, W - O - B))` where O is the
 * routed output reservation and B the compaction headroom. This module mirrors
 * that formula and guarantees `trigger <= native` in every mode.
 * @module dsh-compact-memory/scheduler
 */

export function percent(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null
  return Math.round((value / total) * 10000) / 100
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Compute the native threshold and this plugin's trigger.
 * @param {{
 *   contextWindow?: number,
 *   outputReserve?: number,
 *   headroomTokens?: number,
 *   nativeThresholdRatio?: number,
 *   mode?: 'native'|'boundary'|'early'|'window',
 *   triggerAtNativeRatio?: number,
 *   atWindowRatio?: number|null,
 * }} input
 * @returns {object}
 */
export function computeThresholds({
  contextWindow,
  outputReserve = 0,
  headroomTokens = 65536,
  nativeThresholdRatio = 0.8,
  mode = 'boundary',
  triggerAtNativeRatio = 1,
  atWindowRatio = 0.7,
} = {}) {
  const W = Number(contextWindow)
  if (!Number.isInteger(W) || W <= 0) {
    return { ok: false, permanent: false, reason: `contextWindow 尚未可用（${contextWindow}）` }
  }
  const O = Math.max(0, Number(outputReserve) || 0)
  const B = Math.max(0, Number(headroomTokens) || 0)
  const ratio = Number(nativeThresholdRatio)
  if (!(ratio > 0 && ratio <= 1)) {
    return { ok: false, permanent: true, reason: `nativeThresholdRatio 无效（${nativeThresholdRatio}）` }
  }
  const nominal = W * ratio
  const capacity = W - O - B
  const native = Math.floor(Math.min(nominal, capacity))
  if (!Number.isFinite(native) || native <= 0) {
    return {
      ok: false,
      permanent: true,
      reason: `W-O-B<=0（W=${W}, O=${O}, B=${B}）；请检查模型 maxTokens 或 headroom`,
    }
  }
  const safeMode = String(mode)
  let trigger = native
  let capped = false
  if (safeMode === 'early') {
    trigger = Math.floor(native * clamp(Number(triggerAtNativeRatio), 0, 1))
  } else if (safeMode === 'window') {
    const windowRatio = Number(atWindowRatio)
    if (!(windowRatio > 0 && windowRatio <= 1)) {
      return { ok: false, permanent: true, reason: `atWindowRatio 无效（${atWindowRatio}）` }
    }
    const desired = Math.floor(W * windowRatio)
    trigger = Math.min(desired, native)
    capped = desired > native
  } else if (safeMode === 'boundary') {
    trigger = native
  } else if (safeMode === 'native') {
    return { ok: false, permanent: false, reason: 'mode=native（不调度）' }
  } else {
    return { ok: false, permanent: true, reason: `未知 mode（${safeMode}）` }
  }
  trigger = Math.max(1, Math.min(trigger, native))
  return {
    ok: true,
    mode: safeMode,
    W,
    O,
    B,
    nominal: Math.floor(nominal),
    capacity,
    native,
    trigger,
    capped,
    binding: capacity < nominal ? 'capacity' : 'ratio',
    nativePercent: percent(native, W),
    triggerPercent: percent(trigger, W),
  }
}

export function readContext(ctx, session) {
  try {
    const info = ctx?.tokenMeter?.contextPressure?.(session)
    return info && typeof info === 'object' ? info : null
  } catch {
    return null
  }
}

export function readOutputReserve(session, agent) {
  try {
    const header = session?.requestHeader?.()
    const value = header?.config?.maxTokens
    if (Number.isInteger(value) && value >= 0) return value
  } catch {
    // fall through to the live agent options
  }
  const value = agent?.options?.maxTokens
  return Number.isInteger(value) && value >= 0 ? value : 0
}

export function readTurn(ctx, session) {
  try {
    const turn = ctx?.agents?.turnBoundaryOf?.(session)?.lastTurn
    return Number.isInteger(turn) ? turn : null
  } catch {
    return null
  }
}

export function readSurfaceTokens(ctx, session) {
  try {
    const measurement = ctx?.tokenMeter?.measure?.(session)
    return Number.isInteger(measurement?.surfaceTokens) ? measurement.surfaceTokens : null
  } catch {
    return null
  }
}

/**
 * Pure decision function behind the scheduler; unit-testable without a host.
 * @param {object} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function shouldCompact({
  thresholds,
  pressure,
  turn = null,
  lastCompaction = null,
  surfaceTokens = null,
  requested = null,
  minTurnsSinceLast = 0,
  minNewSurfaceTokens = 0,
}) {
  if (!thresholds?.ok) return { ok: false, reason: thresholds?.reason ?? 'no-thresholds' }
  if (!Number.isFinite(pressure) || pressure < 0) return { ok: false, reason: 'no-pressure' }
  const byRequest = Boolean(requested)
  if (pressure < thresholds.trigger && !byRequest) {
    return { ok: false, reason: `pressure ${pressure} < trigger ${thresholds.trigger}` }
  }
  const lastTurn = lastCompaction?.turn
  if (
    Number.isInteger(turn) &&
    Number.isInteger(lastTurn) &&
    lastTurn >= 0 &&
    turn - lastTurn < minTurnsSinceLast
  ) {
    return { ok: false, reason: `cooldown ${turn - lastTurn} < ${minTurnsSinceLast}` }
  }
  const lastSurface = lastCompaction?.surfaceTokensAfter
  if (
    Number.isInteger(surfaceTokens) &&
    Number.isInteger(lastSurface) &&
    surfaceTokens - lastSurface < minNewSurfaceTokens
  ) {
    return { ok: false, reason: `growth ${surfaceTokens - lastSurface} < ${minNewSurfaceTokens}` }
  }
  return { ok: true, reason: byRequest ? 'requested' : 'pressure' }
}

/**
 * Wait for an idle agent without hanging a turn-end handler forever.
 * @param {object} agent
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
export async function waitIdle(agent, ms) {
  if (!agent) return false
  if (agent.status === 'idle') return true
  if (typeof agent.whenIdle !== 'function') return false
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms))
  })
  try {
    const result = await Promise.race([
      Promise.resolve(agent.whenIdle()).then(() => true, () => false),
      timeout,
    ])
    return result === true && agent.status === 'idle'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Decide and, when allowed, run the same `/compact` path a human would run.
 * Never throws into the caller; every failure is logged and reported.
 * @param {object} input
 * @returns {Promise<object>}
 */
export async function maybeCompact({ ctx, agent, session, config, state, deps }) {
  const ac = config.autoCompact
  if (ac.mode === 'native') return { skipped: 'mode-native' }
  if (deps.isDisposed?.()) return { skipped: 'disposed' }
  if (deps.isDisabled?.()) return { skipped: 'disabled' }
  if (!agent || !session) return { skipped: 'no-agent' }
  if (deps.isBusy?.(session)) return { skipped: 'busy' }
  if (ac.skipSubagents && session.header?.origin === 'subagent') return { skipped: 'subagent' }
  if (typeof ctx.commands?.execute !== 'function') {
    deps.disable?.('commands 服务不可用')
    return { skipped: 'no-commands' }
  }
  if (typeof ctx.tokenMeter?.contextPressure !== 'function') {
    return { skipped: 'no-token-meter' }
  }

  const idle = await waitIdle(agent, ac.idleGraceMs)
  if (!idle || deps.isDisposed?.()) return { skipped: 'not-idle' }

  const info = readContext(ctx, session)
  if (!info) return { skipped: 'no-pressure' }
  const pressure = Number.isInteger(info.projectedTokens) ? info.projectedTokens : info.pressureTokens
  if (!Number.isFinite(pressure)) return { skipped: 'no-pressure' }

  const thresholds = computeThresholds({
    contextWindow: info.contextWindow,
    outputReserve: readOutputReserve(session, agent),
    headroomTokens: ac.nativeHeadroomTokens,
    nativeThresholdRatio: ac.nativeThresholdRatio,
    mode: ac.mode,
    triggerAtNativeRatio: ac.triggerAtNativeRatio,
    atWindowRatio: ac.atWindowRatio,
  })
  if (!thresholds.ok) {
    if (thresholds.permanent) deps.disable?.(thresholds.reason)
    return { skipped: thresholds.reason }
  }

  const turn = readTurn(ctx, session)
  const needsSurface = pressure >= thresholds.trigger || Boolean(state.card?.requested)
  const surfaceTokens = needsSurface ? readSurfaceTokens(ctx, session) : null
  const decision = shouldCompact({
    thresholds,
    pressure,
    turn,
    lastCompaction: state.card?.lastCompaction ?? null,
    surfaceTokens,
    requested: state.card?.requested ?? null,
    minTurnsSinceLast: ac.minTurnsSinceLast,
    minNewSurfaceTokens: ac.minNewSurfaceTokens,
  })
  if (!decision.ok) {
    deps.log?.('debug', `skip: ${decision.reason}`)
    return { skipped: decision.reason }
  }

  deps.setBusy?.(session, true)
  const controller = new AbortController()
  let timer
  try {
    await deps.refreshCard?.(session, { force: false })
    if (deps.isDisposed?.()) return { skipped: 'disposed' }
    timer = setTimeout(() => controller.abort(new Error('compact timeout')), ac.timeoutMs)
    const result = await ctx.commands.execute(agent, '/compact', [], controller.signal)
    if (result === undefined) {
      deps.disable?.('未找到 /compact 命令')
      return { skipped: 'no-command' }
    }
    if (result?.kind === 'success') {
      deps.log?.(
        'info',
        `compaction requested at ${thresholds.trigger} tokens (native ${thresholds.native}): ${result.text ?? ''}`,
      )
      return { ok: true, result, thresholds, pressure }
    }
    deps.log?.('debug', `compact returned ${result?.kind ?? 'unknown'}: ${result?.text ?? ''}`)
    return { ok: false, result, thresholds, pressure }
  } catch (error) {
    if (controller.signal.aborted) deps.log?.('debug', 'compact aborted (timeout or session close)')
    else deps.log?.('warn', `compact failed: ${error?.message ?? error}`)
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
    deps.setBusy?.(session, false)
    if (state.card) {
      state.card.lastAttempt = {
        at: Date.now(),
        turn: turn ?? null,
        pressure,
        trigger: thresholds.trigger,
      }
      try {
        await deps.save?.(session, state)
      } catch {
        // save failures are already logged by the store wrapper
      }
    }
  }
}

/**
 * Human-readable numbers for `compact_status`.
 * @param {{ thresholds: object, pressure?: number, card: object, config: object }} input
 * @returns {string}
 */
export function statusText({ thresholds, pressure, card, config }) {
  const lines = [`模式：${config.autoCompact.mode}`]
  if (!thresholds?.ok) {
    lines.push(`压缩阈值：不可用（${thresholds?.reason ?? '未知'}）`)
    if (Number.isFinite(pressure)) lines.push(`当前压力=${pressure}`)
  } else {
    lines.push(`上下文窗口 W=${thresholds.W}；输出预留 O=${thresholds.O}；headroom B=${thresholds.B}`)
    lines.push(
      `原生阈值=${thresholds.native}（${thresholds.nativePercent}%）；插件触发=${thresholds.trigger}（${thresholds.triggerPercent}%）；绑定上限=${
        thresholds.binding === 'capacity' ? '容量（W-O-B）' : '比例（0.8W）'
      }`,
    )
    if (thresholds.capped) {
      lines.push('提示：window 设置高于原生阈值，已按原生阈值截断（不会更晚压缩）。')
    }
    if (Number.isFinite(pressure)) {
      lines.push(`当前压力=${pressure}（${percent(pressure, thresholds.W)}%）`)
    } else {
      lines.push('当前压力：尚无请求记录')
    }
  }
  lines.push(
    `上次压缩：${
      card?.lastCompaction
        ? `${card.lastCompaction.id} @ seq ${card.lastCompaction.endSeq}`
        : '无'
    }`,
  )
  lines.push(
    `卡片更新：${card?.updatedAt ? new Date(card.updatedAt).toISOString() : '无'}（${card?.source ?? '空'}）`,
  )
  return lines.join('\n')
}
