import { readFile, writeFile, rename, chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const ALLOWED = new Set(['autoStart', 'publicUri'])

export async function loadSettings(file) {
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    // A corrupt settings file should not take DSH down; the caller logs it.
    throw new Error(`settings.json 读取失败：${error.message}`)
  }
}

export function pickSettings(input) {
  const out = {}
  for (const [key, value] of Object.entries(input || {})) {
    if (!ALLOWED.has(key)) continue
    if (key === 'autoStart' && typeof value !== 'boolean') throw new Error('autoStart 必须是布尔值')
    if (key === 'publicUri' && typeof value !== 'string') throw new Error('publicUri 必须是字符串')
    out[key] = value
  }
  return out
}

export async function saveSettings(file, settings) {
  await mkdir(dirname(file), { recursive: true, mode: 0o755 })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(tmp, 0o600)
  await rename(tmp, file)
  if (process.platform !== 'win32') await chmod(file, 0o600)
  return settings
}