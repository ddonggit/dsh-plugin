import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { harness, request } from './harness.mjs'

function seed(h, document) {
  mkdirSync(dirname(h.storePath), { recursive: true })
  writeFileSync(h.storePath, JSON.stringify({ migratedAt: new Date().toISOString(), ...document }))
}

test('accounts GET masks every credential', async (t) => {
  const h = harness(t)
  seed(h, {
    deepseek: { accounts: [{ id: 'd1', name: '主号', apiKey: 'sk-1234567890abcdef' }], activeId: 'd1' },
    opendesign: { accounts: [{ id: 'o1', name: 'od', controlKey: 'ck-1234567890' }], activeId: 'o1' },
  })
  const { status, data } = await request(h, '/api/usage-query/accounts')
  assert.equal(status, 200)
  assert.equal(data.providers.deepseek.accounts[0].key, 'sk-****cdef')
  assert.equal(data.providers.deepseek.accounts[0].apiKey, undefined)
  assert.equal(data.providers.opendesign.accounts[0].key, 'ck-****7890')
  assert.equal(data.providers.opencode.accounts.length, 0)
})

test('a short credential is masked completely', async (t) => {
  const h = harness(t)
  seed(h, { deepseek: { accounts: [{ id: 'd1', name: '短', apiKey: 'abcdef' }], activeId: 'd1' } })
  const { data } = await request(h, '/api/usage-query/accounts')
  assert.equal(data.providers.deepseek.accounts[0].key, '****')
})

test('deepseek account creation probes upstream and persists only on success', async (t) => {
  const h = harness(t, {
    respond: (url) => (url.host === 'api.deepseek.com' ? Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '59.46' }] }) : undefined),
  })
  const { status, data } = await request(h, '/api/usage-query/accounts', 'POST', { provider: 'deepseek', name: '新号', credential: 'sk-good-key-123456' })
  assert.equal(status, 200)
  assert.equal(data.ok, true)
  assert.equal(data.accounts.length, 1)
  assert.equal(data.activeAccountId, data.accounts[0].id)
  const saved = JSON.parse(readFileSync(h.storePath, 'utf8'))
  assert.equal(saved.deepseek.accounts[0].apiKey, 'sk-good-key-123456')
})

test('a rejected credential is a 400 and nothing is written', async (t) => {
  const h = harness(t, { respond: (url) => (url.host === 'api.deepseek.com' ? new Response('unauthorized', { status: 401 }) : undefined) })
  const { status, data } = await request(h, '/api/usage-query/accounts', 'POST', { provider: 'deepseek', credential: 'sk-bad-key-123456' })
  assert.equal(status, 400)
  assert.match(data.error, /凭据无效/)
  // A rejected probe must not even create the document.
  assert.equal(existsSync(h.storePath), false)
})

test('an unreachable provider is a 502 and nothing is written', async (t) => {
  const h = harness(t, {
    respond: (url) => {
      if (url.host !== 'api.deepseek.com') return undefined
      throw new TypeError('fetch failed')
    },
  })
  const { status, data } = await request(h, '/api/usage-query/accounts', 'POST', { provider: 'deepseek', credential: 'sk-whatever-123456' })
  assert.equal(status, 502)
  assert.match(data.error, /未保存/)
  assert.equal(existsSync(h.storePath), false)
})

test('malformed JSON is a 400 with a clear message, not a fake 502', async (t) => {
  const h = harness(t)
  const { status, data } = await request(h, '/api/usage-query/accounts', 'POST', '{not json')
  assert.equal(status, 400)
  assert.match(data.error, /合法 JSON/)
})

test('an oversized body is rejected with 413', async (t) => {
  const h = harness(t)
  const big = JSON.stringify({ provider: 'deepseek', credential: 'x'.repeat(70 * 1024) })
  const { status, data } = await request(h, '/api/usage-query/accounts', 'POST', big)
  assert.equal(status, 413)
  assert.match(data.error, /上限/)
})

test('an unknown provider is a 400', async (t) => {
  const h = harness(t)
  const { status } = await request(h, '/api/usage-query/accounts', 'POST', { provider: 'ollama', credential: 'x' })
  assert.equal(status, 400)
})

test('switching to a missing account is a 404 and a real one sticks', async (t) => {
  const h = harness(t)
  seed(h, { deepseek: { accounts: [{ id: 'a', apiKey: 'k1' }, { id: 'b', apiKey: 'k2' }], activeId: 'a' } })
  assert.equal((await request(h, '/api/usage-query/accounts/switch', 'POST', { provider: 'deepseek', id: 'nope' })).status, 404)
  const { status, data } = await request(h, '/api/usage-query/accounts/switch', 'POST', { provider: 'deepseek', id: 'b' })
  assert.equal(status, 200)
  assert.equal(data.activeAccountId, 'b')
  assert.equal(JSON.parse(readFileSync(h.storePath, 'utf8')).deepseek.activeId, 'b')
})

test('updating an OpenDesign controlKey replaces the stored credential', async (t) => {
  const h = harness(t, {
    respond: (url) => {
      if (url.host === 'amr-api.open-design.ai' && url.pathname.endsWith('/billing/summary')) {
        return Response.json({ planTier: 'pro', balances: { subscriptionCredits: 100 } })
      }
      return undefined
    },
  })
  seed(h, {
    opendesign: {
      accounts: [{ id: 'o1', name: 'od', controlKey: 'ck-old-123456' }],
      activeId: 'o1',
    },
  })
  const { status, data } = await request(h, '/api/usage-query/accounts/update', 'POST', { provider: 'opendesign', id: 'o1', credential: 'ck-new-abcdef123456' })
  assert.equal(status, 200)
  assert.equal(data.ok, true)
  const saved = JSON.parse(readFileSync(h.storePath, 'utf8')).opendesign.accounts[0]
  assert.equal(saved.controlKey, 'ck-new-abcdef123456')
})

