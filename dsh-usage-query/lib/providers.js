// Upstream providers: DeepSeek balance, OpenCode Go windows, OpenDesign billing.
//
// Everything here runs on the host only. Browser code never sees a credential:
// the client talks to /api/usage-query/* and the host attaches the stored key.

export const API_URL = {
  deepseek: 'https://api.deepseek.com/user/balance',
  opencode: 'https://opencode.ai/zen/go/v1/usage',
}

// OpenDesign (open-design.ai): billing endpoints accept the device-login controlKey
// as a Bearer credential; a model runtimeKey is rejected by billing.
export const OD_API = 'https://amr-api.open-design.ai/api/v1'
export const OD_ORIGIN = 'https://amr-api.open-design.ai'

const FETCH_TIMEOUT_MS = 10_000

export class UpstreamError extends Error {
  constructor(message, options) {
    super(message)
    this.name = 'UpstreamError'
    this.status = options?.status
    this.code = options?.code
  }
}

/** Marker for "the credential was rejected" (401/403 at the provider). */
export const CREDENTIAL_REJECTED = 'CREDENTIAL_REJECTED'
/** Marker for "the provider could not be reached / answered unexpectedly". */
export const PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE'

export function isRejected(error) {
  if (!error) return false
  if (error.code === CREDENTIAL_REJECTED) return true
  return /HTTP 40[13]\b/.test(String(error.message || ''))
}

async function readBody(res) {
  try {
    return (await res.text()).slice(0, 200).replace(/\s+/g, ' ')
  } catch {
    return ''
  }
}

