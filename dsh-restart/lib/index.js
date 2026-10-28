// Host half: 重启接口 + 状态查询。刻意做薄——真正的重启流程在 lib/restart-runner.mjs 里，
// 因为本进程会在重启时被杀掉。
//
// 写权分工：
//   · run.json 由执行器推进；宿主只在执行器心跳消失后补写终态（见 store.recover）
//   · boot.json 只由本进程在 apply 时写，作为"新实例已加载插件"的握手标记
//   · 触发时宿主先写 queued，再拉起执行器；执行器接管后宿主不再写阶段
//
// 可移植性（重要）：
//   · 不假设服务一定叫 dsh-web：默认从当前进程的 cgroup 里识别真实单元名
//   · 不假设一定有 systemd：识别不到单元就退化为"直接重启"（停止旧进程 + 用原 argv 拉起）
//   · 不假设监听在 127.0.0.1/HTTP：探测用绑定地址 + 端口，兼容 HTTPS 与具体网卡
//   · 以上都能用配置或环境变量覆盖，见 README
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { errorOf, isActive, isTerminal, newRun, sanitizeRun } from './state.mjs'
import { createStore, STALE_HEARTBEAT_MS } from './store.mjs'
import { pidAlive, which } from './proc.mjs'
import {
  decideMode,
  firstNonEmpty,
  hostForUrl,
  managerArgs,
  normalizeHost,
  normalizeManager,
  normalizeMode,
  parseCgroupUnit,
  readCgroupText,
  resolveProbeUrl,
} from './environment.mjs'

export const name = 'dsh-restart'
export const inject = ['connection']

const RUNNER = fileURLToPath(new URL('./restart-runner.mjs', import.meta.url))
const COOLDOWN_MS = 3000
const RUNNER_LAUNCH_TIMEOUT_MS = 8000
const MAX_ATTEMPTS = 3

function getService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function resolveHome(ctx) {
  try {
    const service = ctx.get('dshHomePath')
    if (typeof service === 'function') {
      const value = service()
      if (value) return value
    }
  } catch {}
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function resolvePort(ctx) {
  const server = getService(ctx, 'webServer')
  if (server && Number(server.port) > 0) return Number(server.port)
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') {
      const value = Number(argv[i + 1])
      if (value > 0) return value
    }
    const m = /^--port=(\d+)$/.exec(argv[i] || '')
    if (m) return Number(m[1])
  }
  return Number(process.env.DSH_RESTART_PORT) || 3081
}

function selfCommand() {
  return [process.execPath].concat(process.argv.slice(1))
}

function resolveStartCommand(config) {
  const custom = config && config.startCommand
  if (Array.isArray(custom) && custom.length) return custom.map(String)
  const raw = String(process.env.DSH_RESTART_START_CMD || '').trim()
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) return parsed.map(String)
    } catch {}
  }
  return selfCommand()
}

function readDshVersion() {
  const candidates = []
  try {
    candidates.push(fs.realpathSync(process.argv[1] || ''))
  } catch {
    candidates.push(process.argv[1] || '')
  }
  for (const file of candidates) {
    let dir = path.dirname(file)
    for (let i = 0; i < 5 && dir && dir !== '/'; i++) {
      const pkg = path.join(dir, 'package.json')
      try {
        const data = JSON.parse(fs.readFileSync(pkg, 'utf8'))
        if (data && data.name && data.version && /dsh/.test(data.name)) return String(data.version)
      } catch {}
      dir = path.dirname(dir)
    }
  }
  return 'unknown'
}

