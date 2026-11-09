import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { redact } from './redact.js'

const TEMPLATE_URL = new URL('./compose.template.yml', import.meta.url)

export const FLAGS =
  'disable-email-verification enable-prepl-server disable-secure-session-cookies enable-mcp'

export function renderCompose(config) {
  const template = readFileSyncCached()
  return template
    .replaceAll('{{VERSION}}', config.penpotVersion)
    .replaceAll('{{FRONTEND_PORT}}', String(config.frontendPort))
    .replaceAll('{{MCP_PORT}}', String(config.mcpPort))
    .replaceAll('{{ASSET_INBOX}}', yamlPath(config.assetInbox))
}

/**
 * Docker Compose accepts forward slashes on every OS; the template wraps this
 * value in single quotes, so escape embedded single quotes as YAML requires.
 */
function yamlPath(value) {
  return String(value).replaceAll('\\', '/').replaceAll("'", "''")
}

let cachedTemplate = ''
function readFileSyncCached() {
  if (!cachedTemplate) {
    cachedTemplate = readFileSync(TEMPLATE_URL, 'utf8')
  }
  return cachedTemplate
}

export function parseEnv(text) {
  const out = {}
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    out[trimmed.slice(0, index)] = trimmed.slice(index + 1)
  }
  return out
}

export function buildEnv(config, previous = {}) {
  const secret = previous.PENPOT_SECRET_KEY || randomBytes(32).toString('hex')
  const dbPassword = previous.PENPOT_DATABASE_PASSWORD || randomBytes(24).toString('hex')
  return {
    PENPOT_VERSION: config.penpotVersion,
    PENPOT_PUBLIC_URI: config.publicUri,
    PENPOT_FLAGS: FLAGS,
    PENPOT_SECRET_KEY: secret,
    PENPOT_DATABASE_PASSWORD: dbPassword,
    PENPOT_FRONTEND_PORT: String(config.frontendPort),
    PENPOT_MCP_PORT: String(config.mcpPort),
  }
}

export function envText(env) {
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`
}

export async function ensureCompose(config, composeFile) {
  const next = renderCompose(config)
  let previous = ''
  try {
    previous = await readFile(composeFile, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const changed = previous !== next
  if (changed) {
    await writeFile(composeFile, next, { mode: 0o644 })
    if (process.platform !== 'win32') await chmod(composeFile, 0o644)
  }
  return { changed, text: next }
}

export async function ensureEnv(config, envFile) {
  let previousText = ''
  try {
    previousText = await readFile(envFile, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const previous = parseEnv(previousText)
  const next = buildEnv(config, previous)
  const nextText = envText(next)
  const changed = previousText !== nextText
  if (changed) {
    await writeFile(envFile, nextText, { mode: 0o600 })
    if (process.platform !== 'win32') await chmod(envFile, 0o600)
  }
  return { changed, env: next, secrets: [next.PENPOT_SECRET_KEY, next.PENPOT_DATABASE_PASSWORD] }
}

/** Never let a secret enter an error message shown in the UI or the model. */
export function safeError(error, secrets) {
  const message = error instanceof Error ? error.message : String(error)
  return redact(message, secrets)
}