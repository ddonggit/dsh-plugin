/**
 * Durable handoff-card storage under `$DSH_HOME/compact-memory`.
 * Files are owner-only, written through a temp file + rename, and corrupt JSON
 * is quarantined instead of breaking the plugin.
 * @module dsh-compact-memory/store
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { CARD_FILE, CARD_RECORD_VERSION, HISTORY_DIR, MARKDOWN_FILE } from './constants.js'
import { renderMarkdown } from './card.js'

function safeSessionId(id) {
  const raw = String(id ?? '').trim() || 'unknown'
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96)
  if (safe === raw && safe.length <= 96) return safe
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8)
  return `${safe.slice(0, 80)}-${hash}`
}

export class CardStore {
  /**
   * @param {string} root - resolved memory directory.
   * @param {{ mirrorMarkdown?: boolean, historyLimit?: number, language?: 'zh'|'en' }} [options]
   */
  constructor(root, { mirrorMarkdown = true, historyLimit = 10, language = 'zh' } = {}) {
    this.root = path.resolve(String(root))
    this.mirrorMarkdown = mirrorMarkdown
    this.historyLimit = historyLimit
    this.language = language
  }

  dirFor(sessionId) {
    return path.join(this.root, safeSessionId(sessionId))
  }

  cardPathFor(sessionId) {
    return path.join(this.dirFor(sessionId), CARD_FILE)
  }

  markdownPathFor(sessionId) {
    return path.join(this.dirFor(sessionId), MARKDOWN_FILE)
  }

  async #quarantine(file) {
    const target = `${file}.corrupt-${Date.now()}`
    await fs.rename(file, target).catch(() => {})
  }

  async #atomic(file, content, mode = 0o600) {
    const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
    try {
      await fs.writeFile(tmp, content, { mode })
      await fs.chmod(tmp, mode).catch(() => {})
      try {
        await fs.rename(tmp, file)
      } catch (error) {
        if (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'ENOTEMPTY') {
          await fs.rm(file, { force: true })
          await fs.rename(tmp, file)
        } else {
          throw error
        }
      }
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  async #history(dir, markdown) {
    if (this.historyLimit <= 0) return
    const historyDir = path.join(dir, HISTORY_DIR)
    await fs.mkdir(historyDir, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const suffix = crypto.randomBytes(2).toString('hex')
    await this.#atomic(path.join(historyDir, `card-${stamp}-${suffix}.md`), markdown)
    const entries = (await fs.readdir(historyDir)).filter((name) => name.endsWith('.md')).sort()
    const excess = entries.length - this.historyLimit
    for (let index = 0; index < excess; index += 1) {
      await fs.rm(path.join(historyDir, entries[index]), { force: true }).catch(() => {})
    }
  }

  /**
   * Read one card, or null when absent/corrupt.
   * @param {string} sessionId
   * @returns {Promise<object|null>}
   */
  async load(sessionId) {
    const file = this.cardPathFor(sessionId)
    let text
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    try {
      const card = JSON.parse(text)
      if (!card || card.version !== CARD_RECORD_VERSION || typeof card.sections !== 'object') {
        throw new Error('invalid card shape')
      }
      if (String(card.sessionId) !== String(sessionId)) throw new Error('session mismatch')
      return card
    } catch {
      await this.#quarantine(file)
      return null
    }
  }

  /**
   * Write card.json, and optionally card.md plus a bounded history copy.
   * @param {object} card
   * @returns {Promise<string>} the card file path.
   */
  async save(card) {
    const dir = this.dirFor(card.sessionId)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.chmod(dir, 0o700).catch(() => {})
    const file = path.join(dir, CARD_FILE)
    await this.#atomic(file, `${JSON.stringify(card, null, 2)}\n`)
    if (this.mirrorMarkdown) {
      const markdown = `${renderMarkdown(card, { language: this.language })}\n`
      await this.#atomic(path.join(dir, MARKDOWN_FILE), markdown)
      await this.#history(dir, markdown).catch(() => {})
    }
    return file
  }

  /**
   * Copy a parent card into a forked child that has no card yet.
   * @param {string} parentSessionId
   * @param {string} childSessionId
   * @returns {Promise<object|null>}
   */
  async inherit(parentSessionId, childSessionId) {
    const parent = await this.load(parentSessionId)
    if (!parent) return null
    const now = Date.now()
    const card = {
      ...structuredClone(parent),
      sessionId: String(childSessionId),
      createdAt: now,
      updatedAt: now,
      updatedTurn: null,
      updatedSeq: null,
      source: 'inherited',
      lastCompaction: null,
      injected: null,
      nudgedAtTurn: null,
      pendingNudge: null,
      requested: null,
      lastAttempt: null,
      stats: { modelWrites: 0, snapshots: 0, injections: 0, compactions: 0 },
    }
    await this.save(card)
    return card
  }

  /**
   * Read the human-readable mirror, when present.
   * @param {string} sessionId
   * @returns {Promise<string|null>}
   */
  async readMarkdown(sessionId) {
    try {
      return await fs.readFile(this.markdownPathFor(sessionId), 'utf8')
    } catch {
      return null
    }
  }
}

export { safeSessionId }
