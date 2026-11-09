import { ensureLayout, layout } from './paths.js'
import { ensureCompose, ensureEnv, safeError } from './compose.js'
import {
  compose,
  composeLogs,
  composePs,
  dockerInfo,
  httpHealth,
  imageExists,
  portFree,
  tcpProbe,
} from './docker.js'
import { redact } from './redact.js'

const HEALTH_URL = (port) => `http://127.0.0.1:${port}/health`
const START_TIMEOUT_MS = 240_000
const PULL_TIMEOUT_MS = 900_000

function serviceName(entry) {
  return entry.Service || entry.service || entry.Name || entry.name || 'unknown'
}

function isRunning(entry) {
  return String(entry.State || entry.state || '').toLowerCase() === 'running'
}

/**
 * Owns the Docker lifecycle. All operations are serialized by `operation`;
 * reads (status) never block a start/stop, so the UI can poll during startup.
 */
export function createStack({ config, logger = console }) {
  let state = 'stopped'
  let lastError = null
  let operation = null
  let startedAt = null
  let cachedDocker = null
  let cachedDockerAt = 0
  let secrets = []

  const log = (level, ...args) => {
    const fn = logger?.[level] || logger?.log
    if (typeof fn === 'function') fn.call(logger, '[dsh-penpot]', ...args)
  }

  async function prepare() {
    const paths = await ensureLayout(config.dataDir)
    await ensureCompose(config, paths.composeFile)
    const env = await ensureEnv(config, paths.envFile)
    secrets = env.secrets
    return { paths, env }
  }

  async function dockerVersion() {
    if (Date.now() - cachedDockerAt < 5000) return cachedDocker
    try {
      cachedDocker = await dockerInfo()
    } catch (error) {
      cachedDocker = null
      throw error
    } finally {
      cachedDockerAt = Date.now()
    }
    return cachedDocker
  }

  async function imagesMissing() {
    const version = config.penpotVersion
    const images = [
      `penpotapp/frontend:${version}`,
      `penpotapp/backend:${version}`,
      `penpotapp/exporter:${version}`,
      `penpotapp/mcp:${version}`,
      `penpotapp/admin-console:${version}`,
      'postgres:15',
      'valkey/valkey:8.1',
    ]
    const missing = []
    for (const image of images) {
      if (!(await imageExists(image))) missing.push(image)
    }
    return missing
  }

  async function waitHealthy(timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      last = await httpHealth(HEALTH_URL(config.frontendPort), 2500)
      if (last.ok) return last
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    return last || { ok: false, error: 'timeout' }
  }

  async function doStart() {
    state = 'starting'
    lastError = null
    startedAt = null
    let paths
    try {
      const prepared = await prepare()
      paths = prepared.paths
      const version = await dockerVersion()
      log('info', `Docker ${version}, starting Penpot ${config.penpotVersion}`)

      const before = await composePs(layout(config.dataDir).composeFile, layout(config.dataDir).envFile)
      const alreadyRunning = before.some(isRunning)
      if (!alreadyRunning) {
        for (const [name, port] of [
          ['frontendPort', config.frontendPort],
          ['mcpPort', config.mcpPort],
        ]) {
          if (!(await portFree(port))) {
            throw new Error(`${name}=${port} 已被其他进程占用，无法启动 Penpot`)
          }
        }
      }

      const missing = await imagesMissing()
      if (missing.length > 0) {
        log('info', `pulling missing images: ${missing.join(', ')}`)
        await compose(paths.composeFile, paths.envFile, ['pull'], { timeoutMs: PULL_TIMEOUT_MS })
      }

      await compose(paths.composeFile, paths.envFile, ['up', '-d'], { timeoutMs: START_TIMEOUT_MS })
      const health = await waitHealthy()
      if (!health.ok) {
        const tail = await composeLogs(paths.composeFile, paths.envFile, 120)
        lastError = redact(`Penpot 未能就绪：${health.error || health.status || 'unknown'}\n${tail.slice(-3000)}`, secrets)
        state = 'error'
        log('error', lastError)
        return
      }
      state = 'running'
      startedAt = Date.now()
      log('info', `Penpot ready at ${config.publicUri}`)
    } catch (error) {
      state = 'error'
      lastError = safeError(error, secrets)
      log('error', lastError)
    }
  }

  async function doStop() {
    state = 'stopping'
    lastError = null
    try {
      const { paths } = await prepare()
      await compose(paths.composeFile, paths.envFile, ['stop'], { timeoutMs: 90_000 })
      state = 'stopped'
      startedAt = null
    } catch (error) {
      state = 'error'
      lastError = safeError(error, secrets)
      log('error', lastError)
    }
  }

  async function status() {
    const paths = layout(config.dataDir)
    const base = {
      installed: true,
      version: config.penpotVersion,
      publicUri: config.publicUri,
      localUrl: `http://127.0.0.1:${config.frontendPort}/`,
      mcpUrl: `http://127.0.0.1:${config.mcpPort}/mcp`,
      dataDir: config.dataDir,
    }
    let docker = null
    let services = []
    let health = { ok: false }
    let mcpListening = false
    let probeError = null

    try {
      docker = await dockerVersion()
    } catch (error) {
      probeError = safeError(error, secrets)
    }

    if (docker) {
      try {
        const ps = await composePs(paths.composeFile, paths.envFile)
        services = ps.map((entry) => ({
          name: serviceName(entry),
          state: String(entry.State || entry.state || 'unknown'),
          health: entry.Health || entry.health || null,
          status: String(entry.Status || entry.status || ''),
        }))
      } catch (error) {
        probeError = safeError(error, secrets)
      }
      health = await httpHealth(HEALTH_URL(config.frontendPort), 2000)
      mcpListening = await tcpProbe(config.mcpPort)
    }

    const running = services.filter((entry) => entry.state.toLowerCase() === 'running').length
    const anyRunning = running > 0
    let derived
    if (operation !== null) derived = state === 'stopping' ? 'stopping' : 'starting'
    else if (state === 'error') derived = 'error'
    else if (!docker) derived = 'error'
    else if (!anyRunning) derived = 'stopped'
    else if (!health.ok) derived = 'starting'
    else derived = 'running'

    return {
      ...base,
      state: derived,
      docker,
      services,
      runningCount: running,
      health,
      mcpListening,
      lastError: lastError || probeError,
      startedAt,
      uptimeMs: startedAt ? Date.now() - startedAt : 0,
      nextStep:
        derived === 'running'
          ? mcpListening
            ? `把 ${config.publicUri} 发给用户，让他在浏览器里手动登录 Penpot；agent 用 MCP（127.0.0.1:${config.mcpPort}）操作，面板不再嵌入画布。`
            : 'MCP 端口未监听，检查 penpot-mcp 容器日志。'
          : derived === 'stopped'
            ? '点击“启动 Penpot”，首次启动约 1–3 分钟。'
            : derived === 'starting'
              ? '容器启动中，稍候；不要重复点启动。'
              : '启动失败，查看日志或修复后重试。',
    }
  }

  function startInBackground() {
    if (operation !== null) return status()
    state = 'starting'
    operation = doStart().finally(() => {
      operation = null
    })
    return status()
  }

  async function startAndWait() {
    if (operation !== null) return operation.then(() => status())
    operation = doStart().finally(() => {
      operation = null
    })
    await operation
    return status()
  }

  function stopInBackground() {
    if (operation !== null) return status()
    state = 'stopping'
    operation = doStop().finally(() => {
      operation = null
    })
    return status()
  }

  async function stopAndWait() {
    if (operation !== null) {
      await operation
      return status()
    }
    operation = doStop().finally(() => {
      operation = null
    })
    await operation
    return status()
  }

  async function restartInBackground() {
    if (operation !== null) return status()
    state = 'stopping'
    operation = (async () => {
      await doStop()
      await doStart()
    })().finally(() => {
      operation = null
    })
    return status()
  }

  async function logs(tail = 200) {
    const paths = layout(config.dataDir)
    try {
      const text = await composeLogs(paths.composeFile, paths.envFile, Math.min(Math.max(tail, 20), 1000))
      return redact(text, secrets)
    } catch (error) {
      return safeError(error, secrets)
    }
  }

  async function cleanup() {
    // Sockets/containers are intentionally left running when the plugin
    // unloads: the user's designs and the stack should survive a DSH reload.
  }

  return {
    config,
    status,
    startInBackground,
    startAndWait,
    stopInBackground,
    stopAndWait,
    restartInBackground,
    logs,
    cleanup,
  }
}