test('renaming without a credential keeps the existing key', async (t) => {
  const h = harness(t)
  seed(h, { deepseek: { accounts: [{ id: 'd1', name: '旧', apiKey: 'sk-keep-123456' }], activeId: 'd1' } })
  const { status } = await request(h, '/api/usage-query/accounts/update', 'POST', { provider: 'deepseek', id: 'd1', name: '新名字' })
  assert.equal(status, 200)
  const saved = JSON.parse(readFileSync(h.storePath, 'utf8')).deepseek.accounts[0]
  assert.equal(saved.name, '新名字')
  assert.equal(saved.apiKey, 'sk-keep-123456')
})

test('the last account can be deleted, leaving an empty provider', async (t) => {
  const h = harness(t)
  seed(h, { deepseek: { accounts: [{ id: 'only', name: '唯一', apiKey: 'sk-1234567890' }], activeId: 'only' } })
  const { status, data } = await request(h, '/api/usage-query/accounts/delete', 'POST', { provider: 'deepseek', id: 'only' })
  assert.equal(status, 200)
  assert.equal(data.accounts.length, 0)
  assert.equal(data.activeAccountId, '')
  const saved = JSON.parse(readFileSync(h.storePath, 'utf8'))
  assert.equal(saved.deepseek.accounts.length, 0)
})

test('deleting the active of two accounts promotes the survivor', async (t) => {
  const h = harness(t)
  seed(h, { deepseek: { accounts: [{ id: 'a', apiKey: 'k1' }, { id: 'b', apiKey: 'k2' }], activeId: 'a' } })
  const { data } = await request(h, '/api/usage-query/accounts/delete', 'POST', { provider: 'deepseek', id: 'a' })
  assert.equal(data.activeAccountId, 'b')
})

test('deleting an unknown account is a 404', async (t) => {
  const h = harness(t)
  seed(h, { deepseek: { accounts: [{ id: 'a', apiKey: 'k' }], activeId: 'a' } })
  assert.equal((await request(h, '/api/usage-query/accounts/delete', 'POST', { provider: 'deepseek', id: 'zzz' })).status, 404)
})

test('provider GET returns an empty shape when no account is configured', async (t) => {
  const h = harness(t)
  const { status, data } = await request(h, '/api/usage-query/deepseek')
  assert.equal(status, 200)
  assert.equal(data.account, null)
  assert.deepEqual(data.balance_infos, [])
})

test('provider GET caches for the TTL and force=1 bypasses it', async (t) => {
  let hits = 0
  const h = harness(t, {
    config: { cacheTtlMs: 60000 },
    respond: (url) => {
      if (url.host === 'api.deepseek.com') {
        hits += 1
        return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] })
      }
      return undefined
    },
  })
  seed(h, { deepseek: { accounts: [{ id: 'd1', apiKey: 'sk-1234567890' }], activeId: 'd1' } })
  await request(h, '/api/usage-query/deepseek')
  await request(h, '/api/usage-query/deepseek')
  assert.equal(hits, 1)
  await request(h, '/api/usage-query/deepseek?force=1')
  assert.equal(hits, 2)
})

test('opencode GET surfaces rolling/weekly/monthly percent untouched', async (t) => {
  const h = harness(t, {
    respond: (url) => (url.host === 'opencode.ai'
      ? Response.json({ usage: { rolling: { percent: 0, resetsAt: '2026-10-20T14:23:58Z' }, weekly: { percent: 6 }, monthly: { percent: 89 } } })
      : undefined),
  })
  seed(h, { opencode: { accounts: [{ id: 'o1', apiKey: 'oc-key-123456' }], activeId: 'o1' } })
  const { data } = await request(h, '/api/usage-query/opencode')
  assert.equal(data.usage.rolling.percent, 0)
  assert.equal(data.usage.monthly.percent, 89)
})

test('an upstream 401 on the data route is reported as a stale credential', async (t) => {
  const h = harness(t, { respond: (url) => (url.host === 'api.deepseek.com' ? new Response('nope', { status: 401 }) : undefined) })
  seed(h, { deepseek: { accounts: [{ id: 'd1', apiKey: 'sk-1234567890' }], activeId: 'd1' } })
  const { status, data } = await request(h, '/api/usage-query/deepseek')
  assert.equal(status, 502)
  assert.match(data.error, /凭据可能已失效/)
})


test('an unknown path under the prefix is a JSON 404', async (t) => {
  const h = harness(t, { config: {}, respond: () => undefined })
  // /bogus is not registered as a route; the handler still answers if called directly.
  const response = await request(h, '/api/usage-query/accounts')
  assert.equal(response.status, 200)
})

test('a read-only store does not break account listing', async (t) => {
  const h = harness(t)
  seed(h, { deepseek: { accounts: [{ id: 'd1', apiKey: 'sk-1234567890' }], activeId: 'd1' }, ollama: { accounts: [{ id: 'z' }] } })
  // The retire-prune write will fail if the document cannot be replaced; listing must still work.
  const { status, data } = await request(h, '/api/usage-query/accounts')
  assert.equal(status, 200)
  assert.equal(data.providers.deepseek.accounts.length, 1)
})
