// dsh-usage-query — host half.
//
// A portable DSH bundle: no absolute paths, no hand-edited profile entries. The
// account document lives under the harness home (or `config.storePath`), and the
// the /api/usage-query/* routes are registered into the official connection.fetch
// table so the same host/origin fence and browser-session check as /api/* applies.
//
// Upgrade points: API endpoints in lib/providers.js, copy in lib/client.js.

import { AccountStore, PROVIDERS, defaultStorePath, describeError, resolveHome } from './store.js'
import { API_PREFIX, createRequestHandler } from './api.js'

export const name = 'dsh-usage-query'

// The /api carrier (including its auth fence) belongs to the connection service;
// wait for it before registering the precise routes.
export const inject = ['connection']

export const ROUTES = [
  { path: API_PREFIX + '/accounts', methods: ['GET', 'POST'] },
  { path: API_PREFIX + '/accounts/switch', methods: ['POST'] },
  { path: API_PREFIX + '/accounts/update', methods: ['POST'] },
  { path: API_PREFIX + '/accounts/delete', methods: ['POST'] },
  { path: API_PREFIX + '/deepseek', methods: ['GET'] },
  { path: API_PREFIX + '/opencode', methods: ['GET'] },
  { path: API_PREFIX + '/opendesign', methods: ['GET'] },
]

function makeLogger(ctx) {
  const logger = ctx.logger
  if (logger && typeof logger.info === 'function') {
    return {
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
      error: (message) => logger.error(message),
    }
  }
  return {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
  }
}

function positiveNumber(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export function apply(ctx, config = {}) {
  const connection = ctx.get('connection')
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    ctx.logger?.warn?.('[dsh-usage-query] 缺少 connection.fetch 服务，插件未启动')
    return
  }

  const logger = makeLogger(ctx)
  const home = resolveHome(ctx)
  const storePath = config.storePath || process.env.DSH_USAGE_QUERY_STORE_PATH || defaultStorePath(home)
  const store = new AccountStore({ path: storePath, home, log: logger.warn })
  const cacheTtlMs = positiveNumber(config.cacheTtlMs)
  const fetcher = typeof config.fetch === 'function' ? config.fetch : undefined

  // Surface the migration once at boot rather than on the first browser request.
  try {
    const current = store.load()
    logger.info(
      '[dsh-usage-query] 账号仓库 ' + storePath + '（' +
        PROVIDERS.map((provider) => provider + '=' + current[provider].accounts.length).join(' ') + '）',
    )
  } catch (error) {
    logger.error('[dsh-usage-query] 账号仓库读取失败（将以空态启动）：' + describeError(error))
  }

  const handle = createRequestHandler({ store, log: logger.info, fetcher, cacheTtlMs })

  for (const route of ROUTES) {
    ctx.effect(
      () => connection.fetch.register({ path: route.path, methods: route.methods, requestBody: 'buffered', fetch: handle }),
      'dsh-usage-query: ' + route.path,
    )
  }

  logger.info('[dsh-usage-query] 已启动，' + ROUTES.length + ' 条 ' + API_PREFIX + '/* 精确路由')
}
