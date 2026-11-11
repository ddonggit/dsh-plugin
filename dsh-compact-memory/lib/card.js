/**
 * Handoff-card model: normalization, merge, redaction, bounded rendering, and
 * priority trimming. Pure functions only; persistence lives in store.js.
 * @module dsh-compact-memory/card
 */

import {
  ARRAY_SECTIONS,
  CARD_RECORD_VERSION,
  MAX_FREEFORM_CHARS,
  MAX_GOAL_CHARS,
  MAX_ITEMS_PER_SECTION,
  MAX_ITEM_CHARS,
  SECTION_KEYS,
  TRIM_ORDER,
} from './constants.js'

const LABELS = {
  zh: {
    title: '工作交接卡',
    session: '会话',
    turn: '第',
    turnSuffix: '轮',
    updated: '更新于',
    source: '来源',
    goal: '目标',
    done: '已完成',
    decisions: '关键决定（为什么）',
    constraints: '约束与偏好',
    pitfalls: '坑与失败尝试',
    files: '关键文件与目录',
    next: '下一步',
    questions: '待确认',
    freeform: '补充',
    empty: '（暂无内容）',
  },
  en: {
    title: 'Work handoff card',
    session: 'Session',
    turn: 'turn',
    turnSuffix: '',
    updated: 'updated',
    source: 'source',
    goal: 'Goal',
    done: 'Done',
    decisions: 'Key decisions (why)',
    constraints: 'Constraints and preferences',
    pitfalls: 'Pitfalls and failed attempts',
    files: 'Key files and directories',
    next: 'Next steps',
    questions: 'Open questions',
    freeform: 'Notes',
    empty: '(nothing yet)',
  },
}

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const SK_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}=*/g
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*)\s*[:=]\s*['"]?[^\s'"]{6,}/gi

/**
 * Replace obvious secret shapes before text enters the durable card.
 * Deliberately conservative: commit hashes and ordinary prose are preserved.
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return text
  return text
    .replace(PRIVATE_KEY, '[redacted-private-key]')
    .replace(SK_KEY, '[redacted-key]')
    .replace(AUTH_HEADER, '$1 [redacted]')
    .replace(ASSIGNMENT, '$1=[redacted]')
}

/**
 * Trim, collapse runs of spaces, and bound one text value.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function normalizeText(value, max = MAX_ITEM_CHARS) {
  if (value === undefined || value === null) return ''
  let text = String(value).replace(/\r\n/g, '\n').trim()
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  if (max > 0 && text.length > max) {
    text = `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
  }
  return text
}

/** One bullet is a single line; newlines inside an item become spaces. */
function bulletText(value) {
  return normalizeText(value).replace(/\s*\n\s*/g, ' ')
}

/** Accept a string, a bullet list, or an array, and return raw item strings. */
function toItems(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.flatMap((item) => toItems(item))
  const text = String(value)
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
  return lines.length > 0 ? lines : [text]
}

function dedupe(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * Normalize a model/caller patch into canonical section values.
 * Empty arrays are preserved so a caller can explicitly clear a section.
 * @param {Record<string, unknown>} [input]
 * @returns {Record<string, unknown>}
 */
export function normalizeSections(input = {}) {
  const out = {}
  for (const key of SECTION_KEYS) {
    if (!(key in input)) continue
    if (key === 'goal') {
      const text = redactSecrets(normalizeText(input.goal, MAX_GOAL_CHARS))
      if (text) out.goal = text
      else if (input.goal === '') out.goal = ''
    } else {
      const source = input[key]
      const items = []
      for (const raw of toItems(source)) {
        const text = redactSecrets(bulletText(raw))
        if (!text) continue
        items.push(text)
        if (items.length >= MAX_ITEMS_PER_SECTION) break
      }
      if (items.length > 0) out[key] = dedupe(items)
      else if (Array.isArray(source) && source.length === 0) out[key] = []
    }
  }
  if (typeof input.freeform === 'string') {
    out.freeform = redactSecrets(normalizeText(input.freeform, MAX_FREEFORM_CHARS))
  }
  return out
}

/**
 * Create a blank card with every required field present.
 * @param {string} sessionId
 * @param {number} [now]
 * @returns {object}
 */
export function emptyCard(sessionId, now = Date.now()) {
  const sections = {}
  for (const key of SECTION_KEYS) sections[key] = key === 'goal' ? '' : []
  return {
    version: CARD_RECORD_VERSION,
    sessionId: String(sessionId),
    createdAt: now,
    updatedAt: now,
    updatedTurn: null,
    updatedSeq: null,
    source: 'empty',
    sections,
    freeform: '',
    lastCompaction: null,
    injected: null,
    nudgedAtTurn: null,
    pendingNudge: null,
    requested: null,
    lastAttempt: null,
    stats: { modelWrites: 0, snapshots: 0, injections: 0, compactions: 0 },
  }
}

/** Deep clone a JSON card. */
export function cloneCard(card) {
  return structuredClone(card)
}

function ensureCardShape(card, sessionId) {
  if (!card || typeof card !== 'object') return emptyCard(sessionId)
  const base = emptyCard(sessionId, card.updatedAt ?? Date.now())
  const merged = { ...base, ...card }
  merged.sections = { ...base.sections, ...(card.sections && typeof card.sections === 'object' ? card.sections : {}) }
  for (const key of SECTION_KEYS) {
    if (key === 'goal') {
      if (typeof merged.sections[key] !== 'string') merged.sections[key] = ''
    } else if (!Array.isArray(merged.sections[key])) {
      merged.sections[key] = []
    }
  }
  merged.stats = { ...base.stats, ...(card.stats && typeof card.stats === 'object' ? card.stats : {}) }
  return merged
}

/**
 * Merge a caller patch into a card. `replace` replaces only the sections the
 * patch names; unnamed sections are preserved.
 * @param {object} card
 * @param {Record<string, unknown>} patch
 * @param {{ mode?: 'merge'|'replace', turn?: number|null, seq?: number|null, source?: string, now?: number }} [options]
 * @returns {object}
 */
export function mergeSections(
  card,
  patch,
  { mode = 'merge', turn = null, seq = null, source = 'model', now = Date.now() } = {},
) {
  const next = ensureCardShape(cloneCard(card), card?.sessionId ?? '')
  for (const key of SECTION_KEYS) {
    if (!(key in patch)) continue
    if (key === 'goal') {
      const incoming = typeof patch.goal === 'string' ? patch.goal : ''
      if (mode === 'replace' || !next.sections.goal || incoming) next.sections.goal = incoming
      continue
    }
    const incoming = Array.isArray(patch[key]) ? patch[key] : []
    if (mode === 'replace' || incoming.length === 0) {
      next.sections[key] = incoming
    } else {
      next.sections[key] = dedupe([...next.sections[key], ...incoming]).slice(0, MAX_ITEMS_PER_SECTION)
    }
  }
  if (typeof patch.freeform === 'string') next.freeform = patch.freeform
  next.updatedAt = now
  if (Number.isInteger(turn)) next.updatedTurn = turn
  if (Number.isInteger(seq)) next.updatedSeq = seq
  next.source = source
  if (source === 'model') next.stats.modelWrites += 1
  return next
}

/**
 * Fold a deterministic event snapshot into a card. Model-authored experience
 * sections win while fresh; factual sections refresh when stale.
 * @param {object} card
 * @param {{ sections?: Record<string, unknown> }} snapshot
 * @param {{ stale?: boolean, turn?: number|null, seq?: number|null, now?: number }} [options]
 * @returns {object}
 */
export function mergeSnapshot(
  card,
  snapshot,
  { stale = false, turn = null, seq = null, now = Date.now() } = {},
) {
  const next = ensureCardShape(cloneCard(card), card?.sessionId ?? '')
  const factual = new Set(['goal', 'done', 'files', 'next'])
  const incomingSections = normalizeSections(snapshot?.sections ?? {})
  for (const key of SECTION_KEYS) {
    if (!(key in incomingSections)) continue
    const incoming = incomingSections[key]
    const hasIncoming = key === 'goal' ? Boolean(incoming) : Array.isArray(incoming) && incoming.length > 0
    if (!hasIncoming) continue
    const current = next.sections[key]
    const hasCurrent = key === 'goal' ? Boolean(current) : Array.isArray(current) && current.length > 0
    if (!hasCurrent || (stale && factual.has(key))) next.sections[key] = incoming
  }
  next.updatedAt = now
  if (Number.isInteger(turn)) next.updatedTurn = turn
  if (Number.isInteger(seq)) next.updatedSeq = seq
  next.source = next.source === 'empty' ? 'snapshot' : 'merged'
  next.stats.snapshots += 1
  return next
}

/** Whether the card carries no model-visible content. */
export function isCardEmpty(card) {
  if (!card || !card.sections) return true
  if (card.sections.goal) return false
  for (const key of ARRAY_SECTIONS) {
    if (Array.isArray(card.sections[key]) && card.sections[key].length > 0) return false
  }
  return !card.freeform
}

/**
 * Staleness by turn distance, wall-clock age, or missing timestamps.
 * @param {object|null} card
 * @param {{ turn?: number|null, staleTurns?: number, now?: number, maxAgeMs?: number }} [options]
 * @returns {boolean}
 */
export function isStale(card, { turn = null, staleTurns = 2, now = Date.now(), maxAgeMs = 0 } = {}) {
  if (!card || !Number.isFinite(card.updatedAt)) return true
  if (
    Number.isInteger(turn) &&
    Number.isInteger(card.updatedTurn) &&
    turn - card.updatedTurn > staleTurns
  ) {
    return true
  }
  if (maxAgeMs > 0 && now - card.updatedAt > maxAgeMs) return true
  return false
}

function formatTime(ms, language) {
  try {
    const iso = new Date(ms).toISOString().replace('T', ' ')
    return `${iso.slice(0, 16)}Z`
  } catch {
    return language === 'en' ? 'unknown' : '未知'
  }
}

/**
 * Render a card as bounded Markdown.
 * @param {object} card
 * @param {{ language?: 'zh'|'en' }} [options]
 * @returns {string}
 */
export function renderMarkdown(card, { language = 'zh' } = {}) {
  const labels = LABELS[language] ?? LABELS.zh
  const lines = [`# ${labels.title}`]
  const meta = []
  if (card?.sessionId) meta.push(`${labels.session} ${card.sessionId}`)
  if (Number.isInteger(card?.updatedTurn)) {
    meta.push(
      language === 'en'
        ? `${labels.turn} ${card.updatedTurn}`
        : `${labels.turn}${card.updatedTurn}${labels.turnSuffix}`,
    )
  }
  if (Number.isFinite(card?.updatedAt)) meta.push(`${labels.updated} ${formatTime(card.updatedAt, language)}`)
  if (card?.source) meta.push(`${labels.source} ${card.source}`)
  if (meta.length > 0) lines.push(`> ${meta.join(' · ')}`)

  let wroteSection = false
  for (const key of SECTION_KEYS) {
    const value = card?.sections?.[key]
    if (key === 'goal') {
      if (typeof value === 'string' && value) {
        lines.push('', `## ${labels.goal}`, value)
        wroteSection = true
      }
      continue
    }
    if (Array.isArray(value) && value.length > 0) {
      lines.push('', `## ${labels[key]}`)
      for (const item of value) lines.push(`- ${item}`)
      wroteSection = true
    }
  }
  if (card?.freeform) {
    lines.push('', `## ${labels.freeform}`, card.freeform)
    wroteSection = true
  }
  if (!wroteSection) lines.push('', labels.empty)
  return lines.join('\n')
}

/**
 * Trim low-priority content until the rendered card fits `maxChars`.
 * @param {object} card
 * @param {number} maxChars
 * @param {{ language?: 'zh'|'en' }} [options]
 * @returns {{ card: object, rendered: string }}
 */
export function trimToLimit(card, maxChars, { language = 'zh' } = {}) {
  const limit = Math.max(200, Number.isFinite(maxChars) ? Math.floor(maxChars) : 6000)
  let next = ensureCardShape(cloneCard(card), card?.sessionId ?? '')
  let rendered = renderMarkdown(next, { language })
  if (rendered.length <= limit) return { card: next, rendered }

  if (next.freeform) {
    const available = limit - (rendered.length - next.freeform.length) - 8
    next.freeform = available > 40 ? `${next.freeform.slice(0, available).trimEnd()}…` : ''
    rendered = renderMarkdown(next, { language })
  }

  for (const key of TRIM_ORDER) {
    if (rendered.length <= limit) break
    if (key === 'goal') {
      let text = next.sections.goal ?? ''
      for (let attempt = 0; attempt < 4 && rendered.length > limit && text; attempt += 1) {
        const keep = Math.max(0, Math.floor(text.length * 0.7))
        text = keep > 40 ? `${text.slice(0, keep).trimEnd()}…` : ''
        next.sections.goal = text
        rendered = renderMarkdown(next, { language })
      }
      if (rendered.length > limit && next.sections.goal) {
        next.sections.goal = ''
        rendered = renderMarkdown(next, { language })
      }
      continue
    }
    const items = Array.isArray(next.sections[key]) ? [...next.sections[key]] : []
    while (items.length > 0 && rendered.length > limit) {
      items.pop()
      next.sections[key] = items
      rendered = renderMarkdown(next, { language })
    }
  }

  if (rendered.length > limit) {
    rendered = `${rendered.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
  }
  return { card: next, rendered }
}

export { LABELS }
