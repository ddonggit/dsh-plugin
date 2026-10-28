import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore, defaultStorePath, maskKey, normalizeStore, resolveHome } from '../lib/store.js'

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-usage-query-store-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

test('resolveHome prefers the dshHomePath service over the environment', () => {
  const ctx = { get: (name) => (name === 'dshHomePath' ? () => '/srv/custom-home' : undefined) }
  assert.equal(resolveHome(ctx), '/srv/custom-home')
  assert.equal(resolveHome({ get: () => undefined }), process.env.DSH_HOME || join(process.env.HOME || '', '.dsh'))
})

test('defaultStorePath keeps credentials inside the harness home', () => {
  assert.equal(defaultStorePath('/data/h'), '/data/h/usage-query/accounts.json')
})

test('maskKey never reveals the head of a short credential', () => {
  assert.equal(maskKey('sk-short'), '****')
  assert.equal(maskKey('sk-1234567890abcdef'), 'sk-****cdef')
  assert.equal(maskKey(''), '')
})

test('normalizeStore repairs a dangling activeId and drops unknown fields', () => {
  const store = normalizeStore({
    deepseek: { accounts: [{ id: 'a' }, { id: 'b', name: '副账号' }], activeId: 'gone' },
    opendesign: { accounts: [], activeId: 'x' },
    ollama: { accounts: [{ id: 'nope' }] },
  })
  assert.deepEqual(Object.keys(store).sort(), ['deepseek', 'opencode', 'opendesign'])
  assert.equal(store.deepseek.activeId, 'a')
  assert.equal(store.deepseek.accounts[1].name, '副账号')
  assert.equal(store.opendesign.activeId, '')
})

test('write is atomic, 0600, and keeps the directory private', (t) => {
  const home = tempHome(t)
  const store = new AccountStore({ path: defaultStorePath(home), home })
  store.write({ deepseek: { accounts: [{ id: 'a', apiKey: 'k' }], activeId: 'a' } })
  const path = defaultStorePath(home)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(join(home, 'usage-query')).mode & 0o777, 0o700)
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.ok(written.migratedAt)
  assert.equal(written.deepseek.accounts[0].apiKey, 'k')
  // no temp file survives a successful write
  const leftovers = readFileSync(path, 'utf8').length > 0 && statSync(path).isFile()
  assert.ok(leftovers)
})

test('load migrates a legacy document into the configured store path', (t) => {
  const home = tempHome(t)
  const legacy = join(home, 'plugins', 'usage-query', 'data')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'accounts.json'), JSON.stringify({
    deepseek: { accounts: [{ id: 'old-ds', name: '旧账号', apiKey: 'sk-legacy' }], activeId: 'old-ds' },
  }))
  const custom = join(home, 'custom', 'accounts.json')
  const store = new AccountStore({ path: custom, home })
  const loaded = store.load()
  assert.equal(loaded.deepseek.accounts.length, 1)
  const written = JSON.parse(readFileSync(custom, 'utf8'))
  assert.equal(written.deepseek.accounts[0].id, 'old-ds')
  assert.ok(written.migratedAt)
})

test('load prunes retired providers through the configured path, not a default one', (t) => {
  const home = tempHome(t)
  const custom = join(home, 'custom', 'accounts.json')
  mkdirSync(join(home, 'custom'), { recursive: true })
  writeFileSync(custom, JSON.stringify({
    ollama: { accounts: [{ id: 'x' }] },
    deepseek: { accounts: [{ id: 'keep', apiKey: 'k' }], activeId: 'keep' },
    migratedAt: '2026-01-01T00:00:00.000Z',
  }))
  const store = new AccountStore({ path: custom, home })
  store.load()
  const written = JSON.parse(readFileSync(custom, 'utf8'))
  assert.equal(written.ollama, undefined)
  assert.ok(written.prunedAt)
  assert.equal(written.deepseek.accounts[0].id, 'keep')
})

test('a store that cannot be written still returns readable state', (t) => {
  const home = tempHome(t)
  const blocker = join(home, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const logs = []
  const store = new AccountStore({ path: join(blocker, 'accounts.json'), home, log: (message) => logs.push(message) })
  const loaded = store.load()
  assert.deepEqual(loaded.deepseek.accounts, [])
  assert.throws(() => store.write({ deepseek: { accounts: [], activeId: '' } }))
})
