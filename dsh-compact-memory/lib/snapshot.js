/**
 * Deterministic handoff snapshot built from the session log. This is the
 * low-fidelity floor that guarantees a card even when the model never calls
 * `worklog_write`.
 * @module dsh-compact-memory/snapshot
 */

import { MAX_ITEMS_PER_SECTION } from './constants.js'
import { normalizeText, redactSecrets } from './card.js'

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function eventMessage(event) {
  if (!event || typeof event !== 'object') return null
  if (event.type === 'user/message') return event.data?.message ?? event.data ?? null
  if (event.type === 'assistant/message') return event.data?.message ?? null
  if (event.type === 'tool/result') return event.data?.message ?? null
  if (event.type === 'developer/message') return event.data?.message ?? null
  return null
}

function eventText(event) {
  const message = eventMessage(event)
  if (!message || typeof message !== 'object') return ''
  return contentText(message.content)
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

function collectTexts(events, type) {
  const out = []
  for (const event of events) {
    if (event?.type !== type) continue
    const text = eventText(event)
    if (text) out.push(text)
  }
  return out
}

function lastTodos(events) {
  let last = null
  for (const event of events) {
    if (event?.type !== 'todo/write') continue
    const todos = event.data?.todos
    if (Array.isArray(todos)) last = todos
  }
  return last ?? []
}

function extractLines(texts, patterns, limit = 5) {
  const out = []
  const regexes = patterns.map((pattern) => (pattern instanceof RegExp ? pattern : new RegExp(pattern)))
  for (const text of texts) {
    for (const rawLine of String(text).split(/\n+/)) {
      const line = rawLine.replace(/^[-*#>\s]+/, '').trim()
      if (line.length < 8 || line.length > 240) continue
      if (!regexes.some((regex) => regex.test(line))) continue
      out.push(redactSecrets(normalizeText(line, 240)))
      if (out.length >= limit) return dedupe(out).slice(0, limit)
    }
  }
  return dedupe(out).slice(0, limit)
}

function toolErrors(events, limit = 3) {
  const out = []
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    const message = event.data?.message
    if (!message?.isError && !event.data?.error) continue
    const text = contentText(message?.content)
    if (!text) continue
    out.push(redactSecrets(normalizeText(text.split('\n')[0], 200)))
  }
  return dedupe(out).slice(-limit)
}

/** Tool arguments that name a file or directory directly. */
const EXPLICIT_PATH_KEYS = Object.freeze(['file_path', 'notebook_path', 'target_file', 'path'])

/** Tool arguments that carry a shell command; only path tokens are kept. */
const COMMAND_KEYS = Object.freeze(['command', 'cmd'])

/** Paths that appear in almost every command and carry no handoff value. */
const NOISE_PATHS = new Set([
  '/dev/null',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/bin/bash',
  '/bin/sh',
  '/bin/zsh',
  '/usr/bin/bash',
  '/usr/bin/sh',
  '/usr/bin/env',
])

const PATH_TOKEN =
  /^(?:~|\.{1,2})?(?:\/[A-Za-z0-9._@%+~-]+)+$|^[A-Za-z0-9._@%+-]+(?:\/[A-Za-z0-9._@%+-]+)+$/

function parseArguments(block) {
  if (typeof block?.arguments !== 'string') return null
  try {
    const args = JSON.parse(block.arguments)
    return args && typeof args === 'object' ? args : null
  } catch {
    return null
  }
}

/** Accept a value that is already a path, not a shell command. */
function explicitPath(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length < 2 || text.length > 200) return ''
  if (text === '.' || text === '..' || text === '~' || text === '/') return ''
  if (/[\r\n\0]/.test(text)) return ''
  return redactSecrets(normalizeText(text, 200))
}

/**
 * Pull one clean path token out of a shell command. Flags, globs, redirects,
 * quoted timestamps, and the command text itself are rejected.
 * @param {string} raw
 * @returns {string}
 */
function commandPath(raw) {
  let token = String(raw ?? '').trim()
  if (token.length < 3 || token.length > 200) return ''
  if (
    (token.startsWith("'") && token.endsWith("'")) ||
    (token.startsWith('"') && token.endsWith('"'))
  ) {
    token = token.slice(1, -1)
  }
  token = token.replace(/^[([{]+/, '').replace(/[)\]}.,;:]+$/, '')
  if (token.length < 3 || token.length > 200) return ''
  if (token.includes('://')) return ''
  if (!PATH_TOKEN.test(token)) return ''
  if (token.split('/').filter(Boolean).length < 2) return ''
  if (NOISE_PATHS.has(token)) return ''
  return token
}

/**
 * Extract clean path tokens from one shell command, in order.
 * @param {string} command
 * @returns {string[]}
 */
export function pathsInCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return []
  const out = []
  for (const token of command.split(/\s+/)) {
    const found = commandPath(token)
    if (found) out.push(found)
  }
  return dedupe(out)
}

