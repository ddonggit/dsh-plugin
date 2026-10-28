// Host half: 重启接口 + 状态查询。刻意做薄——真正的重启流程在 lib/restart-runner.mjs 里，
// 因为本进程会在重启时被杀掉。
//
// 写权分工：
//   · run.json 由执行器推进；宿主只在执行器心跳消失后补写终态（见 store.recover）
//   · boot.json 只由本进程在 apply 时写，作为"新实例已加载插件"的握手标记
//   · 触发时宿主先写 queued，再拉起执行器；执行器接管后宿主不再写阶段
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { errorOf, isActive, isTerminal, newRun, sanitizeRun } from './state.mjs'
import { createStore, STALE_HEARTBEAT_MS } from './store.mjs'
import { pidAlive } from './proc.mjs'

export const name = 'dsh-restart'
export const inject = ['connection']

const RUNNER = fileURLToPath(new URL('./restart-runner.mjs', import.meta.url))
const COOLDOWN_MS = 3000
const RUNNER_LAUNCH_TIMEOUT_MS = 8000

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
  try {
    const server = ctx.get('webServer')
    if (server && Number(server.port) > 0) return Number(server.port)
  } catch {}
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

function resolveUnit() {
  return String(process.env.DSH_RESTART_UNIT || 'dsh-web')
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

function selfCommand() {
  return [process.execPath].concat(process.argv.slice(1))
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

function resolveBin(bin) {
  const list = String(process.env.PATH || '').split(':').filter(Boolean).concat(['/usr/bin', '/bin', '/usr/local/bin'])
  for (const dir of list) {
    const p = path.join(dir, bin)
    if (fs.existsSync(p)) return p
  }
  return bin
}

function sysctlExists() {
  const list = String(process.env.PATH || '').split(':').filter(Boolean).concat(['/usr/bin', '/bin', '/usr/local/bin'])
  for (const dir of list) {
    if (fs.existsSync(path.join(dir, 'systemctl'))) return path.join(dir, 'systemctl')
  }
  return ''
}

export function apply(ctx, config) {
  const connection = ctx.get('connection')
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    ctx.logger?.warn?.('[dsh-restart] 缺少 connection.fetch 服务，插件未启动')
    return
  }

  const home = resolveHome(ctx)
  const dataDir = process.env.DSH_RESTART_DATA_DIR || path.join(home, 'dsh-restart', 'data')
  const unit = resolveUnit()
  const port = resolvePort(ctx)
  const healthUrl = 'http://127.0.0.1:' + port + '/'
  const systemctl = String(process.env.DSH_RESTART_SYSTEMCTL || sysctlExists() || 'systemctl')
  const dshVersion = readDshVersion()
  const startedAtMs = Date.now() - Math.round(process.uptime() * 1000)
  const startedAt = new Date(startedAtMs).toISOString()
  const store = createStore(dataDir, { bootedAt: startedAtMs })
  const startCmd = selfCommand()
  let lastTriggerAt = 0

  store.ensure()

  // 握手：告诉执行器"这个 pid 已经把插件加载起来了"。
  // 只有它是被本轮重启换出来的新进程时才带 runId；老进程自愈重挂时写空 runId。
  ;(() => {
    const run = store.readRun()
    const previous = run && Date.parse(String(run.startedAt || '')) || 0
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
        unit,
        port,
        healthUrl,
        dataDir,
        systemctl,
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
      const fresh =
        heartbeat && heartbeat.runId === current.runId && now - (Number(heartbeat.at) || 0) < 8000
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

    const sctl = systemctl
    if (!fs.existsSync(sctl) && !fs.existsSync(resolveBin(sctl))) {
      return failResponse('NO_SYSTEMCTL', '找不到 systemctl：' + sctl, 500)
    }
    let loadState = 'unknown'
    let probeError = ''
    try {
      loadState = execFileSync(sctl, ['show', '-p', 'LoadState', '--value', unit], {
        timeout: 4000,
        encoding: 'utf8',
      }).trim()
    } catch (e) {
      probeError = String((e && e.message) || e)
    }
    if (loadState !== 'loaded') {
      return failResponse('UNIT_NOT_FOUND', 'unit=' + unit + ' LoadState=' + loadState + (probeError ? ' | ' + probeError : ''), 400)
    }
    if (!fs.existsSync(RUNNER)) return failResponse('RUNNER_MISSING', '缺少执行器文件：' + RUNNER, 500)

    const runId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6)
    const run = newRun({
      runId,
      unit,
      port,
      healthUrl,
      maxAttempts: 3,
      oldPid: process.pid,
      triggeredBy: 'web',
      clientRequestId: String((body && body.requestId) || ''),
    })
    run.status = 'queued'
    run.note = '已受理，等待执行器接管'
    store.writeRun(run)
    store.writeLock({ runId, pid: 0, at: Date.now(), unit, pending: true })
    lastTriggerAt = now

    const scopeUnit = 'dsh-restart-' + runId
    const args = [
      '--collect',
      '--quiet',
      '--scope',
      '--unit=' + scopeUnit,
      '--working-directory=' + home,
      process.execPath,
      RUNNER,
      '--run-id',
      runId,
      '--data-dir',
      dataDir,
      '--unit',
      unit,
      '--port',
      String(port),
      '--health-url',
      healthUrl,
      '--systemctl',
      sctl,
      '--max-attempts',
      '3',
      '--start-cmd',
      JSON.stringify(startCmd),
      '--fallback',
      '1',
    ]

    let child
    let stderrTail = ''
    try {
      child = spawn(resolveBin('systemd-run'), args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'], cwd: home })
      stderrTail = ''
      child.stderr?.on('data', (buf) => {
        stderrTail = (stderrTail + String(buf)).slice(-600)
        ctx.logger?.warn?.('[dsh-restart] systemd-run: ' + String(buf).trim())
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
            'systemd-run 提前退出（code=' + code + (signal ? ', signal=' + signal : '') + '）' + (tail ? '：' + tail.split('\n').slice(-2).join(' / ') : ''),
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
        done({ ok: false, detail: '执行器 ' + Math.round(RUNNER_LAUNCH_TIMEOUT_MS / 1000) + ' 秒内没有接管（systemd-run 仍在运行，但没有写 lock）' })
      }, RUNNER_LAUNCH_TIMEOUT_MS)
    })
    try {
      child.unref()
    } catch {}

    if (!launched.ok) {
      // systemd-run 客户端退出/超时不等于 scope 已清理；显式 stop，避免遗留执行器晚到后写状态。
      try {
        child.kill('SIGTERM')
      } catch {}
      try {
        execFileSync(sctl, ['stop', scopeUnit], { timeout: 3000, stdio: 'ignore' })
      } catch {}
      store.failLaunch(run, launched.detail)
      lastTriggerAt = 0
      ctx.logger?.error?.('[dsh-restart] 执行器启动失败：' + launched.detail)
      return failResponse('LAUNCH_TIMEOUT', launched.detail, 500)
    }

    ctx.logger?.info?.('[dsh-restart] 已触发重启 run=' + runId + ' unit=' + unit + ' port=' + port)
    return jsonResponse({ ok: true, runId, note: '已触发重启' })
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
    '[dsh-restart] 已启动：unit=' + unit + ' port=' + port + ' data=' + dataDir + ' dsh=' + dshVersion,
  )
}
