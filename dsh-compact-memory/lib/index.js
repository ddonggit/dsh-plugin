/**
 * dsh-compact-memory: keep working experience across native compaction.
 *
 * Division of labor:
 * - dsh `compaction-basic` owns token accounting, balanced edges, locking,
 *   retries, and the summary itself.
 * - This plugin owns the handoff card: capture before the shadow, re-inject
 *   after a successful compaction, and optionally run the same `/compact`
 *   path at a turn boundary (never earlier than the native threshold).
 *
 * @module dsh-compact-memory
 */

import { resolveConfig } from './config.js'
import { CardStore } from './store.js'
import { buildSnapshot } from './snapshot.js'
import { emptyCard, isCardEmpty, isStale, mergeSnapshot, trimToLimit } from './card.js'
import { buildCardMessage, buildNudgeMessage, hasMarkerInEvents } from './inject.js'
import { registerTools } from './tools.js'
import { registerCommand } from './command.js'
import {
  computeThresholds,
  maybeCompact,
  readContext,
  readOutputReserve,
  readSurfaceTokens,
  readTurn,
  statusText,
} from './scheduler.js'
import { CARD_MARKER, MAX_RECENT_EVENTS } from './constants.js'

export const name = 'dsh-compact-memory'
export const inject = []

/**
 * @param {object} ctx - Cordis context.
 * @param {object} [rawConfig] - loader config, validated by config.js.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  for (const warning of config.warnings ?? []) {
    ctx.logger?.warn?.(`[dsh-compact-memory] ${warning}`)
  }
  if (!config.enabled) {
    ctx.logger?.info?.('[dsh-compact-memory] disabled by config')
    return
  }

  const store = new CardStore(config.memoryDir, config)
  const states = new Map()
  const agents = new Map()
  const recent = new Map()
  const inFlight = new Set()
  let schedulerDisabled = null
  let writeWarned = false
  let disposed = false

  const log = (level, message) => {
    const logger = ctx.logger
    const fn = logger?.[level] ?? logger?.info
    if (typeof fn === 'function') fn.call(logger, `[dsh-compact-memory] ${message}`)
  }

  const getState = async (session) => {
    const id = session?.id
    if (!id) throw new Error('session id is required')
    const existing = states.get(id)
    if (existing) return existing
    let card = null
    try {
      card = await store.load(id)
    } catch (error) {
      log('warn', `读取卡片失败：${error?.message ?? error}`)
    }
    if (!card) card = emptyCard(id)
    if (!card.sections || typeof card.sections !== 'object') card.sections = emptyCard(id).sections
    if (!card.stats || typeof card.stats !== 'object') card.stats = emptyCard(id).stats
    const state = { card, recent: [] }
    states.set(id, state)
    return state
  }

  const saveState = async (session, state) => {
    try {
      await store.save(state.card)
    } catch (error) {
      if (!writeWarned) {
        writeWarned = true
        log('warn', `写入卡片失败（后续只保留在内存）：${error?.message ?? error}`)
      }
    }
  }

  const recentPush = (session, event) => {
    const id = session?.id
    if (!id) return
    let list = recent.get(id)
    if (!list) {
      list = []
      recent.set(id, list)
    }
    list.push(event)
    if (list.length > MAX_RECENT_EVENTS) list.splice(0, list.length - MAX_RECENT_EVENTS)
  }

  const eventsFor = (session, state) => {
    try {
      const events = session.snapshotEvents?.()
      if (Array.isArray(events) && events.length > 0) return events
    } catch {
      // fall through to the live ring buffer
    }
    return state.recent
  }

  const hasCardMarkerAfter = (session, endSeq) => {
    try {
      const from = Number.isInteger(endSeq) ? endSeq + 1 : 0
      const events = session.snapshotEvents?.(from)
      return hasMarkerInEvents(events, Number.isInteger(endSeq) ? endSeq : -1, CARD_MARKER)
    } catch {
      return false
    }
  }

  const refreshCard = async (session, { force = false } = {}) => {
    const state = await getState(session)
    const turn = readTurn(ctx, session)
    const stale = force || isStale(state.card, {
      turn,
      staleTurns: config.staleAfterTurns,
      now: Date.now(),
      maxAgeMs: config.staleAfterMs,
    })
    if (!stale && !isCardEmpty(state.card)) return state
    const events = eventsFor(session, state)
    const snapshot = buildSnapshot({ session, events, card: state.card, now: Date.now() })
    const merged = mergeSnapshot(state.card, snapshot, {
      stale,
      turn,
      seq: Number.isInteger(session?.seq) ? session.seq : null,
      now: Date.now(),
    })
    const trimmed = trimToLimit(merged, config.maxCardChars, { language: config.language })
    state.card = trimmed.card
    await saveState(session, state)
    return state
  }

  const status = async (session, agent) => {
    const state = await getState(session)
    const info = readContext(ctx, session)
    const pressure = info
      ? (Number.isInteger(info.projectedTokens) ? info.projectedTokens : info.pressureTokens)
      : undefined
    const thresholds = computeThresholds({
      contextWindow: info?.contextWindow,
      outputReserve: readOutputReserve(session, agent),
      headroomTokens: config.autoCompact.nativeHeadroomTokens,
      nativeThresholdRatio: config.autoCompact.nativeThresholdRatio,
      mode: config.autoCompact.mode,
      triggerAtNativeRatio: config.autoCompact.triggerAtNativeRatio,
      atWindowRatio: config.autoCompact.atWindowRatio,
    })
    return statusText({ thresholds, pressure, card: state.card, config })
  }

  const deps = {
    ctx,
    config,
    store,
    log,
    getState,
    saveState,
    refreshCard,
    status,
    isBusy: (session) => inFlight.has(session?.id),
    setBusy: (session, value) => {
      const id = session?.id
      if (!id) return
      if (value) inFlight.add(id)
      else inFlight.delete(id)
    },
    isDisabled: () => schedulerDisabled !== null,
    disable: (reason) => {
      if (schedulerDisabled !== null) return
      schedulerDisabled = reason
      log('warn', `自动压缩调度已停用：${reason}`)
    },
    isDisposed: () => disposed,
    save: (session, state) => saveState(session, state),
  }

  /* ---------------- compaction lifecycle ---------------- */

  const onCompactionStart = async (session) => {
    const state = await getState(session)
    state.lastStart = { at: Date.now() }
    if (!config.snapshotOnCompactionStart) return
    try {
      await refreshCard(session, { force: false })
    } catch (error) {
      log('warn', `压缩前快照失败：${error?.message ?? error}`)
    }
  }

  const onCompactionSummary = async (session, event) => {
    const state = await getState(session)
    state.pendingSummary = {
      id: event?.data?.compactionId ?? null,
      shadowedTokens: Number.isInteger(event?.data?.shadowedTokenCount)
        ? event.data.shadowedTokenCount
        : null,
    }
  }

  const onCompactionEnd = async (session, event) => {
    const state = await getState(session)
    const data = event?.data ?? {}
    if (data.error) {
      log('warn', `压缩失败（${data.compactionId ?? 'unknown'}）：${data.error}`)
      state.pendingSummary = null
      await saveState(session, state)
      return
    }
    const id = data.compactionId ?? `unknown-${event?.seq ?? 0}`
    const turn = Number.isInteger(data.turn) ? data.turn : readTurn(ctx, session)
    const shadowedTokens = state.pendingSummary?.id === id ? state.pendingSummary.shadowedTokens : null
    state.card.lastCompaction = {
      id,
      endSeq: Number.isInteger(event?.seq) ? event.seq : null,
      at: Date.now(),
      turn: turn ?? null,
      shadowedTokens,
      surfaceTokensAfter: readSurfaceTokens(ctx, session),
    }
    state.card.injected = null
    state.card.pendingNudge = null
    state.card.requested = null
    state.card.stats.compactions = (state.card.stats.compactions ?? 0) + 1
    state.pendingSummary = null
    await saveState(session, state)
  }

  /* ---------------- turn end: nudge + optional boundary compaction ---------------- */

  const onTurnEnd = async (session, event) => {
    const state = await getState(session)
    const turn = Number.isInteger(event?.data?.turn) ? event.data.turn : readTurn(ctx, session)
    const info = readContext(ctx, session)
    const pressure = info
      ? (Number.isInteger(info.projectedTokens) ? info.projectedTokens : info.pressureTokens)
      : undefined
    const pendingCard = Boolean(
      state.card.lastCompaction && state.card.injected?.compactionId !== state.card.lastCompaction.id,
    )

    if (
      !pendingCard &&
      config.nudge.enabled &&
      Number.isFinite(pressure) &&
      Number.isInteger(info?.contextWindow)
    ) {
      const thresholds = computeThresholds({
        contextWindow: info.contextWindow,
        outputReserve: readOutputReserve(session, agents.get(session.id)),
        headroomTokens: config.autoCompact.nativeHeadroomTokens,
        nativeThresholdRatio: config.autoCompact.nativeThresholdRatio,
        mode: 'boundary',
        triggerAtNativeRatio: 1,
        atWindowRatio: null,
      })
      if (thresholds.ok) {
        const nudgeAt = Math.floor(thresholds.native * config.nudge.atNativeRatio)
        const lastNudge = state.card.nudgedAtTurn
        const cooldownOk =
          !Number.isInteger(lastNudge) ||
          !Number.isInteger(turn) ||
          turn - lastNudge >= config.nudge.cooldownTurns
        if (pressure >= nudgeAt && cooldownOk && !state.card.pendingNudge) {
          state.card.pendingNudge = { turn: turn ?? null, at: Date.now(), pressure }
          await saveState(session, state)
        }
      }
    }

    const agent = agents.get(session.id)
    if (!agent) return
    try {
      await maybeCompact({ ctx, agent, session, config, state, deps })
    } catch (error) {
      log('warn', `自动压缩调度失败：${error?.message ?? error}`)
    }
  }

  /* ---------------- pre-step injection ---------------- */

  const onPreStep = async ({ agent, signal }, next) => {
    const decision = await next()
    if (disposed || !agent?.session || signal?.aborted || decision?.kind !== 'enter') return decision
    const session = agent.session
    try {
      const state = await getState(session)
      const turn = readTurn(ctx, session)

      if (config.injectAfterCompaction && state.card.lastCompaction) {
        const last = state.card.lastCompaction
        if (state.card.injected?.compactionId !== last.id) {
          if (hasCardMarkerAfter(session, last.endSeq)) {
            state.card.injected = { compactionId: last.id, at: Date.now(), turn }
            void saveState(session, state)
          } else {
            let card = state.card
            if (isCardEmpty(card)) {
              const snapshot = buildSnapshot({
                session,
                events: eventsFor(session, state),
                card,
                now: Date.now(),
              })
              card = mergeSnapshot(card, snapshot, {
                stale: true,
                turn,
                seq: Number.isInteger(session?.seq) ? session.seq : null,
                now: Date.now(),
              })
            }
            const trimmed = trimToLimit(card, config.maxCardChars, { language: config.language })
            if (trimmed.rendered.trim()) {
              state.card = trimmed.card
              state.card.injected = { compactionId: last.id, at: Date.now(), turn }
              state.card.stats.injections = (state.card.stats.injections ?? 0) + 1
              void saveState(session, state)
              return {
                ...decision,
                messages: [
                  ...(Array.isArray(decision.messages) ? decision.messages : []),
                  buildCardMessage({ rendered: trimmed.rendered, sourceKind: config.sourceKind }),
                ],
              }
            }
          }
        }
      }

      if (config.nudge.enabled && state.card.pendingNudge) {
        const nudge = state.card.pendingNudge
        if (state.card.nudgedAtTurn !== nudge.turn) {
          const info = readContext(ctx, session)
          const pressurePercent =
            Number.isFinite(nudge.pressure) && Number.isInteger(info?.contextWindow)
              ? (nudge.pressure / info.contextWindow) * 100
              : null
          state.card.nudgedAtTurn = nudge.turn
          state.card.pendingNudge = null
          void saveState(session, state)
          return {
            ...decision,
            messages: [
              ...(Array.isArray(decision.messages) ? decision.messages : []),
              buildNudgeMessage({ pressurePercent, sourceKind: config.sourceKind }),
            ],
          }
        }
      }
    } catch (error) {
      log('warn', `pre-step 注入失败：${error?.message ?? error}`)
    }
    return decision
  }

  /* ---------------- wiring ---------------- */

  ctx.on('agent/created', async ({ agent, source }) => {
    if (disposed || !agent?.session?.id) return
    const session = agent.session
    agents.set(session.id, agent)
    try {
      const state = await getState(session)
      if (isCardEmpty(state.card) && session.header?.parentSession) {
        const inherited = await store.inherit(session.header.parentSession, session.id).catch(() => null)
        if (inherited) {
          state.card = inherited
          await saveState(session, state)
        }
      }
      if (source === 'compact') {
        await refreshCard(session, { force: false }).catch(() => {})
      }
      if (config.injectOnResume) {
        const last = state.card.lastCompaction
        if (
          last &&
          state.card.injected?.compactionId !== last.id &&
          hasCardMarkerAfter(session, last.endSeq)
        ) {
          state.card.injected = { compactionId: last.id, at: Date.now(), turn: readTurn(ctx, session) }
          void saveState(session, state)
        }
      }
    } catch (error) {
      log('warn', `agent/created 初始化失败：${error?.message ?? error}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const id = agent?.session?.id
    if (id && agents.get(id) === agent) agents.delete(id)
  })

  ctx.on('session/disposed', (session) => {
    const id = session?.id
    if (!id) return
    states.delete(id)
    recent.delete(id)
    inFlight.delete(id)
    agents.delete(id)
  })

  const run = (promise) => {
    if (!promise || typeof promise.then !== 'function') return promise
    return promise.catch((error) => log('warn', `事件处理失败：${error?.message ?? error}`))
  }

  ctx.on('session/event', (session, event) => {
    if (disposed || !session?.id || !event) return undefined
    recentPush(session, event)
    if (event.type === 'turn/end') return run(onTurnEnd(session, event))
    if (event.type === 'compaction/start') return run(onCompactionStart(session, event))
    if (event.type === 'compaction/summary') return run(onCompactionSummary(session, event))
    if (event.type === 'compaction/end') return run(onCompactionEnd(session, event))
    return undefined
  })

  ctx.on('agent/pre-step', onPreStep)

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolsCtx) => registerTools(toolsCtx, deps))
    ctx.inject(['commands'], (commandsCtx) => registerCommand(commandsCtx, deps))
  } else {
    registerTools(ctx, deps)
    registerCommand(ctx, deps)
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposed = true
      states.clear()
      agents.clear()
      recent.clear()
      inFlight.clear()
    }, 'dsh-compact-memory lifecycle')
  }

  log('debug', `ready; memory=${config.memoryDir}; mode=${config.autoCompact.mode}`)
}