function toolFiles(events, limit = 8) {
  const explicit = []
  const fromCommands = []
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || block.type !== 'tool-call') continue
      const args = parseArguments(block)
      if (!args) continue
      for (const key of EXPLICIT_PATH_KEYS) {
        const found = explicitPath(args[key])
        if (found) explicit.push(found)
      }
      for (const key of COMMAND_KEYS) {
        for (const found of pathsInCommand(args[key])) fromCommands.push(found)
      }
    }
  }
  // Explicit file arguments win; command paths fill the remaining slots.
  const head = dedupe(explicit).slice(-limit)
  const room = Math.max(0, limit - head.length)
  const tail = room > 0 ? dedupe(fromCommands).slice(-room) : []
  return dedupe([...head, ...tail]).slice(0, limit)
}

/**
 * Build the deterministic snapshot sections for one session.
 * @param {{ session?: object, events?: readonly object[], card?: object, now?: number }} input
 * @returns {{ sections: Record<string, string|string[]>, source: 'snapshot', builtAt: number }}
 */
export function buildSnapshot({ session, events, card, now = Date.now() } = {}) {
  const log = Array.isArray(events) ? events : []
  const userTexts = collectTexts(log, 'user/message')
  const assistantTexts = collectTexts(log, 'assistant/message')
  const todos = lastTodos(log)
  const completed = todos
    .filter((item) => item?.status === 'completed' && typeof item.content === 'string')
    .map((item) => normalizeText(item.content, 200))
  const pending = todos
    .filter((item) => item?.status !== 'completed' && typeof item.content === 'string')
    .map((item) => `${normalizeText(item.content, 200)}${item.status === 'in_progress' ? '（进行中）' : ''}`)

  const sections = {
    goal: '',
    done: [],
    decisions: [],
    constraints: [],
    pitfalls: [],
    files: [],
    next: [],
    questions: [],
  }

  const goalParts = []
  if (userTexts[0]) goalParts.push(normalizeText(userTexts[0], 400))
  const lastUser = userTexts[userTexts.length - 1]
  if (lastUser && lastUser !== userTexts[0]) goalParts.push(`最近要求：${normalizeText(lastUser, 240)}`)
  sections.goal = redactSecrets(normalizeText(goalParts.join('\n'), 600))

  sections.done = dedupe([
    ...completed,
    ...extractLines(assistantTexts.slice(-2), [/^(完成|已|结论)/], 2),
  ]).slice(0, MAX_ITEMS_PER_SECTION)

  sections.next = dedupe([
    ...pending,
    ...extractLines(assistantTexts.slice(-3), [/^(下一步|接下来|待办|TODO)/i], 3),
  ]).slice(0, MAX_ITEMS_PER_SECTION)

  sections.decisions = extractLines(
    assistantTexts,
    [/^(决定|选择|改为|方案|结论)[：:]/, /(决定|选择|改为|因为|所以)/],
    5,
  )

  sections.constraints = extractLines(
    userTexts,
    [/(必须|不要|只能|务必|统一|禁止|不能|要求|约定)/],
    5,
  )

  sections.pitfalls = dedupe([
    ...toolErrors(log, 3),
    ...extractLines(assistantTexts, [/(失败|报错|坑|不行|回滚|踩)/], 3),
  ]).slice(0, 5)

  sections.files = toolFiles(log, 8)

  return { sections, source: 'snapshot', builtAt: now }
}

export { contentText, eventText, lastTodos }
