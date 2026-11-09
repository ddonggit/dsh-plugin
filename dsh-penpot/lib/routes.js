import { layout } from './paths.js'
import { loadSettings, pickSettings, saveSettings } from './settings.js'
import { normalizePublicUri } from './config.js'

const LIMIT = 64 * 1024

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow: allow.join(', '), 'content-type': 'text/plain; charset=utf-8' })
  res.end('Method Not Allowed')
}

/**
 * Small host API used by the design panel and by agent tools. It never accepts
 * commands, paths, container names or other free-form input.
 */
export function registerRoutes(ctx, { stack, config, logger = console }) {
  const disposers = []
  const settingsFile = () => layout(config.dataDir).settingsFile

  const statusHandler = async (req, res) => {
    try {
      sendJson(res, 200, await stack.status())
    } catch (error) {
      logger?.error?.('[dsh-penpot] status failed', error)
      sendJson(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  const startHandler = async (req, res) => {
    if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
    try {
      const status = await stack.startInBackground()
      sendJson(res, 202, { ok: true, ...status })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  const stopHandler = async (req, res) => {
    if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
    try {
      const status = await stack.stopInBackground()
      sendJson(res, 202, { ok: true, ...status })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  const restartHandler = async (req, res) => {
    if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
    try {
      const status = await stack.restartInBackground()
      sendJson(res, 202, { ok: true, ...status })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  const logsHandler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const tail = Number(url.searchParams.get('tail') || 200)
      const text = await stack.logs(Number.isFinite(tail) ? tail : 200)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  const getSettings = async (req, res) => {
    try {
      const saved = await loadSettings(settingsFile())
      sendJson(res, 200, {
        autoStart: saved.autoStart ?? config.autoStart,
        publicUri: saved.publicUri ?? config.publicUri,
        version: config.penpotVersion,
        frontendPort: config.frontendPort,
        mcpPort: config.mcpPort,
        dataDir: config.dataDir,
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  const postSettings = async (req, res) => {
    if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
    try {
      const body = await readJson(req)
      const next = pickSettings(body)
      if (next.publicUri !== undefined) next.publicUri = normalizePublicUri(next.publicUri)
      const previous = await loadSettings(settingsFile())
      const merged = { ...previous, ...next }
      await saveSettings(settingsFile(), merged)
      const publicUriChanged =
        next.publicUri !== undefined && normalizePublicUri(next.publicUri) !== config.publicUri
      sendJson(res, 200, { ok: true, saved: merged, restartRequired: publicUriChanged })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message || error) })
    }
  }

  const add = (path, methods, handler) => {
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          if (!methods.includes(req.method)) return methodNotAllowed(res, methods)
          return handler(req, res)
        },
      }),
    )
  }

  add('/plugins/dsh-penpot/api/status', ['GET'], statusHandler)
  add('/plugins/dsh-penpot/api/start', ['POST'], startHandler)
  add('/plugins/dsh-penpot/api/stop', ['POST'], stopHandler)
  add('/plugins/dsh-penpot/api/restart', ['POST'], restartHandler)
  add('/plugins/dsh-penpot/api/logs', ['GET'], logsHandler)
  add('/plugins/dsh-penpot/api/settings', ['GET', 'POST'], (req, res) =>
    req.method === 'POST' ? postSettings(req, res) : getSettings(req, res),
  )

  return {
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already removed */
        }
      }
    },
  }
}