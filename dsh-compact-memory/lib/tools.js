/**
 * Model-facing tools. Definitions are written by hand as registry-ready
 * `ToolDefinition` objects because this out-of-profile plugin cannot import
 * `@deepseek-ai/dsh-tools` (the profile resolves a different module copy).
 * @module dsh-compact-memory/tools
 */

import { SECTION_KEYS } from './constants.js'
import { normalizeSections, normalizeText, renderMarkdown, mergeSections, trimToLimit } from './card.js'
import { readTurn } from './scheduler.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    card: { type: 'string' },
    chars: { type: 'integer' },
    updatedAt: { type: 'integer' },
    note: { type: 'string' },
  },
  required: ['ok'],
}

function renderText(_args, value) {
  const text = value?.card || value?.note || (value?.ok ? 'ok' : 'failed')
  return [{ type: 'text', text }]
}

function descriptions(language) {
  if (language === 'en') {
    return {
      read: 'Read this session\'s work handoff card (goal, decisions, constraints, pitfalls, progress, next steps). Use it after compaction when details are missing.',
      write: 'Update the work handoff card. Call it after finishing a stage, making a key decision, hitting a pitfall, before a long task, or when context pressure is high. Write conclusions and reasons, not transcripts.',
      request: 'Request compaction at the next safe turn boundary (not immediately). Use it when a stage just finished and the history is mostly consumed tool output.',
      status: 'Show the current context pressure, native compaction threshold, plugin trigger, and last compaction.',
    }
  }
  return {
    read: '读取本会话的工作交接卡（目标/决定/约束/坑/进度/下一步）。压缩后如果想不起细节，先读它。',
    write: '更新工作交接卡。完成一个阶段、做出关键决定、踩坑、准备长任务或上下文压力高时调用；只写结论与原因，不写过程。',
    request: '请求在下一个安全的回合边界压缩历史（不是立即压缩）。刚完成一个阶段、历史里多是已消费的工具输出时使用。',
    status: '查看当前上下文压力、原生压缩阈值、插件触发点和上次压缩信息。',
  }
}

/**
 * Register the four model-facing tools when the tools service exists.
 * @param {object} ctx
 * @param {object} deps
 */
export function registerTools(ctx, deps) {
  if (typeof ctx?.tools?.register !== 'function') return
  const config = deps.config
  const text = descriptions(config.language)

  const register = (definition) => {
    try {
      ctx.tools.register(definition)
    } catch (error) {
      deps.log?.('warn', `注册工具 ${definition.name} 失败：${error?.message ?? error}`)
    }
  }

  register({
    name: 'worklog_read',
    description: text.read,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        section: {
          type: 'string',
          enum: [...SECTION_KEYS],
          description: 'Optional section key; omit to read the whole card.',
        },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (!session?.id) return { ok: false, note: '需要 agent 会话' }
      const state = await deps.getState(session)
      const card = state.card
      const section = typeof args?.section === 'string' ? args.section : ''
      if (section) {
        if (!SECTION_KEYS.includes(section)) {
          return { ok: false, note: `未知小节：${section}` }
        }
        const value = card.sections?.[section]
        const content = Array.isArray(value) ? value.map((item) => `- ${item}`).join('\n') : String(value ?? '')
        return {
          ok: true,
          card: content || '（该小节为空）',
          chars: content.length,
          updatedAt: card.updatedAt,
        }
      }
      const rendered = trimToLimit(card, config.maxCardChars, { language: config.language }).rendered
      return { ok: true, card: rendered, chars: rendered.length, updatedAt: card.updatedAt }
    },
  })

  register({
    name: 'worklog_write',
    description: text.write,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', description: 'What the user wants, including changes of mind.' },
        done: { type: 'array', items: { type: 'string' }, description: 'Completed work and conclusions.' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Key decisions and why.' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Must/never/only rules and preferences.' },
        pitfalls: { type: 'array', items: { type: 'string' }, description: 'Failed attempts and traps to avoid.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key files, directories, and paths; do not paste shell commands.',
        },
        next: { type: 'array', items: { type: 'string' }, description: 'Next steps and open work.' },
        questions: { type: 'array', items: { type: 'string' }, description: 'Questions waiting for the user.' },
        freeform: { type: 'string', description: 'Anything else worth preserving.' },
        mode: {
          type: 'string',
          enum: ['merge', 'replace'],
          description: 'merge appends new bullets; replace replaces only the sections you name.',
        },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (!session?.id) return { ok: false, note: '需要 agent 会话' }
      const patch = normalizeSections(args ?? {})
      if (Object.keys(patch).length === 0) {
        return { ok: false, note: '没有可写入的字段；请至少给出一个小节。' }
      }
      const state = await deps.getState(session)
      const turn = readTurn(deps.ctx, session)
      const mode = args?.mode === 'replace' ? 'replace' : 'merge'
      const merged = mergeSections(state.card, patch, {
        mode,
        turn,
        seq: session.seq,
        source: 'model',
      })
      const trimmed = trimToLimit(merged, config.maxCardChars, { language: config.language })
      state.card = trimmed.card
      await deps.saveState(session, state)
      return {
        ok: true,
        card: trimmed.rendered,
        chars: trimmed.rendered.length,
        updatedAt: state.card.updatedAt,
      }
    },
  })

  register({
    name: 'compact_request',
    description: text.request,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: {
          type: 'string',
          description: 'Why this is a safe boundary (e.g., a stage finished).',
        },
      },
      required: ['reason'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (!session?.id) return { ok: false, note: '需要 agent 会话' }
      const reason = normalizeText(args?.reason, 200)
      if (!reason) return { ok: false, note: 'reason 不能为空' }
      const state = await deps.getState(session)
      const turn = readTurn(deps.ctx, session)
      state.card.requested = { turn: turn ?? null, reason, at: Date.now() }
      await deps.saveState(session, state)
      return {
        ok: true,
        note: `已记录；将在下一个安全回合边界压缩（原因：${reason}）。`,
      }
    },
  })

  register({
    name: 'compact_status',
    description: text.status,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(_args, exec) {
      const session = exec?.agent?.session
      if (!session?.id) return { ok: false, note: '需要 agent 会话' }
      const status = await deps.status(session, exec.agent)
      return { ok: true, note: status }
    },
  })
}

export { OUTPUT_SCHEMA }
