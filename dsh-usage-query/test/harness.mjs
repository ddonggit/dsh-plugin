// Shared harness: a fake ctx that records registered routes and a scripted fetcher.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/**
 * @param {object} t - node:test context (for cleanup)
 * @param {object} [options]
 * @param {(url: URL, init: object) => Response | Promise<Response> | undefined} [options.respond]
 * @param {object} [options.config] - extra plugin config
 * @param {string} [options.home] - harness home exposed through dshHomePath
 */
export function harness(t, options = {}) {
  const home = options.home || mkdtempSync(join(tmpdir(), 'dsh-usage-query-'))
  const routes = new Map()
  const logs = []
  const calls = []
  const disposers = []

  const respond = options.respond || (() => Response.json({}))

  async function fetcher(input, init = {}) {
    const url = new URL(input)
    calls.push({ url, init })
    const custom = await respond(url, init)
    if (custom) return custom
    return Response.json({})
  }

  const ctx = {
    get(name) {
      if (name === 'dshHomePath') return () => home
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              routes.set(route.path, route.fetch)
              return () => routes.delete(route.path)
            },
          },
        }
      }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    logger: {
      info: (message) => logs.push(String(message)),
      warn: (message) => logs.push(String(message)),
      error: (message) => logs.push(String(message)),
    },
  }

  const config = Object.assign({ storePath: join(home, 'usage-query', 'accounts.json'), fetch: fetcher }, options.config || {})
  apply(ctx, config)

  t.after(() => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // dispose must be best-effort
      }
    }
    rmSync(home, { recursive: true, force: true })
  })

  return { home, routes, logs, calls, config, storePath: config.storePath }
}

export async function request(h, path, method = 'GET', body) {
  const url = new URL(path, 'http://dsh.local')
  const route = h.routes.get(url.pathname)
  assert.ok(route, 'registered route: ' + url.pathname)
  const init = { method, headers: {} }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const response = await route(new Request('http://dsh.local' + path, init))
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: response.status, headers: response.headers, data }
}
