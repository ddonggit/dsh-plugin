/**
 * Shared vocabulary for dsh-compact-memory.
 * @module dsh-compact-memory/constants
 */

export const PLUGIN_NAME = 'dsh-compact-memory'

/** Written at the top of every injected handoff card, used for idempotency scans. */
export const CARD_MARKER = '【工作交接卡·自动】'

/** Written at the top of a pressure reminder, used for idempotency scans. */
export const NUDGE_MARKER = '【上下文提醒·自动】'

export const CARD_RECORD_VERSION = 1

/** Scalar section first, then list sections. */
export const SECTION_KEYS = Object.freeze([
  'goal',
  'done',
  'decisions',
  'constraints',
  'pitfalls',
  'files',
  'next',
  'questions',
])

/** Sections stored as arrays of bullets. */
export const ARRAY_SECTIONS = Object.freeze(SECTION_KEYS.filter((key) => key !== 'goal'))

/** Lowest-value sections are trimmed first. */
export const TRIM_ORDER = Object.freeze([
  'questions',
  'files',
  'done',
  'pitfalls',
  'constraints',
  'decisions',
  'next',
  'goal',
])

export const MAX_ITEM_CHARS = 240
export const MAX_ITEMS_PER_SECTION = 8
export const MAX_GOAL_CHARS = 600
export const MAX_FREEFORM_CHARS = 1200
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/** In-memory replay window used when a full log scan is not needed. */
export const MAX_RECENT_EVENTS = 80

export const CARD_FILE = 'card.json'
export const MARKDOWN_FILE = 'card.md'
export const HISTORY_DIR = 'history'

export const DEFAULT_SOURCE_KIND = 'compact-memory'
export const COMMAND_ID = 'dsh-compact-memory/handoff'
