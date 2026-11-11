// Host half. 三件事：注册 report_progress、按会话统计“多久没汇报”、在规则触发时把方向拉回。
//
// 两条硬约束（改动前先读）：
// 1. 缓存前缀：系统提示 + 工具声明构成请求前缀。本插件刻意不注册任何 systemPrompt 分节，
//    工具名/描述/参数在进程内是常量；提醒只追加在对话尾部（post-execute 的 additionalContexts
//    或 agent.steer 的下一轮消息）。
// 2. 不改写既有内容：post-execute 只 spread 下游 decision 并追加 additionalContexts，
//    绝不替换 content/value。

import {
  buildAnchor,
  isManualVerification,
  isQuestion,
  lastAssistantText,
} from './anchor.js'
import {
  alignmentNotice,
  bashTipNotice,
  directionCheckNotice,
  directionCorrectionNotice,
  doneUnverifiedTip,
  noticeMessage as notice,
  PROGRESS_KIND,
} from './messages.js'
import {
  bashWrapperTip,
  extractWritePath,
  isPathInScope,
  isVerificationCommand,
  isWriteTool,
  turnStopReason,
} from './signals.js'
import { truncate } from './text.js'

export const name = 'dsh-progress'

/** 只需要工具注册表。不注入 systemPrompt 是设计约束，不是疏忽。 */
export const inject = ['tools']

const TOOL_NAME = 'report_progress'
const PHASES = ['start', 'working', 'problem', 'blocked', 'done']

const MAX_SUMMARY = 240
const MAX_DETAIL = 1200
const MAX_NEXT = 240

const DEFAULTS = {
  enabled: true,
  enforce: true,
  softLimit: 7,
  hardLimit: 10,
  failuresBeforeBlock: 3,
  subagents: false,
  exempt: ['ask_user_question'],
  direction: true,
  coach: true,
  maxCorrections: 2,
  noWriteLimit: 8,
}

const CONFIG_KEYS = Object.keys(DEFAULTS)

/* ------------------------------------------------------------------ *
 * 配置：fail loud，宁可装不上也不要静默跑错
 * ------------------------------------------------------------------ */

function readBool(key, value) {
  if (value === undefined) return DEFAULTS[key]
  if (typeof value !== 'boolean') throw new Error(`dsh-progress: 配置项 ${key} 必须是 true/false，收到 ${JSON.stringify(value)}`)
  return value
}

function readInt(key, value, min) {
  if (value === undefined) return DEFAULTS[key]
  if (!Number.isInteger(value) || value < min) throw new Error(`dsh-progress: 配置项 ${key} 必须是 >= ${min} 的整数，收到 ${JSON.stringify(value)}`)
  return value
}

function readList(key, value) {
  if (value === undefined) return [...DEFAULTS[key]]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`dsh-progress: 配置项 ${key} 必须是字符串数组，收到 ${JSON.stringify(value)}`)
  }
  return value.map((item) => item.trim())
}

function resolveConfig(input) {
  if (input === undefined || input === null) input = {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('dsh-progress: config 必须是一个对象')

  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new Error(`dsh-progress: 未知配置项 "${key}"，可用项：${CONFIG_KEYS.join(', ')}`)
    }
  }

  const config = {
    enabled: readBool('enabled', input.enabled),
    enforce: readBool('enforce', input.enforce),
    softLimit: readInt('softLimit', input.softLimit, 1),
    hardLimit: readInt('hardLimit', input.hardLimit, 2),
    failuresBeforeBlock: readInt('failuresBeforeBlock', input.failuresBeforeBlock, 1),
    subagents: readBool('subagents', input.subagents),
    exempt: readList('exempt', input.exempt),
    direction: readBool('direction', input.direction),
    coach: readBool('coach', input.coach),
    maxCorrections: readInt('maxCorrections', input.maxCorrections, 0),
    noWriteLimit: readInt('noWriteLimit', input.noWriteLimit, 3),
  }

  if (config.hardLimit <= config.softLimit) {
    throw new Error(`dsh-progress: hardLimit(${config.hardLimit}) 必须大于 softLimit(${config.softLimit})`)
  }
  return config
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function optionalText(key, value, limit) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`report_progress: ${key} 必须是字符串`)
  return truncate(value, limit)
}

