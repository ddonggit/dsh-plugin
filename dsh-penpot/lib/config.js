import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LEGACY_DATA_DIR = '/opt/penpot'
const DEFAULT_VERSION = '2.18.6'

/**
 * Pick a writable per-user data directory. Existing Linux installs keep using
 * /opt/penpot, while fresh Linux/macOS/Windows installs (including DSH Desktop)
 * use the DSH home so the plugin can be installed without root and on any OS.
 */
export function defaultDataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.DSH_PENPOT_DIR) return env.DSH_PENPOT_DIR
  const preferred = path.join(env.DSH_HOME || path.join(home, '.dsh'), 'penpot')
  if (platform === 'linux' && existsSync(path.join(LEGACY_DATA_DIR, 'docker-compose.yml')) && !existsSync(preferred)) {
    return LEGACY_DATA_DIR
  }
  return preferred
}

function expandHome(value, home = os.homedir()) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return value
}

function asBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  throw new Error(`autoStart 必须是布尔值，收到 ${JSON.stringify(value)}`)
}

function asPort(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${name} 必须是 1024–65535 的整数，收到 ${JSON.stringify(value)}`)
  }
  return port
}

function asVersion(value) {
  const version = value === undefined || value === null || value === '' ? DEFAULT_VERSION : String(value)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`penpotVersion 格式不正确：${JSON.stringify(value)}`)
  }
  return version
}

/**
 * Normalize a URL and make sure it ends with "/" so Penpot treats it as a
 * directory subpath (its nginx uses a trailing-slash rewrite).
 */
export function normalizePublicUri(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new Error(`publicUri 不是合法 URL：${JSON.stringify(value)}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('publicUri 只支持 http/https')
  }
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function defaultPublicUri(env = process.env, frontendPort = 3300) {
  const base = env.DSH_WEB_URL || 'http://127.0.0.1:3001/'
  let host = '127.0.0.1'
  try {
    host = new URL(base).hostname || host
  } catch {
    /* keep the loopback fallback */
  }
  // Penpot is exposed on its own port, not under DSH's /penpot path. The
  // direct port is plain HTTP on purpose: the container runs with
  // disable-secure-session-cookies, and users open it without the DSH gate.
  return normalizePublicUri(`http://${host}:${frontendPort}/`)
}

/**
 * @param {Record<string, unknown> | undefined} raw
 * @param {Record<string, unknown>} [stored] values from settings.json
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveConfig(raw = {}, stored = {}, env = process.env) {
  const source = { ...(raw || {}), ...(stored || {}) }
  const rawDataDir = expandHome(String(source.dataDir || defaultDataDir(env)))
  if (!path.isAbsolute(rawDataDir)) throw new Error('dataDir 必须是绝对路径')
  const dataDir = path.normalize(rawDataDir)
  const assetInbox = expandHome(String(source.assetInbox || path.join(dataDir, 'imports')))
  if (!path.isAbsolute(assetInbox)) throw new Error('assetInbox 必须是绝对路径')

  const frontendPort = asPort(source.frontendPort, 3300, 'frontendPort')
  const publicUri = source.publicUri
    ? normalizePublicUri(source.publicUri)
    : defaultPublicUri(env, frontendPort)

  return Object.freeze({
    autoStart: asBoolean(source.autoStart, true),
    penpotVersion: asVersion(source.penpotVersion),
    frontendPort,
    mcpPort: asPort(source.mcpPort, 4401, 'mcpPort'),
    dataDir,
    publicUri,
    assetInbox,
    proxyTarget: `http://127.0.0.1:${frontendPort}`,
  })
}