/**
 * User-role messages injected at the next step boundary. Shapes mirror the
 * harness's own `createUserMessage` helper; the source kind is merge-extensible.
 * @module dsh-compact-memory/inject
 */

import crypto from 'node:crypto'
import { CARD_MARKER, CONTEXT_SUMMARY_MAX_CHARS, NUDGE_MARKER } from './constants.js'

/** Recursively freeze a small JSON message so the loop cannot mutate it. */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

export function boundSummary(text) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (oneLine.length <= CONTEXT_SUMMARY_MAX_CHARS) return oneLine
  return `${oneLine.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * Build one identified user message with a producer-owned source.
 * @param {{ text: string, sourceKind: string, summary?: string, form?: string }} input
 * @returns {object}
 */
export function createUserMessage({ text, sourceKind, summary, form = 'notice' }) {
  const source = sourceKind === 'user'
    ? { kind: 'user' }
    : { kind: sourceKind, form, summary: boundSummary(summary ?? text) }
  return deepFreeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source,
  })
}

/**
 * The post-compaction handoff message.
 * @param {{ rendered: string, sourceKind: string }} input
 * @returns {object}
 */
export function buildCardMessage({ rendered, sourceKind }) {
  const text = [
    CARD_MARKER,
    '上一段历史已被压缩成摘要。下面是压缩前保存的工作现场，请把它当作当前任务的连续上下文继续工作。',
    '',
    String(rendered ?? '').trim(),
    '',
    '（需要更早的原始细节：调用 worklog_read 读完整卡片；或用 session_query 检索原始会话。）',
  ].join('\n')
  return createUserMessage({ text, sourceKind, summary: 'Compaction handoff card' })
}

/**
 * A one-shot pressure reminder.
 * @param {{ pressurePercent?: number, sourceKind: string }} input
 * @returns {object}
 */
export function buildNudgeMessage({ pressurePercent, sourceKind }) {
  const pct = Number.isFinite(pressurePercent) ? `${Math.round(pressurePercent)}%` : '较高'
  const text = [
    NUDGE_MARKER,
    `上下文已用约 ${pct}。如果刚完成一个阶段，建议调用 worklog_write 更新交接卡（目标/决定/坑/下一步）；如果还在任务中间，可以继续，原生压缩仍会兜底。`,
  ].join('\n')
  return createUserMessage({ text, sourceKind, summary: `Context at ${pct}` })
}

/**
 * Whether a committed user message after `fromSeq` already carries `marker`.
 * @param {readonly object[]} events
 * @param {number} fromSeq
 * @param {string} [marker]
 * @returns {boolean}
 */
export function hasMarkerInEvents(events, fromSeq, marker = CARD_MARKER) {
  if (!Array.isArray(events)) return false
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue
    if (Number.isInteger(fromSeq) && Number.isInteger(event.seq) && event.seq <= fromSeq) continue
    const content = event.data?.content ?? event.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.includes(marker)) return true
    }
  }
  return false
}
