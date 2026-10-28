// HTTP surface for the usage-query settings page.
//
// Every route keeps the historical path contract (/api/usage-query/*) so the
// browser half does not have to change shape. What changes is the error
// contract: client mistakes are 400/404/413, upstream trouble is 502, and the
// internal wording of a failure never leaks to the page.
//
// Credentials never travel to the browser: responses carry masked keys only.

import {
  FETCHERS,
  describeOdFailure,
  friendlyUpstreamError,
  isRejected,
  probeCredential,
  resolveOdCredential,
} from './providers.js'
import { PROVIDERS, credentialOf, describeError, genId, maskKey } from './store.js'

export const API_PREFIX = '/api/usage-query'

const MAX_BODY_BYTES = 64 * 1024

/** Errors that mean "the account document could not be persisted", not "the upstream failed". */
const STORAGE_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EISDIR', 'ENOTDIR', 'EMFILE', 'ENFILE'])

function isStorageFailure(error) {
  return !!error && typeof error === 'object' && STORAGE_ERROR_CODES.has(String(error.code || ''))
}

/** A request the caller can fix (bad body, missing account, rejected credential). */
export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function tooLarge() {
  return new ApiError(413, '请求体超过 ' + MAX_BODY_BYTES / 1024 + 'KB 上限')
}

/**
 * Read the body with a hard cap: the declared length is refused before we touch the
 * stream, and a body is abandoned as soon as it crosses the cap, so this plugin never
 * holds or parses an oversized payload. (The connection service buffers bodies for
 * `requestBody: 'buffered'` routes first; its own request-body cap is the outer limit.)
 */
