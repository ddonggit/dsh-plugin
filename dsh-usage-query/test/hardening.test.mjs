// Regression tests for the hardening pass: write concurrency, damaged documents,
// body limits, degraded upstreams, and error wording.
//
// These live in their own file so the older suites (which carry shaped fake
// credentials) stay untouched.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { harness, request } from './harness.mjs'
import { AccountStore } from '../lib/store.js'
import { createRequestHandler } from '../lib/api.js'
import { fetchOpendesign } from '../lib/providers.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-usage-query-hardening-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

function seed(h, document) {
  mkdirSync(dirname(h.storePath), { recursive: true })
  writeFileSync(h.storePath, JSON.stringify({ migratedAt: new Date().toISOString(), ...document }))
}

test('a credential update that awaits upstream cannot resurrect a concurrently deleted account', async (t) => {
  // The update loads, then waits ~60ms on the upstream probe. A delete that lands
  // inside that window must still be there afterwards; writing back the section that
  // was read before the await would bring the deleted account back.
  const h = harness(t, {
    respond: async (url) => {
      if (url.host !== 'api.deepseek.com') return undefined
      await sleep(60)
      return Response.json({ is_available: true, balance_infos: [] })
    },
  })
  seed(h, {
    deepseek: {
      accounts: [
        { id: 'a', name: '旧名', apiKey: 'sk-test-aaaaaaaaaaaa' },
        { id: 'b', name: '副号', apiKey: 'sk-test-bbbbbbbbbbbb' },
      ],
      activeId: 'a',
    },
  })

  const updating = request(h, '/api/usage-query/accounts/update', 'POST', {
    provider: 'deepseek',
    id: 'a',
    name: '新名',
    credential: 'sk-test-cccccccccccc',
  })
  await sleep(10)
  const removed = await request(h, '/api/usage-query/accounts/delete', 'POST', { provider: 'deepseek', id: 'b' })
  assert.equal(removed.status, 200)

  const updated = await updating
  assert.equal(updated.status, 200)

  const saved = JSON.parse(readFileSync(h.storePath, 'utf8')).deepseek
  assert.deepEqual(saved.accounts.map((account) => account.id), ['a'])
  assert.equal(saved.accounts[0].name, '新名')
  assert.equal(saved.accounts[0].apiKey, 'sk-test-cccccccccccc')
})

test('two overlapping creates both land', async (t) => {
  const h = harness(t, {
    respond: async (url) => {
      if (url.host !== 'api.deepseek.com') return undefined
      await sleep(20)
      return Response.json({ is_available: true, balance_infos: [] })
    },
  })
  const [first, second] = await Promise.all([
    request(h, '/api/usage-query/accounts', 'POST', { provider: 'deepseek', name: '一号', credential: 'sk-test-111111111111' }),
    request(h, '/api/usage-query/accounts', 'POST', { provider: 'deepseek', name: '二号', credential: 'sk-test-222222222222' }),
  ])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  const saved = JSON.parse(readFileSync(h.storePath, 'utf8')).deepseek
  assert.equal(saved.accounts.length, 2, 'neither create may overwrite the other')
})

test('a corrupt document is backed up instead of being silently replaced', async (t) => {
  const h = harness(t)
  mkdirSync(dirname(h.storePath), { recursive: true })
  writeFileSync(h.storePath, '{ this is not json')

  const { status, data } = await request(h, '/api/usage-query/accounts')
  assert.equal(status, 200)
  assert.deepEqual(data.providers.deepseek.accounts, [])

  const backups = readdirSync(dirname(h.storePath)).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1, 'the unparsable document must be preserved')
  assert.equal(readFileSync(join(dirname(h.storePath), backups[0]), 'utf8'), '{ this is not json')
})

test('a document that parses to a non-object is treated as corrupt too', async (t) => {
  const h = harness(t)
  mkdirSync(dirname(h.storePath), { recursive: true })
  writeFileSync(h.storePath, '["not", "a", "store"]')
  const { status } = await request(h, '/api/usage-query/accounts')
  assert.equal(status, 200)
  assert.equal(readdirSync(dirname(h.storePath)).filter((name) => name.includes('.corrupt-')).length, 1)
})

test('an oversized declared body is refused before it is buffered', async (t) => {
  const home = tempHome(t)
  const store = new AccountStore({ path: join(home, 'accounts.json'), home })
  const handler = createRequestHandler({ store, log: () => {} })
  const response = await handler({
    url: 'http://dsh.local/api/usage-query/accounts',
    method: 'POST',
    headers: new Headers({ 'content-length': String(1024 * 1024) }),
    body: null,
  })
  assert.equal(response.status, 413)
  const body = await response.json()
  assert.match(body.error, /上限/)
})

test('a probe failure with no friendly wording still yields an actionable message', async (t) => {
  const home = tempHome(t)
  const store = new AccountStore({ path: join(home, 'accounts.json'), home })
  // A fetcher that resolves to nothing makes fetchJson throw a bare TypeError,
  // which friendlyUpstreamError() cannot classify.
  const handler = createRequestHandler({ store, log: () => {}, fetcher: async () => undefined })
  const response = await handler(new Request('http://dsh.local/api/usage-query/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'deepseek', credential: 'sk-test-dddddddddddd' }),
  }))
  assert.equal(response.status, 502)
  const body = await response.json()
  assert.equal(body.error.startsWith('，'), false, 'a leading separator means the reason went missing')
  assert.match(body.error, /未保存/)
})

test('a write failure is reported as storage trouble, not as an upstream failure', async (t) => {
  const home = tempHome(t)
  const blocker = join(home, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const h = harness(t, {
    home,
    config: { storePath: join(blocker, 'accounts.json') },
    respond: (url) => (url.host === 'api.deepseek.com' ? Response.json({ is_available: true, balance_infos: [] }) : undefined),
  })
  const { status, data } = await request(h, '/api/usage-query/accounts', 'POST', {
    provider: 'deepseek',
    credential: 'sk-test-eeeeeeeeeeee',
  })
  assert.equal(status, 500)
  assert.equal(data.code, 'STORE_WRITE_FAILED')
  assert.match(data.error, /权限|写入/)
})

test('store.update rejects an async updater instead of losing the write', (t) => {
  const home = tempHome(t)
  const store = new AccountStore({ path: join(home, 'accounts.json'), home })
  assert.throws(() => store.update('deepseek', async (section) => section), /同步 updater/)
})

test('an unavailable /me or wallet does not hide the billing summary', async () => {
  const fetcher = async (input) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/me')) return new Response('boom', { status: 503 })
    if (url.pathname.endsWith('/wallet/balance')) throw new TypeError('fetch failed')
    return Response.json({ planTier: 'pro', balances: { subscriptionCredits: 42 }, balanceUsd: 7 })
  }
  const result = await fetchOpendesign('ck_test_1234567890', fetcher)
  assert.equal(result.summary.planTier, 'pro')
  assert.equal(result.summary.subscriptionCredits, 42)
  assert.equal(result.summary.balanceUsd, 7)
  assert.equal(result.me.email, '')
  assert.equal(result.wallet, null)
})

test('a 401 on the billing summary is reported as a stale controlKey', async () => {
  const fetcher = async () => new Response('no', { status: 401 })
  await assert.rejects(
    () => fetchOpendesign('ck_test_1234567890', fetcher),
    (error) => error && error.message === 'OPENDESIGN_AUTH_INVALID',
  )
})
