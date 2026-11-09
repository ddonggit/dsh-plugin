import test from 'node:test'
import assert from 'node:assert/strict'

import { buildEnv, renderCompose } from '../lib/compose.js'

const config = {
  penpotVersion: '2.18.6',
  frontendPort: 3300,
  mcpPort: 4401,
  publicUri: 'https://example.com/penpot/',
  assetInbox: '/opt/penpot/imports',
  dataDir: '/opt/penpot',
}

test('renderCompose fills every template placeholder', () => {
  const text = renderCompose(config)
  assert.match(text, /penpotapp\/frontend:2\.18\.6/)
  assert.match(text, /0\.0\.0\.0:3300:8080/)
  assert.match(text, /127\.0\.0\.1:4401:4401/)
  assert.match(text, /source: '\/opt\/penpot\/imports'/)
  assert.match(text, /target: \/imports/)
  assert.match(text, /read_only: true/)
  assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/)
})

test('renderCompose converts Windows paths for Docker Desktop', () => {
  const text = renderCompose({
    ...config,
    assetInbox: 'C:\\Users\\张三\\Penpot 素材\\imports',
  })
  assert.match(text, /source: 'C:\/Users\/张三\/Penpot 素材\/imports'/)
  assert.doesNotMatch(text, /\\Users/)
})

test('admin console is opt-in and keeps a valid /admin-console/ path', () => {
  const text = renderCompose(config)
  assert.doesNotMatch(text, /- penpot-admin-console/)
  assert.match(text, /profiles: \["admin-console"\]/)
  assert.match(text, /PENPOT_ADMIN_CONSOLE_URI: http:\/\/penpot-admin-console:3000\/admin-console\//)
})

test('buildEnv keeps existing secrets instead of generating new ones', () => {
  const previous = {
    PENPOT_SECRET_KEY: 'a'.repeat(64),
    PENPOT_DATABASE_PASSWORD: 'b'.repeat(48),
  }
  const env = buildEnv(config, previous)
  assert.equal(env.PENPOT_SECRET_KEY, previous.PENPOT_SECRET_KEY)
  assert.equal(env.PENPOT_DATABASE_PASSWORD, previous.PENPOT_DATABASE_PASSWORD)
  assert.equal(env.PENPOT_VERSION, '2.18.6')
  assert.equal(env.PENPOT_PUBLIC_URI, config.publicUri)
  assert.match(env.PENPOT_FLAGS, /enable-mcp/)
})

test('buildEnv generates strong secrets on first run', () => {
  const env = buildEnv(config)
  assert.equal(env.PENPOT_SECRET_KEY.length, 64)
  assert.equal(env.PENPOT_DATABASE_PASSWORD.length, 48)
  assert.notEqual(env.PENPOT_SECRET_KEY, env.PENPOT_DATABASE_PASSWORD)
})