async function readBodyText(request) {
  const declared = request.headers.get('content-length')
  if (declared && Number(declared) > MAX_BODY_BYTES) throw tooLarge()
  if (!request.body) return ''
  const chunks = []
  let total = 0
  const reader = request.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.byteLength
      if (total > MAX_BODY_BYTES) throw tooLarge()
      chunks.push(chunk)
    }
  } catch (error) {
    try {
      await reader.cancel()
    } catch {
      // the reader is already closed; the original error is what matters
    }
    if (error instanceof ApiError) throw error
    throw new ApiError(400, '请求体读取失败，请重试')
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(request) {
  const text = await readBodyText(request)
  if (!text || !text.trim()) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApiError(400, '请求体不是合法 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, '请求体必须是 JSON 对象')
  return parsed
}

function sendJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function accountView(provider, account) {
  return { id: account.id, name: account.name, key: maskKey(credentialOf(account)) }
}

function providerView(provider, section) {
  return {
    activeAccountId: section.activeId,
    accounts: section.accounts.map((account) => accountView(provider, account)),
  }
}

function providerOf(raw) {
  const provider = String(raw.provider || '')
  if (!PROVIDERS.includes(provider)) throw new ApiError(400, 'provider 必须是 ' + PROVIDERS.join('/') + ' 之一')
  return provider
}

function credentialOfRequest(raw) {
  return String(raw.credential || raw.apiKey || '').trim()
}

/**
 * Build the request handler shared by all registered routes.
 * @param {object} options
 * @param {import('./store.js').AccountStore} options.store
 * @param {(message: string) => void} options.log
 * @param {Function} [options.fetcher]
 * @param {number} [options.cacheTtlMs]
 */
export function createRequestHandler(options) {
  const store = options.store
  const log = options.log || (() => {})
  const fetcher = options.fetcher || globalThis.fetch
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? Math.max(0, options.cacheTtlMs) : 60_000

  const cache = new Map() // `${provider}:${accountId}` -> { data, at }
  /** Drop the cached provider snapshot for one account (credential change). */
  function forgetAccount(provider, accountId) {
    cache.delete(provider + ':' + accountId)
  }

  async function fetchCurrent(provider, account, force) {
    const key = provider + ':' + account.id
    const hit = cache.get(key)
    if (!force && hit && Date.now() - hit.at < cacheTtlMs) return hit.data
    const data = await FETCHERS[provider](account, fetcher)
    cache.set(key, { data, at: Date.now() })
    return data
  }

  /**
   * Validate a pasted credential against the upstream before persisting it.
   * Every upstream call in here is an `await`, and it must stay that way: mutation
   * happens afterwards in one `store.update()` tick, never around these awaits.
   */
  async function acceptCredential(provider, credential) {
    if (provider === 'opendesign') {
      const resolved = await resolveOdCredential(credential, fetcher)
      if (!resolved.ok) {
        const why = describeOdFailure(resolved)
        log('[dsh-usage-query] opendesign 凭据校验失败：' + why)
        throw new ApiError(400, why)
      }
      return { controlKey: resolved.controlKey }
    }
    const probe = await probeCredential(provider, credential, fetcher)
    if (!probe.ok) {
      if (probe.rejected) throw new ApiError(400, '凭据无效（' + provider + ' 返回 401/403），未保存')
      throw new ApiError(502, (probe.error || '凭据校验失败') + '，未保存')
    }
    return { apiKey: credential }
  }

  async function handleAccountsGet() {
    const current = store.load()
    const providers = {}
    for (const provider of PROVIDERS) providers[provider] = providerView(provider, current[provider])
    return sendJson({ ok: true, providers })
  }

  async function handleAccountCreate(request) {
    const raw = await readJson(request)
    const provider = providerOf(raw)
    const credential = credentialOfRequest(raw)
    if (!credential) {
      throw new ApiError(400, provider === 'opendesign' ? '请粘贴 ~/.amr/config.json 内容或 controlKey' : '请填写 API Key')
    }
    const fields = await acceptCredential(provider, credential)
    const name = String(raw.name || '').trim()
    const account = { id: genId(), name: name || '账号 ' + maskKey(fields.controlKey || fields.apiKey), ...fields }
    // Read-modify-write after every await: two overlapping creates both land.
    const section = store.update(provider, (current) => {
      current.accounts.push(account)
      if (!current.activeId || raw.activate) current.activeId = account.id
      return current
    })
    log('[dsh-usage-query] 新增 ' + provider + ' 账号 ' + account.id + '（名称 ' + account.name + '）')
    return sendJson({ ok: true, ...providerView(provider, section) })
  }

  async function handleAccountSwitch(request) {
    const raw = await readJson(request)
    const provider = providerOf(raw)
    const id = String(raw.id || '')
    const section = store.update(provider, (current) => {
      if (!current.accounts.some((account) => account.id === id)) throw new ApiError(404, '账号不存在')
      current.activeId = id
      return current
    })
    return sendJson({ ok: true, activeAccountId: section.activeId })
  }

  async function handleAccountUpdate(request) {
    const raw = await readJson(request)
    const provider = providerOf(raw)
    const id = String(raw.id || '')
    const name = String(raw.name || '').trim()
    const credential = credentialOfRequest(raw)
    if (!name && !credential) throw new ApiError(400, '没有要修改的内容：请提供名称或新凭据')
    // Reject an unknown account before calling upstream, then re-check inside the
    // write so a concurrent delete cannot resurrect it.
    const known = store.load()[provider].accounts.some((account) => account.id === id)
    if (!known) throw new ApiError(404, '账号不存在')

    const fields = credential ? await acceptCredential(provider, credential) : null
    const section = store.update(provider, (current) => {
      const account = current.accounts.find((entry) => entry.id === id)
      if (!account) throw new ApiError(404, '账号不存在')
      if (name) account.name = name
      if (fields) {
        if (provider === 'opendesign') account.controlKey = fields.controlKey
        else account.apiKey = fields.apiKey
      }
      return current
    })
    if (fields) forgetAccount(provider, id)
    log('[dsh-usage-query] 编辑 ' + provider + ' 账号 ' + id)
    return sendJson({ ok: true, ...providerView(provider, section) })
  }

  async function handleAccountDelete(request) {
    const raw = await readJson(request)
    const provider = providerOf(raw)
    const id = String(raw.id || '')
    // Deleting the last account is allowed: it is how a user clears a credential
    // they no longer trust. The provider card then returns to its empty state.
    // store.update() repairs the dangling activeId, so no promotion logic is needed.
    const section = store.update(provider, (current) => {
      if (!current.accounts.some((account) => account.id === id)) throw new ApiError(404, '账号不存在')
      current.accounts = current.accounts.filter((account) => account.id !== id)
      if (current.activeId === id) current.activeId = current.accounts[0]?.id || ''
      return current
    })
    forgetAccount(provider, id)
    log('[dsh-usage-query] 删除 ' + provider + ' 账号 ' + id + '（剩余 ' + section.accounts.length + '）')
    return sendJson({ ok: true, ...providerView(provider, section) })
  }

  async function handleProviderGet(provider, request) {
    const current = store.load()
    const section = current[provider]
    const account = section.accounts.find((entry) => entry.id === section.activeId) || null
    if (!account) return sendJson({ ok: true, account: null, usage: null, balance_infos: [], fetched_at: Date.now() })
    const force = new URL(request.url).searchParams.get('force') === '1'
    const data = await fetchCurrent(provider, account, force)
    const payload = { ok: true, account: { id: account.id, name: account.name }, fetched_at: Date.now() }
    if (provider === 'deepseek') {
      payload.is_available = !!data.is_available
      payload.balance_infos = data.balance_infos
    } else {
      payload.usage = data.usage ?? data
    }
    return sendJson(payload)
  }

  /** Map any thrown value onto the response the page can act on. */
  function failure(error) {
    if (error instanceof ApiError) return sendJson({ ok: false, error: error.message }, error.status)
    const message = String((error && error.message) || '')
    if (message === 'OPENDESIGN_AUTH_INVALID') {
      return sendJson({ ok: false, error: 'OpenDesign 登录态已失效（401/403）：请在桌面端重新 vela login，再更新凭据', code: 'OPENDESIGN_AUTH_INVALID' }, 502)
    }
    if (message === 'OPEN_DESIGN_MISSING_KEY' || /账号缺少 controlKey/.test(message)) {
      return sendJson({ ok: false, error: '账号缺少 controlKey：请编辑账号重新粘贴 ~/.amr/config.json', code: 'OPENDESIGN_NO_CONTROL_KEY' }, 502)
    }
    if (isRejected(error)) {
      return sendJson({ ok: false, error: friendlyUpstreamError(error) + '：当前账号凭据可能已失效，请在账号管理里更新', code: 'CREDENTIAL_REJECTED' }, 502)
    }
    if (isStorageFailure(error)) {
      // "查询失败" would send the user chasing the network for a permissions problem.
      log('[dsh-usage-query] 账号仓库写入失败：' + describeError(error))
      return sendJson({ ok: false, error: '账号仓库写入失败（' + error.code + '），请检查数据目录权限', code: 'STORE_WRITE_FAILED' }, 500)
    }
    log('[dsh-usage-query] 接口失败：' + describeError(error) + (error && error.body ? ' · 上游正文：' + String(error.body).slice(0, 200) : ''))
    return sendJson({ ok: false, error: friendlyUpstreamError(error) || '查询失败，请稍后重试' }, 502)
  }

  /** Route one request; the registered connection.fetch handlers all land here. */
  return async function handle(request) {
    const url = new URL(request.url)
    const path = url.pathname
    const method = (request.method || 'GET').toUpperCase()
    log('[dsh-usage-query] ' + method + ' ' + path)
    try {
      if (path === API_PREFIX + '/accounts' && method === 'GET') return await handleAccountsGet()
      if (path === API_PREFIX + '/accounts' && method === 'POST') return await handleAccountCreate(request)
      if (path === API_PREFIX + '/accounts/switch' && method === 'POST') return await handleAccountSwitch(request)
      if (path === API_PREFIX + '/accounts/update' && method === 'POST') return await handleAccountUpdate(request)
      if (path === API_PREFIX + '/accounts/delete' && method === 'POST') return await handleAccountDelete(request)
      for (const provider of PROVIDERS) {
        if (path === API_PREFIX + '/' + provider && method === 'GET') return await handleProviderGet(provider, request)
      }
      return sendJson({ ok: false, error: '未知路由 ' + method + ' ' + path }, 404)
    } catch (error) {
      return failure(error)
    }
  }
}