/** 参数校验自己来：裸 JSON Schema 注册时管道的校验不保证执行，且这里要给出中文、可执行的提示。 */
function validateArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('report_progress: 参数必须是一个对象，例如 { "phase": "working", "summary": "正在读构建日志" }')
  }
  const phase = args.phase
  if (typeof phase !== 'string' || !PHASES.includes(phase)) {
    throw new Error(`report_progress: phase 必须是 ${PHASES.join(' / ')} 之一`)
  }
  const summary = typeof args.summary === 'string' ? truncate(args.summary, MAX_SUMMARY) : ''
  if (summary === '') throw new Error('report_progress: summary 不能为空，请用一句话说明你现在在做什么')
  return {
    phase,
    summary,
    detail: optionalText('detail', args.detail, MAX_DETAIL),
    next: optionalText('next', args.next, MAX_NEXT),
  }
}

/* ------------------------------------------------------------------ *
 * 工具描述：唯一“对模型说明规则”的静态载体（不是系统提示）
 * ------------------------------------------------------------------ */

function toolDescription(config) {
  return [
    'Tell the user what you are working on. The user cannot see your tool calls, the files you change, or the commands you run — only the messages you write.',
    '',
    'Use this tool:',
    '- before starting a multi-step task, with phase="start" and a one-sentence plan;',
    '- every few tool calls, with phase="working": what you just did and what comes next;',
    '- as soon as a step fails, surprises you, or you change approach, with phase="problem": what broke and how you will proceed;',
    '- when you truly cannot continue without the user, with phase="blocked";',
    '- before your final answer of a work turn, with phase="done": the outcome.',
    '',
    'Write `summary`, `detail`, and `next` in the same language the user writes, and keep them short. Reporting never pauses your work: call this tool, then continue immediately.',
    '',
    `The harness counts tool calls between reports. At ${config.softLimit} unreported calls you receive a reminder; at ${config.hardLimit} your next tool call is refused until you report. Do not report empty, vague, or plan-free text just to reset the counter — the user reads it.`,
  ].join('\n')
}

