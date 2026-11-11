/**
 * `/handoff` command: show or rebuild the current card for the calling agent.
 * @module dsh-compact-memory/command
 */

import { COMMAND_ID } from './constants.js'
import { renderMarkdown } from './card.js'

/**
 * @param {object} ctx
 * @param {object} deps
 */
export function registerCommand(ctx, deps) {
  if (typeof ctx?.commands?.register !== 'function') return
  try {
    ctx.commands.register({
      definitionId: COMMAND_ID,
      name: 'handoff',
      description: '查看/刷新本会话的工作交接卡',
      input: { hint: '[refresh]' },
      async handler({ agent, rawInput }) {
        const session = agent?.session
        if (!session?.id) return { kind: 'error', text: '当前没有可用的 agent 会话。' }
        const input = String(rawInput ?? '').trim().toLowerCase()
        const refresh = input === 'refresh' || input === '重建'
        const state = await deps.refreshCard(session, { force: refresh })
        const rendered = renderMarkdown(state.card, { language: deps.config.language })
        return {
          kind: 'success',
          text: `${rendered}\n\n文件：${deps.store.markdownPathFor(session.id)}`,
        }
      },
    })
  } catch (error) {
    deps.log?.('warn', `注册 /handoff 失败：${error?.message ?? error}`)
  }
}