// 收集一次运行环境；所有"这台机器是什么形态"的判断都集中在这里。
function collectRuntime(ctx, config) {
  const cfg = config || {}
  const home = resolveHome(ctx)
  const dataDir = process.env.DSH_RESTART_DATA_DIR || path.join(home, 'dsh-restart', 'data')
  const port = resolvePort(ctx)
  const cwd = process.cwd()

  const server = getService(ctx, 'webServer')
  const host = normalizeHost(server && server.host)
  let origin = ''
  if (server && typeof server.getOrigin === 'function') {
    try {
      origin = String(server.getOrigin() || '')
    } catch {}
  }
  if (!origin && server && typeof server.protocol === 'string' && port > 0) {
    // 监听尚未 bind 时 getOrigin() 会抛错；配置里的 protocol/host 仍然可信。
    origin = server.protocol + '//' + hostForUrl(host) + ':' + port
  }
  const app = getService(ctx, 'webApp')
  let advertised = ''
  if (app && typeof app.getAdvertisedUrl === 'function') {
    try {
      advertised = String(app.getAdvertisedUrl() || '')
    } catch {}
  }
  const healthOverride = firstNonEmpty(cfg.healthUrl, process.env.DSH_RESTART_HEALTH_URL)
  const healthUrl = healthOverride || resolveProbeUrl({ origin, advertised, host, port })

  const detected = parseCgroupUnit(readCgroupText())
  const configuredUnit = firstNonEmpty(cfg.unit, process.env.DSH_RESTART_UNIT)
  const unit = configuredUnit || detected.unit
  const unitSource = configuredUnit ? 'config' : detected.unit ? 'cgroup' : ''
  const manager =
    normalizeManager(firstNonEmpty(cfg.manager, process.env.DSH_RESTART_MANAGER)) || detected.manager || 'system'
  const requestedMode = normalizeMode(firstNonEmpty(cfg.mode, process.env.DSH_RESTART_MODE, 'auto'))
  const systemctl = which(firstNonEmpty(cfg.systemctl, process.env.DSH_RESTART_SYSTEMCTL, 'systemctl'))
  const systemdRun = which(firstNonEmpty(cfg.systemdRun, process.env.DSH_RESTART_SYSTEMD_RUN, 'systemd-run'))
  const hasSystemctl = !!systemctl
  const decided = decideMode({ requested: requestedMode, unit, unitSource, hasSystemctl })
  const mode = decided.mode
  const startCmd = resolveStartCommand(cfg)
  // 只要 systemd 真的在跑，就把执行器放进独立 scope：
  // 即使当前是「直接重启」，执行器也不该跟着旧进程所在的 cgroup 一起被回收。
  const systemdBooted = fs.existsSync('/run/systemd/system')
  const scope = !!systemdRun && hasSystemctl && (mode === 'systemd' || !!unit || systemdBooted)

  return {
    home,
    dataDir,
    port,
    cwd,
    host,
    origin,
    advertised,
    healthUrl,
    detectedUnit: detected.unit,
    detectedManager: detected.manager,
    unit,
    unitSource,
    manager,
    systemctl,
    systemdRun,
    hasSystemctl,
    requestedMode,
    mode,
    modeReason: decided.reason,
    startCmd,
    scope,
    systemdBooted,
  }
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'x-dsh-restart': '1',
    },
  })
}

function failResponse(code, extraDetail, status) {
  const base = errorOf(code, undefined, extraDetail || '')
  return jsonResponse(
    { ok: false, code: base.code, message: base.message, hint: base.hint, detail: base.detail },
    status || 400,
  )
}

