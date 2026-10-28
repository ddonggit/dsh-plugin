// Account store: portable path resolution, one-time legacy migration, atomic persistence.
//
// Credentials live in a single JSON document under the harness home by default
// (`<DSH_HOME>/usage-query/accounts.json`, mode 0600, directory 0700). Writes go
// through a temp file + rename so a crash mid-write cannot truncate the file.
// Mutations go through `update()`, whose read-modify-write has no `await` in the
// critical section: two overlapping requests therefore cannot drop each other's
// accounts. A document that does not parse is quarantined, never overwritten.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const PROVIDERS = ['deepseek', 'opencode', 'opendesign']

const DROPPED_PROVIDERS = ['ollama', 'openrouter']

/** Resolve the harness home without assuming a writable env or a fixed user path. */
export function resolveHome(ctx) {
  try {
    const fromService = ctx?.get?.('dshHomePath')
    if (typeof fromService === 'function') {
      const value = fromService()
      if (typeof value === 'string' && value.trim()) return value
    }
    if (typeof fromService === 'string' && fromService.trim()) return fromService
  } catch {
    // fall through to the environment/default chain
  }
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** Default account document location for a harness home. */
export function defaultStorePath(home) {
  return join(home, 'usage-query', 'accounts.json')
}

/**
 * Legacy account documents imported once when the new store is missing.
 * Paths are derived from the harness home/user config so the bundle stays portable;
 * missing files are simply skipped.
 */
export function legacyStorePaths(home) {
  return [
    join(home, 'plugins', 'usage-query', 'data', 'accounts.json'),
    join(home, 'plugins', 'deepseek-balance', 'data', 'accounts.json'),
    join(homedir(), '.config', 'opencode', 'opencode-usage-config.json'),
  ]
}

export function genId() {
  return randomBytes(4).toString('hex')
}

export function maskKey(key) {
  const value = String(key || '')
  if (!value) return ''
  if (value.length <= 8) return '****'
  return value.slice(0, 3) + '****' + value.slice(-4)
}

export function credentialOf(account) {
  return (account && (account.controlKey || account.apiKey)) || ''
}

/**
 * Read the document and report *why* it is absent: an unparseable file must never
 * be mistaken for an empty one, or the next write would silently destroy it.
 * @returns {{status: 'ok', document: object} | {status: 'missing'} | {status: 'unreadable', error: any} | {status: 'corrupt', reason: string}}
 */
function readDocument(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { status: error && error.code === 'ENOENT' ? 'missing' : 'unreadable', error }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { status: 'corrupt', reason: '不是合法 JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'corrupt', reason: '顶层不是 JSON 对象' }
  }
  return { status: 'ok', document: parsed }
}

/** Move an unparseable document aside so a later write cannot destroy the only copy. */
function quarantineDocument(path, read, log) {
  const backup = path + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')
  try {
    renameSync(path, backup)
    log('账号文档无法解析（' + read.reason + '），已备份为 ' + backup + '，本次以空态启动')
  } catch (error) {
    log('账号文档无法解析（' + read.reason + '），备份失败：' + describeError(error) + '；本次以空态启动')
  }
}

function normalizeAccounts(value) {
  return Array.isArray(value)
    ? value
        .filter((account) => account && typeof account === 'object' && typeof account.id === 'string' && account.id)
        .map((account) => ({
          ...account,
          name: typeof account.name === 'string' && account.name.trim() ? account.name.trim() : '默认',
        }))
    : []
}

/** Project a raw document onto the three supported providers, fixing dangling activeId. */
export function normalizeStore(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const provider of PROVIDERS) {
    const section = source[provider] && typeof source[provider] === 'object' ? source[provider] : {}
    const accounts = normalizeAccounts(section.accounts)
    const activeId = accounts.some((account) => account.id === section.activeId)
      ? section.activeId
      : accounts[0]?.id || ''
    out[provider] = { accounts, activeId }
  }
  return out
}

function seedFromLegacy(home) {
  const out = normalizeStore({})
  for (const path of legacyStorePaths(home)) {
    const read = readDocument(path)
    // Legacy locations are best-effort imports: an unreadable or damaged one is skipped,
    // never quarantined (it is not the live document).
    if (read.status !== 'ok') continue
    const raw = read.document
    for (const provider of PROVIDERS) {
      const section = raw[provider]
      if (!section || !Array.isArray(section.accounts) || out[provider].accounts.length) continue
      out[provider].accounts = normalizeAccounts(section.accounts)
      const active = section.activeId || section.activeAccountId
      const activeId = out[provider].accounts.some((account) => account.id === active) ? active : out[provider].accounts[0]?.id || ''
      out[provider].activeId = activeId
    }
  }
  return out
}