async function fetchJson(url, headers, fetcher = globalThis.fetch) {
  let res
  try {
    res = await fetcher(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (error) {
    throw new UpstreamError('上游不可达：' + describeFetchFailure(error), { code: PROVIDER_UNAVAILABLE })
  }
  if (!res.ok) {
    // 上游正文只留给宿主日志，绝不进入抛给浏览器的 message
    const body = await readBody(res)
    const status = res.status
    const rejected = status === 401 || status === 403
    const error = new UpstreamError('上游 HTTP ' + status, {
      status,
      code: rejected ? CREDENTIAL_REJECTED : PROVIDER_UNAVAILABLE,
    })
    error.body = body
    throw error
  }
  try {
    return await res.json()
  } catch {
    throw new UpstreamError('上游返回了无法解析的 JSON', { code: PROVIDER_UNAVAILABLE })
  }
}

function describeFetchFailure(error) {
  const name = String((error && error.name) || '')
  const message = String((error && error.message) || error || '')
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout/i.test(message)) return '请求超时'
  return message || name || '网络错误'
}

// ── DeepSeek ────────────────────────────────────────────────────────────────
export async function fetchDeepseek(apiKey, fetcher) {
  const data = await fetchJson(API_URL.deepseek, { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' }, fetcher)
  return {
    is_available: data?.is_available,
    balance_infos: Array.isArray(data?.balance_infos) ? data.balance_infos : [],
  }
}

// ── OpenCode Go ─────────────────────────────────────────────────────────────
export async function fetchOpencode(apiKey, fetcher) {
  const data = await fetchJson(API_URL.opencode, { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' }, fetcher)
  const usage = data?.usage ?? {}
  return { usage: { rolling: usage.rolling ?? null, weekly: usage.weekly ?? null, monthly: usage.monthly ?? null } }
}

/**
 * Validate a DeepSeek/OpenCode credential before saving it.
 * @returns {Promise<{ok: true} | {ok: false, rejected: boolean, error: string}>}
 */
export async function probeCredential(provider, credential, fetcher) {
  if (provider !== 'deepseek' && provider !== 'opencode') {
    // Returning ok here would let an unknown provider slip past validation.
    throw new Error('未知渠道：' + provider)
  }
  try {
    if (provider === 'deepseek') await fetchDeepseek(credential, fetcher)
    else await fetchOpencode(credential, fetcher)
    return { ok: true }
  } catch (error) {
    return { ok: false, rejected: isRejected(error), error: friendlyUpstreamError(error) }
  }
}

export function friendlyUpstreamError(error) {
  const message = String((error && error.message) || error || '')
  const status = error && Number.isFinite(error.status) ? error.status : 0
  if (error && error.code === CREDENTIAL_REJECTED) return '凭据被上游拒绝（401/403）'
  if (status === 401 || /HTTP 401\b/.test(message)) return '凭据无效（401）'
  if (status === 403 || /HTTP 403\b/.test(message)) return '无订阅或访问被拒（403）'
  if (status === 404 || /HTTP 404\b/.test(message)) return '接口不存在（404）'
  if (status === 429 || /HTTP 429\b/.test(message)) return '请求过于频繁（429），请稍后再试'
  if (status >= 500 || /HTTP 5\d\d\b/.test(message)) return '上游服务异常，请稍后再试'
  if (status) return '上游返回 HTTP ' + status + '，请稍后重试'
  if (/不可达|timeout|aborted|fetch failed/i.test(message)) return '连不上上游，请检查网络后重试'
  if (/无法解析的 JSON/.test(message)) return '上游返回格式异常，请稍后重试'
  // 未识别的内部错误一律不原样外传
  return ''
}

export function extractOdCandidates(raw) {
  const text = String(raw || '').trim()
  if (!text) return []
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (parsed && typeof parsed === 'object') {
    const strings = []
    const paths = []
    const walk = (o, p) => {
      if (!o || typeof o !== 'object' || strings.length > 32) return
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && v.trim()) {
          strings.push(v.trim())
          paths.push((p ? p + '.' : '') + k)
        } else if (v && typeof v === 'object') walk(v, (p ? p + '.' : '') + k)
      }
    }
    walk(parsed, '')
    const pick = (re) => strings.filter((_, i) => re.test(paths[i]))
    // controlKey is the documented billing credential; anything else found in the
    // pasted document is still probed afterwards, so a renamed field keeps working.
    const control = pick(/control[-_]?key/i)
    const vela = pick(/vela.*control|control.*vela/i)
    return [...new Set([...control, ...vela, ...strings].map((value) => value.trim()).filter(Boolean))].slice(0, 6)
  }
  // Non-JSON input is treated as one candidate and probed against the billing API;
  // a model API key will never pass billing authentication.
  return [text]
}

export function extractControlKey(raw) {
  return extractOdCandidates(raw)[0] || ''
}

/** Field paths of a pasted JSON document (names only, never values). */
export function describeOdPaths(raw) {
  let parsed = null
  try {
    parsed = JSON.parse(String(raw || ''))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const paths = []
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || paths.length > 16) return
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') walk(v, (p ? p + '.' : '') + k)
      else paths.push((p ? p + '.' : '') + k)
    }
  }
  walk(parsed, '')
  return paths.join(', ')
}

function odHeaders(controlKey) {
  return { Authorization: 'Bearer ' + controlKey, Accept: 'application/json' }
}

async function validateOdCredential(key, fetcher = globalThis.fetch) {
  try {
    await fetchJson(OD_API + '/billing/summary', odHeaders(key), fetcher)
    return { ok: true }
  } catch (error) {
    return { ok: false, rejected: isRejected(error), transient: friendlyUpstreamError(error) }
  }
}

/** Probe each candidate and return the first one billing accepts, with diagnostics. */
export async function resolveOdCredential(raw, fetcher = globalThis.fetch) {
  const candidates = extractOdCandidates(raw)
  const paths = describeOdPaths(raw)
  let lastAuth = false
  let transient = ''
  for (const key of candidates) {
    const result = await validateOdCredential(key, fetcher)
    if (result.ok) return { ok: true, controlKey: key }
    if (result.rejected) lastAuth = true
    else transient = result.transient || ''
  }
  return { ok: false, tried: candidates.length, lastAuth, transient, paths }
}

export function describeOdFailure(resolved) {
  const paths = resolved.paths ? '（字段：' + resolved.paths + '）' : ''
  if (resolved.tried === 0) {
    return '粘贴内容里没有字符串类型的凭据字段' + paths + '，请粘贴完整的 ~/.amr/config.json 或 controlKey'
  }
  if (resolved.lastAuth) {
    return '实测了 ' + resolved.tried + ' 个候选凭据，账单接口均拒绝（401/403）。' + (resolved.paths ? '粘贴内容里的字段：' + resolved.paths + '。' : '')
  }
  return '账单接口暂时不可用：' + (resolved.transient || '网络错误，请稍后重试')
}

/**
 * Map an OpenDesign failure onto the marker the API layer understands: a 401/403 on
 * any billing endpoint means the stored controlKey is stale, everything else stays.
 */
function opendesignFailure(error) {
  if (isRejected(error)) return new UpstreamError('OPENDESIGN_AUTH_INVALID', { code: CREDENTIAL_REJECTED })
  return error
}

// ── OpenDesign: summary + wallet ────────────────────────────────────────────
/**
 * @param {string} controlKey
 * @param {Function} fetcher
 */
export async function fetchOpendesign(controlKey, fetcher) {
  if (!controlKey) throw new UpstreamError('OPEN_DESIGN_MISSING_KEY', { code: CREDENTIAL_REJECTED })
  const headers = odHeaders(controlKey)

  // The three endpoints are independent: running them together keeps one slow call
  // from adding its timeout to the others, and lets /me and the wallet degrade
  // instead of hiding a balance that did load.
  const [summaryResult, meResult, walletResult] = await Promise.allSettled([
    fetchJson(OD_API + '/billing/summary', headers, fetcher),
    fetchJson(OD_API + '/me', headers, fetcher),
    fetchJson(OD_API + '/wallet/balance', headers, fetcher),
  ])

  // The summary is the billing source of truth: without it there is nothing to show.
  if (summaryResult.status === 'rejected') throw opendesignFailure(summaryResult.reason)
  if (walletResult.status === 'rejected' && isRejected(walletResult.reason)) throw opendesignFailure(walletResult.reason)

  const summary = summaryResult.value
  const me = meResult.status === 'fulfilled' ? meResult.value : null
  const wallet = walletResult.status === 'fulfilled'
    ? { balanceUsd: walletResult.value?.balanceUsd ?? null, updatedAt: walletResult.value?.updatedAt ?? null }
    : null

  const meOut = { name: me?.name || me?.displayName || me?.nickname || '', email: me?.email || '' }
  const balances = summary?.balances || {}
  const credits = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value)
    return null
  }
  const summaryOut = {
    planTier: summary?.planTier ?? summary?.plan_tier ?? null,
    membershipTier: summary?.membershipTier ?? null,
    subscriptionCredits: credits(balances.subscriptionCredits ?? summary?.subscriptionCredits),
    rechargeCredits: credits(balances.rechargeCredits ?? summary?.rechargeCredits),
    balanceUsd: summary?.balanceUsd ?? null,
    creditsPerUsd: credits(summary?.creditsPerUsd),
    todayConsumedUsd: summary?.todayConsumedUsd ?? null,
    totalConsumedUsd: summary?.totalConsumedUsd ?? null,
    usageCount: summary?.usageCount ?? null,
    subscriptionStatus: summary?.subscriptionStatus ?? null,
  }

  return { me: meOut, summary: summaryOut, wallet }
}

export const FETCHERS = {
  deepseek: (account, fetcher) => fetchDeepseek(account.apiKey, fetcher),
  opencode: (account, fetcher) => fetchOpencode(account.apiKey, fetcher),
  opendesign: (account, fetcher) => fetchOpendesign(account.controlKey || account.apiKey || '', fetcher),
}