function systemctlQuery(runtime, property) {
  try {
    const value = execFileSync(
      runtime.systemctl,
      managerArgs(runtime.manager).concat(['show', '-p', property, '--value', runtime.unit]),
      { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    return { value, error: '' }
  } catch (e) {
    const stderr = String((e && e.stderr) || '').trim()
    return { value: '', error: stderr || String((e && e.message) || e) }
  }
}

function preflight(runtime) {
  if (runtime.mode === 'systemd') {
    if (!runtime.hasSystemctl) return { code: 'NO_SYSTEMCTL', status: 500, detail: '找不到 systemctl：' + runtime.systemctl }
    if (!runtime.unit) return { code: 'UNIT_NOT_FOUND', status: 400, detail: '未识别到 systemd 单元' }
    if (!runtime.systemdRun) {
      return {
        code: 'NOT_ISOLATED',
        status: 500,
        detail: 'systemd 模式需要 systemd-run 把执行器搬出 ' + runtime.unit + ' 的 cgroup',
      }
    }
    const load = systemctlQuery(runtime, 'LoadState')
    if (load.error) {
      return { code: 'UNIT_NOT_FOUND', status: 400, detail: 'unit=' + runtime.unit + ' ' + load.error }
    }
    if (load.value !== 'loaded') {
      return { code: 'UNIT_NOT_FOUND', status: 400, detail: 'unit=' + runtime.unit + ' LoadState=' + load.value }
    }
  } else {
    if (!runtime.startCmd.length) {
      return { code: 'NO_START_COMMAND', status: 500, detail: '没有可用的启动命令' }
    }
    if (runtime.unit && runtime.hasSystemctl && !runtime.systemdRun) {
      return {
        code: 'NOT_ISOLATED',
        status: 500,
        detail: '直接重启运行在 ' + runtime.unit + ' 里，需要 systemd-run 把执行器搬出 cgroup',
      }
    }
  }
  if (!fs.existsSync(RUNNER)) return { code: 'RUNNER_MISSING', status: 500, detail: '缺少执行器文件：' + RUNNER }
  return null
}

function runnerArguments(runtime, runId) {
  const args = [
    '--run-id',
    runId,
    '--data-dir',
    runtime.dataDir,
    '--mode',
    runtime.mode,
    '--manager',
    runtime.manager,
    '--port',
    String(runtime.port),
    '--host',
    runtime.host,
    '--cwd',
    runtime.cwd,
    '--max-attempts',
    String(MAX_ATTEMPTS),
    '--fallback',
    runtime.mode === 'systemd' ? '1' : '0',
    '--start-cmd',
    JSON.stringify(runtime.startCmd),
  ]
  if (runtime.unit) args.push('--unit', runtime.unit)
  if (runtime.healthUrl) args.push('--health-url', runtime.healthUrl)
  if (runtime.systemctl) args.push('--systemctl', runtime.systemctl)
  if (runtime.systemdRun) args.push('--systemd-run', runtime.systemdRun)
  return args
}

function launchPlan(runtime, runId) {
  const scopeUnit = 'dsh-restart-' + runId
  if (runtime.scope) {
    const args = managerArgs(runtime.manager).concat([
      '--collect',
      '--quiet',
      '--scope',
      '--unit=' + scopeUnit,
      '--working-directory=' + runtime.cwd,
      process.execPath,
      RUNNER,
    ])
    return {
      scope: true,
      command: runtime.systemdRun,
      args: args.concat(runnerArguments(runtime, runId)),
      scopeUnit,
    }
  }
  return {
    scope: false,
    command: process.execPath,
    args: [RUNNER].concat(runnerArguments(runtime, runId)),
    scopeUnit,
  }
}

export function apply(ctx, config) {
  const connection = ctx.get('connection')
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    ctx.logger?.warn?.('[dsh-restart] 缺少 connection.fetch 服务，插件未启动')
    return
  }

  const runtime = collectRuntime(ctx, config)
  const { home, dataDir, unit, port } = runtime
  const startedAtMs = Date.now() - Math.round(process.uptime() * 1000)
  const startedAt = new Date(startedAtMs).toISOString()
  const store = createStore(dataDir, { bootedAt: startedAtMs })
  const dshVersion = readDshVersion()
  let lastTriggerAt = 0

  store.ensure()

  // 握手：告诉执行器"这个 pid 已经把插件加载起来了"。
  // 只有它是被本轮重启换出来的新进程时才带 runId；老进程自愈重挂时写空 runId。
  ;(() => {
    const run = store.readRun()
    const previous = (run && Date.parse(String(run.startedAt || ''))) || 0
    const isNewInstance = isActive(run) && Number(run.oldPid) !== process.pid && startedAtMs >= previous - 5000
    store.writeBoot({
      instanceId: Math.random().toString(36).slice(2) + Date.now().toString(36),
      pid: process.pid,
      at: new Date().toISOString(),
      startedAtMs,
      dshVersion,
      nodeVersion: process.version,
      port,
      unit,
      mode: runtime.mode,
      runId: isNewInstance ? run.runId : '',
    })
  })()

  // 冷启动自愈：上次执行器被杀在半路时，别让界面永远停在"重启中"。
  store.recover(ctx.logger)

  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        store.recover(ctx.logger)
      } catch {}
    }, 10000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-restart: 自愈巡检')

  function snapshot() {
    const run = store.recover(ctx.logger)
    const heartbeat = store.readHeartbeat()
    const lock = store.readLock()
    const heartbeatAgeMs =
      heartbeat && run && heartbeat.runId === run.runId ? Math.max(0, Date.now() - (Number(heartbeat.at) || 0)) : -1
    const runnerPid = lock && run && lock.runId === run.runId ? Number(lock.pid) || 0 : 0
    const history = store.readHistory()
    return {
      ok: true,
      now: Date.now(),
      run: sanitizeRun(run),
      history: Array.isArray(history) ? history.slice(0, 12) : [],
      live: {
        runnerAlive: runnerPid > 0 && pidAlive(runnerPid),
        runnerPid,
        heartbeatAgeMs,
        heartbeatStale: heartbeatAgeMs >= 0 && heartbeatAgeMs > STALE_HEARTBEAT_MS,
        oldPidAlive: !!run && Number(run.oldPid) > 0 && pidAlive(Number(run.oldPid)),
      },
      sys: {
        pid: process.pid,
        startedAt,
        uptimeSec: Math.floor(process.uptime()),
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        dshVersion,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        mode: runtime.mode,
        modeReason: runtime.modeReason,
        requestedMode: runtime.requestedMode,
        manager: runtime.manager,
        unit,
        unitSource: runtime.unitSource,
        detectedUnit: runtime.detectedUnit,
        systemctl: runtime.hasSystemctl ? runtime.systemctl : '',
        systemdRun: runtime.systemdRun,
        scopeIsolation: runtime.scope,
        systemdBooted: runtime.systemdBooted,
        bindHost: runtime.host,
        port,
        origin: runtime.origin,
        advertisedUrl: runtime.advertised,
        healthUrl: runtime.healthUrl,
        cwd: runtime.cwd,
        dataDir,
        startCommand: runtime.startCmd.map((part) => (/token|key|secret|pass/i.test(part) ? '***' : part)),
        bootAt: (function () {
          const boot = store.readBoot()
          return boot && boot.at ? boot.at : ''
        })(),
      },
      cooldownMs: COOLDOWN_MS,
      logTail: store.logTail(6000),
    }
  }

  async function readBody(request) {
    try {
      const text = await request.text()
      if (!text || !text.trim()) return null
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  async function handleStatus() {
    return jsonResponse(snapshot())
  }

  async function handleRestart(request) {
    const body = await readBody(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return failResponse('INVALID_BODY', '请求体必须是非空 JSON 对象', 400)
    }
    const action = body.action
    if (action !== undefined && action !== 'restart') {
      return failResponse('INVALID_ACTION', '未知 action：' + String(action), 400)
    }

    const now = Date.now()
    const current = store.readRun()
    if (isActive(current)) {
      const heartbeat = store.readHeartbeat()
      const fresh = heartbeat && heartbeat.runId === current.runId && now - (Number(heartbeat.at) || 0) < 8000
      if (fresh) return failResponse('BUSY', 'run ' + current.runId + ' 正在进行', 409)
      // 陈旧活跃状态先自愈，再决定是否放行
      store.recover(ctx.logger)
      const again = store.readRun()
      if (isActive(again)) return failResponse('BUSY', 'run ' + again.runId + ' 仍未收尾', 409)
    }

    const last = store.readRun()
    if (isTerminal(last) && now - (Date.parse(String(last.finishedAt || '')) || 0) < COOLDOWN_MS) {
      return failResponse('COOLDOWN', '', 429)
    }
    if (now - lastTriggerAt < COOLDOWN_MS) return failResponse('COOLDOWN', '', 429)

    const blocked = preflight(runtime)
    if (blocked) {
      ctx.logger?.warn?.('[dsh-restart] 预检未通过：' + blocked.code + ' ' + (blocked.detail || ''))
      return failResponse(blocked.code, blocked.detail, blocked.status || 400)
    }

    const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6)
    const run = newRun({
      runId,
      mode: runtime.mode,
      manager: runtime.manager,
      unit,
      unitSource: runtime.unitSource,
      host: runtime.host,
      port,
      healthUrl: runtime.healthUrl,
      maxAttempts: MAX_ATTEMPTS,
      oldPid: process.pid,
      triggeredBy: 'web',
      clientRequestId: String((body && body.requestId) || ''),
    })
    run.status = 'queued'
    run.note = '已受理，等待执行器接管'
    store.writeRun(run)
    store.writeLock({ runId, pid: 0, at: Date.now(), unit, pending: true })
    lastTriggerAt = now

    const plan = launchPlan(runtime, runId)
    let child
    let stderrTail = ''
    try {
      child = spawn(plan.command, plan.args, {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        cwd: runtime.cwd,
      })
      child.stderr?.on('data', (buf) => {
        stderrTail = (stderrTail + String(buf)).slice(-600)
        ctx.logger?.warn?.('[dsh-restart] ' + path.basename(plan.command) + ': ' + String(buf).trim())
      })
    } catch (e) {
      store.failLaunch(run, String((e && e.message) || e))
      lastTriggerAt = 0
      return failResponse('LAUNCH_TIMEOUT', String((e && e.message) || e), 500)
    }

    const launched = await new Promise((resolve) => {
      let settled = false
      let check = null
      let timer = null
      const done = (value) => {
        if (settled) return
        settled = true
        if (check) clearInterval(check)
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      const lockAccepted = () => {
        const lock = store.readLock()
        const pid = lock && lock.runId === runId ? Number(lock.pid) || 0 : 0
        return pid > 0 && pidAlive(pid)
      }
      child.once('error', (e) => done({ ok: false, detail: String((e && e.message) || e) }))
      child.once('exit', (code, signal) => {
        const tail = stderrTail.trim()
        done({
          ok: false,
          detail:
            path.basename(plan.command) +
            ' 提前退出（code=' +
            code +
            (signal ? ', signal=' + signal : '') +
            '）' +
            (tail ? '：' + tail.split('\n').slice(-2).join(' / ') : ''),
        })
      })
      check = setInterval(() => {
        if (lockAccepted()) done({ ok: true })
      }, 120)
      timer = setTimeout(() => {
        // 超时边界再确认一次，避免刚写 lock 的执行器被误杀。
        if (lockAccepted()) {
          done({ ok: true })
          return
        }
        done({
          ok: false,
          detail: '执行器 ' + Math.round(RUNNER_LAUNCH_TIMEOUT_MS / 1000) + ' 秒内没有接管（' + path.basename(plan.command) + ' 仍在运行，但没有写 lock）',
        })
      }, RUNNER_LAUNCH_TIMEOUT_MS)
    })
    try {
      child.unref()
    } catch {}

    if (!launched.ok) {
      try {
        child.kill('SIGTERM')
      } catch {}
      if (plan.scope && runtime.hasSystemctl) {
        try {
          execFileSync(runtime.systemctl, managerArgs(runtime.manager).concat(['stop', plan.scopeUnit]), {
            timeout: 3000,
            stdio: 'ignore',
          })
        } catch {}
      }
      store.failLaunch(run, launched.detail)
      lastTriggerAt = 0
      ctx.logger?.error?.('[dsh-restart] 执行器启动失败：' + launched.detail)
      return failResponse('LAUNCH_TIMEOUT', launched.detail, 500)
    }

    ctx.logger?.info?.(
      '[dsh-restart] 已触发重启 run=' +
        runId +
        ' mode=' +
        runtime.mode +
        ' unit=' +
        (unit || '(direct)') +
        ' host=' +
        runtime.host +
        ' port=' +
        port,
    )
    return jsonResponse({ ok: true, runId, mode: runtime.mode, note: '已触发重启' })
  }

  async function handle(request) {
    let pathname = ''
    try {
      pathname = new URL(request.url).pathname
    } catch {
      return jsonResponse({ ok: false, error: 'bad url' }, 400)
    }
    const method = String(request.method || 'GET').toUpperCase()

    if (pathname === '/api/dsh-restart/status') {
      if (method !== 'GET') return jsonResponse({ ok: false, error: 'method not allowed' }, 405)
      return handleStatus()
    }
    if (pathname === '/api/dsh-restart/restart') {
      if (method !== 'POST') return jsonResponse({ ok: false, error: 'method not allowed' }, 405)
      return handleRestart(request)
    }
    if (pathname === '/api/dsh-restart/log') {
      if (method !== 'GET') return jsonResponse({ ok: false, error: 'method not allowed' }, 405)
      let wantLines = 200
      try {
        const requested = Number(new URL(request.url).searchParams.get('lines'))
        if (Number.isFinite(requested) && requested > 0) wantLines = Math.max(1, Math.min(1000, Math.floor(requested)))
      } catch {}
      const raw = store.logTail(Math.min(256 * 1024, Math.max(4096, wantLines * 300)))
      const tail = raw.split('\n').slice(-wantLines).join('\n')
      return jsonResponse({ ok: true, lines: wantLines, tail, run: sanitizeRun(store.readRun()) })
    }
    return jsonResponse({ ok: false, error: 'not found' }, 404)
  }

  const routes = [
    { path: '/api/dsh-restart/status', methods: ['GET'] },
    { path: '/api/dsh-restart/restart', methods: ['POST'] },
    { path: '/api/dsh-restart/log', methods: ['GET'] },
  ]
  for (const route of routes) {
    try {
      connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: 'buffered',
        fetch: (request) => handle(request),
      })
    } catch (e) {
      ctx.logger?.error?.('[dsh-restart] 注册路由失败 ' + route.path + ': ' + String((e && e.message) || e))
      return
    }
  }

  ctx.logger?.info?.(
    '[dsh-restart] 已启动：mode=' +
      runtime.mode +
      ' unit=' +
      (unit || '(direct)') +
      ' host=' +
      runtime.host +
      ' port=' +
      port +
      ' probe=' +
      (runtime.healthUrl || '(tcp)') +
      ' data=' +
      dataDir +
      ' dsh=' +
      dshVersion,
  )
}
