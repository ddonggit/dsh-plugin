import test from 'node:test'
import assert from 'node:assert/strict'

import { defaultDataDir, defaultPublicUri, normalizePublicUri, resolveConfig } from '../lib/config.js'

test('normalizePublicUri adds the trailing slash Penpot needs', () => {
  assert.equal(normalizePublicUri('https://example.com/penpot'), 'https://example.com/penpot/')
  assert.equal(normalizePublicUri('http://127.0.0.1:3300/penpot/'), 'http://127.0.0.1:3300/penpot/')
})

test('normalizePublicUri rejects non-http protocols', () => {
  assert.throws(() => normalizePublicUri('ftp://example.com/penpot/'), /http\/https/)
  assert.throws(() => normalizePublicUri('not a url'), /不是合法 URL/)
})

test('defaultPublicUri uses the host and the independent frontend port', () => {
  assert.equal(
    defaultPublicUri({ DSH_WEB_URL: 'https://api.example.com:3000/' }, 3300),
    'http://api.example.com:3300/',
  )
  assert.equal(defaultPublicUri({}, 9101), 'http://127.0.0.1:9101/')
})

test('resolveConfig validates ports and versions', () => {
  assert.throws(() => resolveConfig({ frontendPort: 80 }), /1024/)
  assert.throws(() => resolveConfig({ frontendPort: 70000 }), /65535/)
  assert.throws(() => resolveConfig({ penpotVersion: 'latest' }), /格式不正确/)
  const config = resolveConfig({ autoStart: 'false', frontendPort: '9101' }, {}, {})
  assert.equal(config.autoStart, false)
  assert.equal(config.frontendPort, 9101)
  assert.equal(config.proxyTarget, 'http://127.0.0.1:9101')
  assert.equal(config.publicUri, 'http://127.0.0.1:9101/')
})

test('stored settings override the static bundle config', () => {
  const config = resolveConfig({ autoStart: true }, { autoStart: false }, {})
  assert.equal(config.autoStart, false)
})
test('defaultDataDir is portable and supports explicit overrides', () => {
  assert.equal(defaultDataDir({ DSH_HOME: '/srv/dsh' }, 'darwin', '/home/u'), '/srv/dsh/penpot')
  assert.equal(defaultDataDir({ DSH_PENPOT_DIR: '/data/penpot' }, 'win32', 'C:\\Users\\u'), '/data/penpot')
})

test('resolveConfig accepts ~ and rejects relative data directories', () => {
  const config = resolveConfig({ dataDir: '~/penpot' }, {}, {})
  assert.ok(config.dataDir.endsWith('/penpot'))
  assert.throws(() => resolveConfig({ dataDir: 'relative/dir' }, {}, {}), /绝对路径/)
})