function atomicWrite(storePath, document) {
  const directory = dirname(storePath)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    chmodSync(directory, 0o700)
  } catch {
    // best effort: a pre-existing directory may belong to another owner
  }
  const temp = storePath + '.tmp-' + process.pid + '-' + randomBytes(3).toString('hex')
  try {
    writeFileSync(temp, JSON.stringify(document, null, 2), { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, storePath)
    chmodSync(storePath, 0o600)
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      // ignore cleanup failure; the original error is what matters
    }
    throw error
  }
}

export class AccountStore {
  /**
   * @param {object} options
   * @param {string} options.path - account document path
   * @param {string} [options.home] - harness home used for one-time legacy discovery
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.path = options.path
    this.home = options.home
    this.log = options.log || (() => {})
  }

  /** Read and normalize; a damaged document is quarantined, a missing one seeds from legacy. */
  load() {
    const read = readDocument(this.path)
    if (read.status === 'ok') {
      const raw = read.document
      const normalized = normalizeStore(raw)
      const dropped = DROPPED_PROVIDERS.filter((provider) => raw[provider] !== undefined)
      if (dropped.length) {
        const next = { ...raw, ...normalized, prunedAt: new Date().toISOString() }
        for (const provider of dropped) delete next[provider]
        try {
          this.write(next, true)
        } catch (error) {
          this.log('无法清理已下线渠道 ' + dropped.join(', ') + '：' + describeError(error))
        }
      }
      return normalized
    }

    // A damaged document is moved aside instead of being treated as "no document":
    // otherwise the next write would replace the user's only copy with an empty one.
    if (read.status === 'corrupt') quarantineDocument(this.path, read, this.log)
    else if (read.status === 'unreadable') this.log('账号文档不可读（' + describeError(read.error) + '），本次以空态启动')

    const seeded = seedFromLegacy(this.home)
    const any = PROVIDERS.some((provider) => seeded[provider].accounts.length > 0)
    if (any) {
      const document = { ...seeded, migratedAt: new Date().toISOString() }
      try {
        this.write(document, true)
        this.log('已从未知 legacy 位置导入账号（' + PROVIDERS.map((p) => p + '=' + seeded[p].accounts.length).join(' ') + '）')
      } catch (error) {
        this.log('导入旧账号失败，继续以只读内存态运行：' + describeError(error))
      }
    }
    return seeded
  }

  /**
   * Mutate one provider section through a single synchronous read-modify-write.
   *
   * The updater must be synchronous, and every `await` in a caller has to happen
   * before this call: Node then runs load → mutate → write to completion without
   * yielding, so two overlapping requests cannot drop each other's accounts.
   * Throwing inside the updater aborts the write and propagates to the caller.
   * @param {string} provider
   * @param {(section: {accounts: object[], activeId: string}) => {accounts: object[], activeId: string}} updater
   * @returns {object} the persisted section (with a repaired activeId)
   */
  update(provider, updater) {
    const current = this.load()
    const section = current[provider]
    const next = updater({ accounts: section.accounts.slice(), activeId: section.activeId })
    if (next && typeof next.then === 'function') throw new TypeError('AccountStore.update 需要同步 updater')
    // normalizeStore re-derives a dangling activeId, so a caller cannot leave one behind.
    const normalized = normalizeStore({ ...current, [provider]: next || section })[provider]
    this.write({ [provider]: normalized })
    return normalized
  }

  /** Merge (default) or replace the document; writes atomically. */
  write(store, exact = false) {
    let base = {}
    if (!exact) {
      const read = readDocument(this.path)
      if (read.status === 'ok') base = read.document
      else if (read.status === 'corrupt') quarantineDocument(this.path, read, this.log)
    }
    const document = exact
      ? { ...store }
      : { ...base, ...store, migratedAt: base.migratedAt || store.migratedAt || new Date().toISOString() }
    atomicWrite(this.path, document)
  }
}

export function describeError(error) {
  const code = error && typeof error === 'object' ? error.code || '' : ''
  const message = String((error && error.message) || error || '未知错误')
  return code ? message + ' (' + code + ')' : message
}
