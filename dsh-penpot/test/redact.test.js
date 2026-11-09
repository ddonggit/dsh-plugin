import test from 'node:test'
import assert from 'node:assert/strict'

import { redact, secretsFromEnv } from '../lib/redact.js'
import { loadSettings, pickSettings, saveSettings } from '../lib/settings.js'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('redact removes known secrets and auth tokens', () => {
  const secret = 'a'.repeat(64)
  const token = 'sample-token'
  const text = redact(
    `PENPOT_SECRET_KEY=${secret}\nAuthorization: Token ${token}\nhttps://x/mcp/stream?userToken=zzz`,
    [secret],
  )
  assert.doesNotMatch(text, new RegExp(secret))
  assert.doesNotMatch(text, /sample-token/)
  assert.doesNotMatch(text, /userToken=zzz/)
})

test('secretsFromEnv extracts only the two credential lines', () => {
  const values = secretsFromEnv(
    'PENPOT_SECRET_KEY=01234567\nPENPOT_DATABASE_PASSWORD=not-a-real-secret\nPENPOT_VERSION=2',
  )
  assert.equal(values.length, 2)
  assert.equal(values[0], '01234567')
})

test('pickSettings rejects unknown types but ignores unknown keys', () => {
  assert.deepEqual(pickSettings({ autoStart: false, publicUri: 'https://x/penpot/', other: 1 }), {
    autoStart: false,
    publicUri: 'https://x/penpot/',
  })
  assert.throws(() => pickSettings({ autoStart: 'yes' }), /布尔/)
  assert.throws(() => pickSettings({ publicUri: 1 }), /字符串/)
})

test('saveSettings is private, atomic and readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-penpot-'))
  const file = join(dir, 'settings.json')
  try {
    await saveSettings(file, { autoStart: false })
    assert.deepEqual(await loadSettings(file), { autoStart: false })
    const mode = (await stat(file)).mode & 0o777
    assert.equal(mode, 0o600)
    assert.deepEqual(await loadSettings(join(dir, 'missing.json')), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})