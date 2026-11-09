import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

const MAX_OUTPUT = 64 * 1024

export function dockerBin(env = process.env) {
  return env.DSH_PENPOT_DOCKER || 'docker'
}

/** Run a command without a shell; return stdout/stderr and throw on non-zero. */
export function run(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 120_000,
    maxOutput = MAX_OUTPUT,
  } = options

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000).unref?.()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxOutput) stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxOutput) stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${command} ${args.join(' ')} 超时（${timeoutMs}ms）`))
        return
      }
      if (code !== 0) {
        const detail = (stderr || stdout).trim()
        reject(new Error(`${command} ${args.join(' ')} 失败（exit ${code}）${detail ? `：${detail}` : ''}`))
        return
      }
      resolve({ stdout, stderr, code })
    })
  })
}

export function composeArgs(composeFile, envFile, args) {
  return ['compose', '--env-file', envFile, '-f', composeFile, '-p', 'dsh-penpot', ...args]
}

export async function compose(composeFile, envFile, args, options = {}) {
  return run(dockerBin(), composeArgs(composeFile, envFile, args), options)
}

export async function dockerInfo() {
  const { stdout } = await run(dockerBin(), ['info', '--format', '{{.ServerVersion}}'], {
    timeoutMs: 15_000,
  })
  return stdout.trim()
}

export async function imageExists(image) {
  try {
    await run(dockerBin(), ['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 15_000 })
    return true
  } catch {
    return false
  }
}

export async function composePs(composeFile, envFile) {
  const { stdout } = await compose(composeFile, envFile, ['ps', '--format', 'json'], {
    timeoutMs: 20_000,
  })
  const text = stdout.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // Compose classic emits one JSON object per line.
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export async function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    const done = (free) => {
      server.removeAllListeners()
      server.close(() => resolve(free))
    }
    server.once('error', (error) => {
      done(error.code === 'EADDRINUSE' ? false : false)
    })
    server.listen(port, host, () => done(true))
  })
}

export async function tcpProbe(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export async function httpHealth(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      resolve({ ok: false, error: 'bad url' })
      return
    }
    const library = parsed.protocol === 'https:' ? https : http
    const req = library.get(
      parsed,
      { timeout: timeoutMs, headers: { 'user-agent': 'dsh-penpot-health/0.1' } },
      (res) => {
        res.resume()
        const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400
        resolve({ ok, status: res.statusCode })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', (error) => resolve({ ok: false, error: error.message }))
  })
}

export async function composeLogs(composeFile, envFile, tail = 200) {
  const { stdout, stderr } = await compose(
    composeFile,
    envFile,
    ['logs', '--no-color', '--tail', String(tail)],
    { timeoutMs: 20_000 },
  )
  return `${stdout}${stderr}`
}