const PARAMETERS = {
  type: 'object',
  properties: {
    phase: {
      type: 'string',
      enum: PHASES,
      description: 'start = plan before working, working = regular update, problem = something broke or the approach changed, blocked = cannot continue without the user, done = finished.',
    },
    summary: {
      type: 'string',
      description: 'One short sentence in the user\'s language: what you are doing, or what you just learned or fixed.',
    },
    detail: {
      type: 'string',
      description: 'Optional: the concrete facts worth keeping — what you found, what broke, the exact error or command.',
    },
    next: {
      type: 'string',
      description: 'Optional: what you are about to do next.',
    },
  },
  required: ['phase', 'summary'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

export function apply(ctx, input) {
  const config = resolveConfig(input)

  if (!config.enabled) {
    ctx.logger?.debug?.('[dsh-progress] disabled by config')
    return
  }

  /** 每个会话一份状态；turn 结束即删，不会随会话数增长。 */
  const states = new Map()
  /** 本插件自己拦下的 callId：它们稍后也会经过 post-execute，但不该计入未汇报次数。 */
  const deniedCallIds = new Set()

  const stateOf = (sessionId) => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = {
        sinceReport: 0,
        failuresSinceReport: 0,
        nudged: false,
        anchor: null,
        alignmentShown: false,
        notices: 0,
        corrections: 0,
        turnStopSteered: false,
        lastReport: null,
        toolCalls: 0,
        callsSinceWrite: 0,
        hasWritten: false,
        lastWriteSeq: 0,
        lastVerificationSeq: 0,
        doneUnverified: false,
        noWriteNotified: false,
        noWriteReports: 0,
        noWriteCorrected: false,
        scopeEscapes: 0,
        scopeNotified: false,
        scopeCorrected: false,
        turnConcluded: false,
      }
      states.set(sessionId, state)
    }
    return state
  }

  const isSubagent = (agent) => {
    const header = agent?.session?.header
    if (header === undefined || header === null) return false
    return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
  }

  /** 这次调用是否计入“未汇报次数”。 */
  const tracked = (exec, agent) => {
    if (agent === undefined || agent === null) return false
    // PTC 内层：模型正卡在 run_code 里，中途没法插入一次汇报，拦了只会死锁。
    if (exec.parent !== undefined) return false
    if (exec.name === TOOL_NAME) return false
    if (config.exempt.includes(exec.name)) return false
    if (!config.subagents && isSubagent(agent)) return false
    return true
  }

  /** 汇报工具在本步是否真的可见；不可见就绝不拦，避免造出解不开的死锁。 */
  const reportingVisible = (exec, agent) => {
    const view = exec.toolSet?.view?.(agent)
    return view === undefined ? true : view.has(TOOL_NAME)
  }

  const nudgeText = (state) => {
    const lines = [
      `用户看不到你的工具调用。你已经连续 ${state.sinceReport} 次工具调用没有说明进展了。`,
      state.failuresSinceReport > 0
        ? `其中 ${state.failuresSinceReport} 次调用失败，请在 detail 里写清问题出在哪、你准备怎么处理。`
        : null,
      `请立刻调用 report_progress：phase 用 "working"（或有问题时用 "problem"），summary 一句话说明你在做什么，next 写下一步，然后继续原任务。`,
      state.sinceReport >= config.hardLimit
        ? `再继续不汇报，下一次工具调用会被拒绝执行。`
        : null,
    ]
    return lines.filter((line) => line !== null).join('')
  }

  /** 上下文行标签后面的短说明：一眼看出这次提醒的原因。 */
  const nudgeSummary = (state) =>
    state.failuresSinceReport > 0
      ? `${state.sinceReport} 次调用没汇报，其中 ${state.failuresSinceReport} 次失败`
      : `${state.sinceReport} 次调用没汇报`

  const denyReason = (state) => {
    if (state.failuresSinceReport >= config.failuresBeforeBlock) {
      return `先别继续动手：已经有 ${state.failuresSinceReport} 次工具调用失败，用户还不知道出了什么问题。请先调用 report_progress（phase="problem"），说明问题出在哪、你打算怎么处理，然后立刻重试刚才的操作。`
    }
    return `先别继续动手：你已经连续 ${state.sinceReport} 次工具调用没有汇报进展，用户不知道你在干什么。请先调用 report_progress（phase、summary、next），然后立刻重试刚才的操作。`
  }

  /* ---------------- 方向/教练辅助 ---------------- */

  const ensureAnchor = (agent, state) => {
    if (!config.direction) {
      state.anchor = null
      return null
    }
    const next = buildAnchor(ctx, agent, state)
    if (next === null) {
      state.anchor = null
      return null
    }
    if (state.anchor === null || state.anchor.request !== next.request) {
      // 新用户请求：重新给纠偏预算；旧请求上的“已提醒”不能带到新任务。
      state.alignmentShown = false
      state.notices = 0
      state.corrections = 0
      state.turnStopSteered = false
      state.noWriteNotified = false
      state.noWriteReports = 0
      state.noWriteCorrected = false
      state.scopeEscapes = 0
      state.scopeNotified = false
      state.scopeCorrected = false
    }
    state.anchor = next
    return next
  }

  const withContexts = (downstream, contexts) => {
    if (contexts.length === 0) return downstream
    return {
      ...downstream,
      additionalContexts: [...contexts, ...(downstream.additionalContexts ?? [])],
    }
  }

  const addCheck = (downstream, message) =>
    config.direction ? withContexts(downstream, [message]) : downstream

  const addTip = (downstream, state, message) => {
    if (!config.coach || state.notices >= 3) return downstream
    state.notices += 1
    return withContexts(downstream, [message])
  }

  const steer = (agent, state, message) => {
    if (!config.direction || state.corrections >= config.maxCorrections) return false
    if (typeof agent?.steer !== 'function') return false
    try {
      agent.steer(message)
      state.corrections += 1
      return true
    } catch {
      return false
    }
  }

  /**
   * 这个会话是否在 plan mode。
   *
   * 先问 planMode 服务；但 web profile 的 agent preset 会把 planMode 隔离到
   * preset 子作用域里，根级插件用 ctx.get('planMode') 可能拿不到（本机实测
   * 根级 plan-mode 是 inactive）。所以再读一次共享的 `plan` 投影：它由真正
   * 在跑的那个 plan-mode 实例注册，客户端也靠它显示模式，根级插件读得到。
   */
  const planModeActive = (agent) => {
    try {
      if (ctx.get?.('planMode')?.get?.(agent)?.active === true) return true
    } catch {
      // 服务没注册或还没就绪：继续看投影。
    }
    try {
      const plan = ctx.get?.('sessionProjections')?.snapshot?.(agent?.session, ['plan'])?.values?.plan
      return plan?.active === true
    } catch {
      return false
    }
  }

  const turnStopMessage = (reason, anchor, state) => {
    if (reason === 'done-unverified') {
      return directionCorrectionNotice({
        anchor,
        reason: '报了完成，但上次写文件后没有成功验证',
        observed: `最近 ${state.toolCalls} 次调用里没有看到成功的测试/构建`,
        next: '先跑一个最小验证；确实不能跑，就 report_progress 写明“手动验证/需要你看”。',
      })
    }
    if (reason === 'goal-active') {
      return directionCorrectionNotice({
        anchor,
        reason: 'goal 还是 active，回合却要结束了',
        observed: `当前 goal：${anchor.goal ?? '（未读到）'}`,
        next: '继续做；如果做完了就 report_progress(done)，做不下去就 blocked。',
      })
    }
    if (reason === 'not-done') {
      return directionCorrectionNotice({
        anchor,
        reason: '用户要的是改动，但还没有收口',
        observed: `已经写过文件，最后一次汇报是 ${state.lastReport?.phase ?? '（没有汇报）'}`,
        next: '补验证并 report_progress(done)，或写明还差什么。',
      })
    }
    if (reason === 'own-plan') {
      return directionCorrectionNotice({
        anchor,
        reason: '你自己写下的计划还没收口',
        observed: `计划：${anchor.declaredPlan ?? '（没有读到）'}`,
        next: '对照计划；没做完就继续，做完/做不了就 report_progress(done/blocked)。',
      })
    }
    return directionCheckNotice({
      anchor,
      reason: '目标较开放，回合要结束了还没有写下计划',
      observed: `已经调用了 ${state.toolCalls} 次工具`,
      next: '用一句话说明你理解的结果和下一步，再收工；如果已经完成就 report_progress(done)。',
    })
  }

  /* ---------------- 工具 ---------------- */

  ctx.tools.register({
    name: TOOL_NAME,
    description: toolDescription(config),
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(args) {
        const phase = PHASES.includes(args?.phase) ? args.phase : 'working'
        const summary = typeof args?.summary === 'string' ? truncate(args.summary, MAX_SUMMARY) : ''
        return [{ type: 'text', text: `✓ 已向用户汇报（${phase}）：${summary}` }]
      },
    },
    async execute(args, exec) {
      // 校验放在这里而不是注册时：参数是模型给的，必须按调用失败处理而不是让插件崩掉。
      const report = validateArgs(args)
      const sessionId = exec?.agent?.session?.id
      if (sessionId !== undefined) {
        const state = stateOf(sessionId)
        state.sinceReport = 0
        state.failuresSinceReport = 0
        state.nudged = false
        state.lastReport = report
      }
      // 只能返回 output.schema 允许的字段：多一个 phase 都会让输出校验失败。
      return { ok: true }
    },
  })

  if (!config.enforce) {
    ctx.logger?.debug?.('[dsh-progress] tool registered, enforcement disabled')
    return
  }

  /* ---------------- 汇报后的方向/验证检查 ---------------- */

  const handleReportPost = (exec, result, downstream, state) => {
    // 汇报本身失败（参数非法等）时，不要拿上一次成功的 lastReport 再做判断。
    if (result?.isError === true) return downstream
    const report = state.lastReport
    if (report === null) return downstream
    const agent = exec.agent
    const anchor = ensureAnchor(agent, state)
    // 纯状态/确认消息没有新任务：不拿它做完成/范围/只读判断。
    if (anchor?.statusOnly === true) return downstream

    if (report.phase === 'done') {
      const manual = isManualVerification(`${report.summary}\n${report.detail}\n${report.next}`)
      state.doneUnverified = !manual && state.lastWriteSeq > state.lastVerificationSeq
    }

    let next = downstream
    if (report.phase === 'done' && state.doneUnverified) {
      next = addTip(next, state, doneUnverifiedTip())
    }
    if (report.phase === 'done' || report.phase === 'blocked') return next
    if (anchor === null) return next

    // 清晰 + 要改东西，却连着很多次没有成功写入：先核对，第二次汇报再拉回。
    if (anchor.mode === 'clear' && anchor.intent === 'change' && state.callsSinceWrite >= config.noWriteLimit) {
      state.noWriteReports += 1
      if (state.noWriteReports >= 2 && !state.noWriteCorrected) {
        const message = directionCorrectionNotice({
          anchor,
          reason: `已经连续 ${state.callsSinceWrite} 次调用没有成功写入文件`,
          observed: `最近一次成功写入在 ${state.lastWriteSeq === 0 ? '本回合还没有' : `第 ${state.lastWriteSeq} 次调用`}`,
          next: '先确认要改哪个文件，做一次最小写入；只读调查已经够了。',
        })
        if (steer(agent, state, message)) state.noWriteCorrected = true
      } else if (!state.noWriteNotified) {
        state.noWriteNotified = true
        next = addCheck(
          next,
          directionCheckNotice({
            anchor,
            reason: `已经连续 ${state.callsSinceWrite} 次调用没有成功写入文件`,
            observed: '用户要的是改动，目前只有读取/查询',
            next: '确认要改哪个文件，做一次最小写入；如果还在调查，说明还缺什么。',
          }),
        )
      }
    }

    // 写入超出用户点名范围：第一次核对，第二次拉回。
    if (anchor.mode === 'clear' && anchor.paths.length > 0 && state.scopeEscapes > 0) {
      if (state.scopeEscapes >= 2 && !state.scopeCorrected) {
        const message = directionCorrectionNotice({
          anchor,
          reason: '写入目标超出了用户点名的范围',
          observed: `用户点名：${anchor.paths.join('、')}`,
          next: '确认这个文件是否必须改；如果是，先用一句话说明关联，否则回到点名范围。',
        })
        if (steer(agent, state, message)) state.scopeCorrected = true
      } else if (!state.scopeNotified) {
        state.scopeNotified = true
        next = addCheck(
          next,
          directionCheckNotice({
            anchor,
            reason: '写入目标超出了用户点名的范围',
            observed: `用户点名：${anchor.paths.join('、')}`,
            next: '确认这个文件是否必须改；如果是，先用一句话说明关联，否则回到点名范围。',
          }),
        )
      }
    }

    return next
  }

  /* ---------------- 工具后：计数、方向、教练 ---------------- */

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const agent = exec.agent
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return downstream

    const state = stateOf(sessionId)
    if (exec.name === TOOL_NAME) return handleReportPost(exec, result, downstream, state)
    if (!tracked(exec, agent)) return downstream
    // 自己拦下的调用还会经过这里一次，要跳过，否则一次拦截会被记成一次失败。
    if (deniedCallIds.delete(exec.callId)) return downstream

    state.toolCalls += 1
    state.sinceReport += 1
    state.callsSinceWrite += 1
    if (result?.isError === true) state.failuresSinceReport += 1
    // 工具主动结束了回合（例如 exit_plan_mode 被用户“要求修改”后退回输入框）：
    // 这是有意的收工，不是忘了汇报，收工时不要把它拉回来。
    if (result?.concludesTurn === true) state.turnConcluded = true

    const anchor = ensureAnchor(agent, state)
    const directionActive = config.direction && anchor !== null && anchor.statusOnly !== true
    let nextDecision = downstream

    // 模糊目标、还没有任何计划：第一次工具调用先请它对齐，不硬拉。
    if (directionActive && anchor.mode === 'vague' && !anchor.hasPlan && !state.alignmentShown) {
      state.alignmentShown = true
      nextDecision = addCheck(nextDecision, alignmentNotice(anchor))
    }

    if (isWriteTool(exec.name)) {
      if (result?.isError !== true) {
        const target = extractWritePath(exec)
        if (directionActive && anchor.paths.length > 0 && target !== null) {
          if (isPathInScope(target, anchor.paths)) {
            state.scopeEscapes = 0
            state.scopeNotified = false
            state.scopeCorrected = false
          } else {
            state.scopeEscapes += 1
            if (state.scopeEscapes >= 2 && !state.scopeCorrected) {
              const message = directionCorrectionNotice({
                anchor,
                reason: '写入目标超出了用户点名的范围',
                observed: `这次写入 ${target}，用户点名：${anchor.paths.join('、')}`,
                next: '确认是否必须改这个文件；如果是，先说明关联，否则回到点名范围。',
              })
              if (steer(agent, state, message)) state.scopeCorrected = true
            } else if (!state.scopeNotified) {
              state.scopeNotified = true
              nextDecision = addCheck(
                nextDecision,
                directionCheckNotice({
                  anchor,
                  reason: '写入目标超出了用户点名的范围',
                  observed: `这次写入 ${target}，用户点名：${anchor.paths.join('、')}`,
                  next: '确认是否必须改这个文件；如果是，先说明关联，否则回到点名范围。',
                }),
              )
            }
          }
        }

        state.hasWritten = true
        state.lastWriteSeq = state.toolCalls
        state.callsSinceWrite = 0
        state.noWriteReports = 0
        state.noWriteNotified = false
        state.noWriteCorrected = false
        state.doneUnverified = true
      }
    } else if (isVerificationCommand(exec) && result?.isError !== true) {
      state.lastVerificationSeq = state.toolCalls
      state.doneUnverified = false
    }

    if (config.coach && anchor?.statusOnly !== true) {
      const tip = bashWrapperTip(exec, agent)
      if (tip !== null) nextDecision = addTip(nextDecision, state, bashTipNotice(tip))
    }

    // 进度提醒保持原样：只在 softLimit 触发一次，且只追加、不替换。
    if (state.nudged || state.sinceReport < config.softLimit) return nextDecision
    state.nudged = true
    return withContexts(nextDecision, [notice(PROGRESS_KIND, nudgeText(state), nudgeSummary(state))])
  })

  /* ---------------- 收工前拉回 ---------------- */

  if (config.direction) {
    ctx.on('agent/turn-stopping', (payload) => {
      const agent = payload?.agent
      if (agent === undefined || agent === null) return
      if (payload?.signal?.aborted) return
      if (!config.subagents && isSubagent(agent)) return
      if (planModeActive(agent)) return

      const sessionId = agent.session?.id
      if (sessionId === undefined) return
      const state = states.get(sessionId)
      if (state === undefined || state.turnStopSteered || state.turnConcluded) return

      const report = state.lastReport
      if (report?.phase === 'blocked') return
      if (report?.phase === 'done' && !state.doneUnverified) return
      if (isQuestion(lastAssistantText(agent))) return

      const anchor = ensureAnchor(agent, state)
      if (anchor === null || anchor.statusOnly) return
      const reason = turnStopReason(anchor, state)
      if (reason === null) return
      if (steer(agent, state, turnStopMessage(reason, anchor, state))) state.turnStopSteered = true
    })
  }

  /* ---------------- 门禁 ---------------- */

  ctx.on('tools/pre-execute', async (exec, next) => {
    const downstream = await next()
    // 下游明确拒绝/取消时尊重它；allow 和“需要用户审批(ask)”都要过一道预算检查，
    // 否则只要挑需要审批的工具用，就能绕过硬上限。
    if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream
    if (!tracked(exec, exec.agent)) return downstream

    const sessionId = exec.agent.session?.id
    if (sessionId === undefined) return downstream

    const state = stateOf(sessionId)
    const overCalls = state.sinceReport >= config.hardLimit
    const overFailures = state.failuresSinceReport >= config.failuresBeforeBlock
    if (!overCalls && !overFailures) return downstream
    if (!reportingVisible(exec, exec.agent)) return downstream

    deniedCallIds.add(exec.callId)
    if (deniedCallIds.size > 512) deniedCallIds.clear()
    return { kind: 'deny', reason: denyReason(state) }
  })

  /* ---------------- 重置 ---------------- */

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (sessionId === undefined) return
    // 新回合重新给预算；回合结束后释放状态（崩掉的回合靠 turn/start 兜底）。
    if (event?.type === 'turn/start' || event?.type === 'turn/end') states.delete(sessionId)
  })

  // 会话被销毁时把它的计数彻底丢掉，别在内存里留下已死会话的残渣。
  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id
    if (sessionId === undefined) return
    states.delete(sessionId)
  })
}
