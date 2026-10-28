import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CREDENTIAL_REJECTED,
  PROVIDER_UNAVAILABLE,
  UpstreamError,
  extractControlKey,
  friendlyUpstreamError,
  probeCredential,
  resolveOdCredential,
} from '../lib/providers.js'

function acceptOnly(expected) {
  const seen = []
  const fetcher = async (input, init = {}) => {
    seen.push(init.headers ? init.headers.Authorization : '')
    const token = String((init.headers && init.headers.Authorization) || '').replace(/^Bearer /, '')
    return token === expected ? Response.json({ balances: {} }) : new Response('no', { status: 401 })
  }
  fetcher.seen = seen
  return fetcher
}

test('a bare controlKey is probed against the billing API and accepted', async () => {
  const fetcher = acceptOnly('ck_abcdef1234567890')
  const result = await resolveOdCredential('ck_abcdef1234567890', fetcher)
  assert.equal(result.ok, true)
  assert.equal(result.controlKey, 'ck_abcdef1234567890')
})

test('a pasted config.json is mined for controlKey even with other keys around', async () => {
  const raw = JSON.stringify({ token: 'ck_from_config_123456', email: 'a@b.c', runtimeKey: 'rk-should-not-win' })
  assert.equal(extractControlKey(raw), 'ck_from_config_123456')
  const result = await resolveOdCredential(raw, acceptOnly('ck_from_config_123456'))
  assert.equal(result.ok, true)
  assert.equal(result.controlKey, 'ck_from_config_123456')
})

test('a config.json whose credential field was renamed still resolves', async () => {
  const raw = JSON.stringify({ email: 'a@b.c', session: { token: 'ck_renamed_field_999' } })
  const result = await resolveOdCredential(raw, acceptOnly('ck_renamed_field_999'))
  assert.equal(result.ok, true)
  assert.equal(result.controlKey, 'ck_renamed_field_999')
})

test('a runtimeKey alone is rejected as not billable', async () => {
  const result = await resolveOdCredential('rk_runtime_only_123456', acceptOnly('ck_never_matches'))
  assert.equal(result.ok, false)
  assert.equal(result.lastAuth, true)
})

test('a controlKey rejected by /me is reported as rejected, not transient', async () => {
  const fetcher = async (input) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/billing/summary')) return new Response('no', { status: 401 })
    return Response.json({})
  }
  const result = await resolveOdCredential('ck_1234567890abcdef', fetcher)
  assert.equal(result.ok, false)
  assert.equal(result.lastAuth, true, 'a 401 must be reported as a rejected credential')
})

test('a network failure while probing is transient, so the credential is not blamed', async () => {
  const fetcher = async () => {
    throw new TypeError('fetch failed')
  }
  const result = await resolveOdCredential('ck_1234567890abcdef', fetcher)
  assert.equal(result.ok, false)
  // `transient` carries a human-readable reason, so the caller can say "upstream
  // unreachable" instead of blaming the user's credential.
  assert.match(String(result.transient), /上游不可达|网络/)
  assert.equal(result.lastAuth, false)
})

test('probeCredential maps 401 to rejected and a throw to transient', async () => {
  const rejected = await probeCredential('deepseek', 'sk-1234567890', async () => new Response('no', { status: 401 }))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.rejected, true)
  const transient = await probeCredential('opencode', 'oc-1234567890', async () => {
    throw new TypeError('fetch failed')
  })
  assert.equal(transient.ok, false)
  assert.equal(transient.rejected, false)
})

test('probeCredential throws for an unknown provider instead of silently passing', async () => {
  await assert.rejects(() => probeCredential('ollama', 'x', async () => Response.json({})), /未知渠道/)
})

test('friendlyUpstreamError never leaks an upstream body', () => {
  const error = new UpstreamError('<html>secret upstream body</html>', { code: CREDENTIAL_REJECTED, status: 401 })
  const text = friendlyUpstreamError(error)
  assert.match(text, /凭据被上游拒绝/)
  assert.equal(text.includes('secret upstream body'), false)
  assert.match(friendlyUpstreamError(new UpstreamError('HTTP 429 too many')), /429/)
  assert.match(friendlyUpstreamError(new UpstreamError('HTTP 503 down')), /上游服务异常/)
})

test('friendlyUpstreamError turns unlisted statuses and unknown errors into fixed text', () => {
  const odd = new UpstreamError('上游 HTTP 418', { status: 418, code: PROVIDER_UNAVAILABLE })
  odd.body = '<html>internal upstream detail</html>'
  const text = friendlyUpstreamError(odd)
  assert.equal(text, '上游返回 HTTP 418，请稍后重试')
  assert.equal(text.includes('internal upstream detail'), false)
  assert.equal(friendlyUpstreamError(new Error('一些内部堆栈信息')), '')
  assert.match(friendlyUpstreamError(new Error('上游不可达：timeout')), /连不上上游/)
})
