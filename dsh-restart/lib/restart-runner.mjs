#!/usr/bin/env node
// 重启执行器：在独立 systemd scope 里运行，是唯一推进 run.json 阶段的写者。
// 宿主进程会在 systemctl restart 时被杀掉，所以这里不能依赖宿主存活。
//
// 参数（由宿主拼装，全部单值，不做 shell 拼接）：
//   node restart-runner.mjs --run-id <id> --data-dir <dir> --unit <unit> --port <port>
//     [--health-url <url>] [--systemctl <path>] [--start-cmd '<json 数组>']
//     [--max-attempts 3] [--health-timeout 90000] [--handshake-grace 30000]
//     [--backoff 3000] [--fallback 0|1] [--reparented]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { errorOf, finishStep, isActive, readJson, resetSteps, startStep } from './state.mjs'
import { createStore } from './store.mjs'
import { cgroupHasUnit, findPidByPort, httpProbe, isDshWebPid, pidAlive, sleep } from './proc.mjs'

const SELF = fileURLToPath(import.meta.url)
const STARTED_WALL = Date.now()

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.slice(0, 2) !== '--') continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.slice(0, 2) === '--') {
      out[key] = '1'
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

const cli = parseArgs(process.argv.slice(2))
const runId = String(cli['run-id'] || '')
const dataDir = String(cli['data-dir'] || '')
const unit = String(cli.unit || 'dsh-web')
const port = Number(cli.port) || 0
const healthUrl = String(cli['health-url'] || (port ? 'http://127.0.0.1:' + port + '/' : ''))
const systemctl = String(cli.systemctl || 'systemctl')
const startCmd = parseCmd(cli['start-cmd'])
const maxAttempts = Math.max(1, Math.min(6, Number(cli['max-attempts']) || 3))
const healthTimeout = Math.max(5000, Number(cli['health-timeout']) || 90000)
const handshakeGrace = Math.max(1000, Number(cli['handshake-grace']) || 30000)
const backoff = Math.max(500, Number(cli['backoff']) || 3000)
const pidWaitMs = Math.max(1000, Number(cli['pid-timeout']) || 15000)
const allowFallback = String(cli.fallback || '1') !== '0'
const reparented = cli.reparented === '1'

function parseCmd(value) {
  const raw = String(value || '').trim()
  if (!raw) return []
  if (raw[0] === '[') {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.map(String).filter(Boolean)
    } catch {}
  }
  return []
}

const store = createStore(dataDir, { bootedAt: STARTED_WALL })
store.ensure()

let run = null
let heartbeatTimer = null
let finished = false

function appendLog(line) {
  const text = '[' + new Date().toISOString() + '] ' + line + '\n'
  try {
    const log = store.files.log
    try {
      const stat = fs.statSync(log)
      if (stat.size > 2 * 1024 * 1024) fs.writeFileSync(log, store.logTail(800 * 1024))
    } catch {}
    fs.appendFileSync(log, text)
  } catch {}
  try {
    process.stdout.write(text)
  } catch {}
}

function currentRunMatches() {
  const current = store.readRun()
  return !!current && current.runId === runId
}

// 执行器只拥有启动它的那一轮。任何写盘前都重新确认 run.json 仍是本轮，
// 防止晚到/重复执行器把之后的 run 覆盖掉。
function save() {
  if (!run || run.runId !== runId) return false
  if (!currentRunMatches()) {
    appendLog('run 已被其他轮次接管，执行器停止写盘（self=' + runId + '）')
    finished = true
    stopHeartbeat()
    return false
  }
  run.updatedAt = new Date().toISOString()
  store.writeRun(run)
  return true
}

function startHeartbeat() {
  stopHeartbeat()
  const beat = () => {
    if (!run || run.runId !== runId) return
    if (!currentRunMatches()) {
      appendLog('run 已被其他轮次接管，执行器停止心跳')
      finished = true
      stopHeartbeat()
      return
    }
    const active = run.steps.find((s) => s && s.status === 'active')
    store.writeHeartbeat(run, active ? active.id : run.status)
  }
  beat()
  heartbeatTimer = setInterval(beat, 1500)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function which(bin) {
  if (bin.indexOf('/') >= 0) return fs.existsSync(bin) ? bin : ''
  const dirs = String(process.env.PATH || '').split(':').filter(Boolean).concat(['/usr/bin', '/bin', '/usr/local/bin'])
  for (const dir of dirs) {
    const p = path.join(dir, bin)
    if (fs.existsSync(p)) return p
  }
  return ''
}

function runCommand(args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    try {
      execFile(
        args[0],
        args.slice(1),
        { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && err.killed) {
            finish({ code: -1, timedOut: true, stdout: String(stdout || ''), stderr: String(stderr || '') || 'timeout' })
            return
          }
          finish({
            code: err ? Number(err.code) || 1 : 0,
            timedOut: false,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            error: err ? String(err.message || err) : '',
          })
        },
      ).on('error', (err) => finish({ code: -2, timedOut: false, stdout: '', stderr: String(err.message || err) }))
    } catch (e) {
      finish({ code: -2, timedOut: false, stdout: '', stderr: String((e && e.message) || e) })
    }
  })
}

// 把执行器从目标 systemd unit 的 cgroup 里搬出去：否则 systemctl restart 会把它一起杀掉，
// 重启中途就没人写状态了。搬不出去就不重启——宁可失败，也不做"点完就失联"的重启。
async function handOffToScope() {
  let cgroup = ''
  try {
    cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8')
  } catch {}
  if (!cgroupHasUnit(cgroup, unit)) return { needed: false }

  const systemdRun = which('systemd-run')
  if (!systemdRun) return { needed: true, ok: false, detail: '找不到 systemd-run' }

  let cwd = process.cwd()
  if (!fs.existsSync(cwd)) cwd = os.homedir()
  const scopeName = 'dsh-restart-' + (runId || Date.now())
  const args = [
    '--collect',
    '--quiet',
    '--scope',
    '--unit=' + scopeName,
    '--working-directory=' + cwd,
    process.execPath,
    SELF,
  ].concat(process.argv.slice(2), ['--reparented', '1'])

  appendLog('执行器脱离 ' + unit + ' cgroup：systemd-run --scope --unit=' + scopeName)
  try {
    const child = spawn(systemdRun, args, { detached: true, stdio: 'ignore', cwd })
    child.unref()
    // 等子执行器把 lock 换成自己的 pid；换到了就说明它已经独立跑起来了。
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      await sleep(150)
      const lock = store.readLock()
      if (lock && Number(lock.pid) && Number(lock.pid) !== process.pid && pidAlive(Number(lock.pid))) {
        appendLog('已移交给独立执行器 pid ' + lock.pid + '，原进程退出')
        return { needed: true, ok: true, pid: Number(lock.pid) }
      }
    }
    return { needed: true, ok: false, detail: '独立执行器在 3 秒内没有接管' }
  } catch (e) {
    return { needed: true, ok: false, detail: String((e && e.message) || e) }
  }
}

async function unitLoadState() {
  const res = await runCommand([systemctl, 'show', '-p', 'LoadState', '--value', unit], 8000)
  if (res.code !== 0) return { load: 'unknown', error: (res.stderr || res.stdout || res.error || '').trim() }
  return { load: (res.stdout || '').trim() || 'unknown', error: '' }
}

async function mainPid() {
  const res = await runCommand([systemctl, 'show', '-p', 'MainPID', '--value', unit], 8000)
  if (res.code !== 0) return 0
  return Number((res.stdout || '').trim()) || 0
}

async function serviceActive() {
  const res = await runCommand([systemctl, 'is-active', unit], 8000)
  return (res.stdout || '').trim()
}

function bootState(pidValue) {
  const boot = readJson(store.files.boot, null)
  if (!boot || typeof boot !== 'object') return { ok: false, why: 'no-boot' }
  if (String(boot.runId || '') !== runId) return { ok: false, why: 'run-id' }
  if (Number(boot.pid) !== Number(pidValue)) return { ok: false, why: 'pid' }
  const at = Date.parse(String(boot.at || '')) || 0
  const startedAtMs = Number(boot.startedAtMs) || 0
  if (!at || Date.now() - at > 5 * 60 * 1000) return { ok: false, why: 'stale' }
  if (startedAtMs && startedAtMs < STARTED_WALL - 5000) return { ok: false, why: 'old-process' }
  return { ok: true, boot }
}

// 就绪判定：HTTP 在线 + 新实例回报了匹配的启动标记。
// 若 HTTP 已通但标记迟迟不来（插件没加载/被禁用），超过 grace 也算恢复，但标记 degraded。
async function waitReady(deadlineMs, pidProvider, options) {
  const opts = options || {}
  let http = { ok: false, error: 'not-probed' }
  let httpOkAt = 0
  let lastProbeAt = 0
  let handshake = { ok: false, why: 'not-probed' }
  while (Date.now() < deadlineMs) {
    if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) {
      return { ok: false, code: 'READY_TIMEOUT', detail: opts.abortDetail || '启动进程提前退出' }
    }
    const pid = await pidProvider()
    if (pid) {
      if (typeof opts.isEligible === 'function' && !opts.isEligible(pid)) {
        handshake = { ok: false, why: 'not-target-process' }
        await sleep(700)
        continue
      }
      const now = Date.now()
      if (now - lastProbeAt >= 1000) {
        lastProbeAt = now
        http = await httpProbe(healthUrl, 3000)
      }
      if (http.ok) {
        if (!httpOkAt) httpOkAt = now
        handshake = bootState(pid)
        if (handshake.ok) return { ok: true, pid, boot: handshake.boot, degraded: false }
        if (Date.now() - httpOkAt > handshakeGrace) {
          return { ok: true, pid, degraded: true, detail: '未收到启动标记（' + handshake.why + '）' }
        }
      }
    }
    await sleep(700)
  }
  return { ok: false, code: 'READY_TIMEOUT', detail: 'HTTP 探测：' + (http.ok ? 'ok' : http.error || 'unknown') + '；启动标记：' + (handshake.why || 'unknown') }
}

async function waitHttp(deadlineMs) {
  let last = { ok: false, error: 'not-started' }
  while (Date.now() < deadlineMs) {
    last = await httpProbe(healthUrl, 3000)
    if (last.ok) return { ok: true }
    await sleep(800)
  }
  return { ok: false, code: 'READY_TIMEOUT', detail: 'HTTP 探测：' + (last.error || 'unknown') }
}

async function verifyListener(pidValue) {
  const want = Number(pidValue) || 0
  const deadline = Date.now() + 15000
  let lastPid = 0
  while (Date.now() < deadline) {
    lastPid = findPidByPort(port)
    if (lastPid && lastPid === want) return { ok: true, pid: lastPid }
    await sleep(400)
  }
  return { ok: false, pid: lastPid, want }
}

async function attemptOnce(n) {
  const attemptStart = new Date()
  run.attempt = n
  run.status = 'restarting'
  resetSteps(run, ['restart', 'ready', 'verify'])
  save()

  startStep(run, 'restart', 'systemctl restart ' + unit)
  save()
  appendLog('第 ' + n + '/' + maxAttempts + ' 次：systemctl restart ' + unit)
  const restart = await runCommand([systemctl, 'restart', unit], 90000)
  if (restart.timedOut || restart.code !== 0) {
    const code = restart.timedOut ? 'UNIT_RESTART_TIMEOUT' : 'UNIT_RESTART_FAILED'
    const detail = (restart.stderr || restart.stdout || '').trim()
    finishStep(run, 'restart', 'failed', detail.slice(0, 300))
    save()
    return { ok: false, code, detail: detail.slice(0, 400) }
  }

  const pidDeadline = Date.now() + pidWaitMs
  let pid = 0
  while (Date.now() < pidDeadline) {
    pid = await mainPid()
    if (pid && pid !== Number(run.oldPid)) break
    await sleep(500)
  }
  if (!pid) {
    finishStep(run, 'restart', 'failed', '没有 MainPID')
    save()
    return { ok: false, code: 'NO_MAIN_PID', detail: 'systemctl restart 返回 0，但 MainPID 为空' }
  }
  if (pid === Number(run.oldPid)) {
    const detail = 'systemctl restart 返回 0，但 MainPID 仍是旧进程 ' + pid
    finishStep(run, 'restart', 'failed', detail)
    save()
    return { ok: false, code: 'MAIN_PID_UNCHANGED', detail }
  }
  run.newPid = pid
  run.status = 'waiting'
  finishStep(run, 'restart', 'done', 'MainPID ' + pid)
  save()

  startStep(run, 'ready', '等待新实例 pid ' + pid)
  save()
  const ready = await waitReady(Date.now() + healthTimeout, async () => (await mainPid()) || pid)
  if (!ready.ok) {
    finishStep(run, 'ready', 'failed', ready.detail || ready.code)
    save()
    return { ok: false, code: ready.code, detail: ready.detail || '' }
  }
  if (ready.degraded) run.degraded = true
  finishStep(run, 'ready', 'done', ready.degraded ? 'HTTP 已通（' + ready.detail + '）' : 'pid ' + ready.pid + ' 已回报启动标记')
  save()
  appendLog('新实例就绪 pid ' + ready.pid + (ready.degraded ? '（降级：无启动标记）' : ''))

  startStep(run, 'verify', '核对监听端口 PID')
  save()
  const verified = await verifyListener(ready.pid)
  if (!verified.ok) {
    finishStep(run, 'verify', 'failed', '端口 ' + port + ' 上是 ' + (verified.pid || '无进程') + '，期望 ' + verified.want)
    save()
    return { ok: false, code: 'VERIFY_LISTENER_MISMATCH', detail: '端口 ' + port + ' 监听 PID 不匹配' }
  }
  run.newPid = verified.pid
  finishStep(run, 'verify', 'done', 'pid ' + verified.pid + ' 正在监听 ' + port)
  save()
  run.attempts.push({
    n,
    ok: true,
    at: attemptStart.toISOString(),
    ms: Date.now() - attemptStart.getTime(),
    code: '',
    detail: '',
  })
  return { ok: true, pid: verified.pid }
}

async function fallbackStart() {
  run.fallback = true
  run.status = 'restarting'
  startStep(run, 'restart', '兜底：停止单元后直接启动')
  save()
  appendLog('兜底：systemctl stop ' + unit)
  await runCommand([systemctl, 'stop', unit], 60000)

  const stray = findPidByPort(port)
  if (stray && isDshWebPid(stray)) {
    appendLog('兜底：清理端口 ' + port + ' 上的残留 dsh web pid ' + stray)
    try {
      process.kill(stray, 'SIGTERM')
    } catch {}
    const until = Date.now() + 8000
    while (Date.now() < until && pidAlive(stray)) await sleep(300)
    if (pidAlive(stray)) {
      try {
        process.kill(stray, 'SIGKILL')
      } catch {}
    }
  }
  if (!startCmd.length) {
    finishStep(run, 'restart', 'failed', '没有可用的启动命令')
    save()
    return { ok: false, code: 'FALLBACK_FAILED', detail: '宿主没有提供启动命令' }
  }

  // 兜底启动也放进独立 scope：执行器退出后，systemd 会回收自己的 scope，
  // 直接把子进程留在执行器的 cgroup 里会被一起杀掉。
  const systemdRun = which('systemd-run')
  const cwd = fs.existsSync(os.homedir()) ? os.homedir() : '/'
  let launcher
  if (systemdRun) {
    launcher = {
      cmd: systemdRun,
      args: [
        '--collect',
        '--quiet',
        '--scope',
        '--unit=dsh-restart-fallback-' + runId,
        '--working-directory=' + cwd,
      ].concat(startCmd),
    }
  } else {
    launcher = { cmd: startCmd[0], args: startCmd.slice(1) }
  }
  let launcherChild = null
  let launchError = ''
  try {
    const logFd = fs.openSync(store.files.log, 'a')
    try {
      launcherChild = spawn(launcher.cmd, launcher.args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        cwd,
      })
    } finally {
      fs.closeSync(logFd)
    }
    launcherChild.once('error', (e) => {
      launchError = String((e && e.message) || e)
      appendLog('兜底：启动命令异常：' + launchError)
    })
    launcherChild.once('exit', (code, signal) => {
      if (finished) return
      launchError = '启动命令提前退出（code=' + code + (signal ? ', signal=' + signal : '') + '）'
      appendLog('兜底：' + launchError)
    })
    launcherChild.unref()
    appendLog('兜底：已直接启动：' + startCmd.join(' '))
  } catch (e) {
    finishStep(run, 'restart', 'failed', String((e && e.message) || e))
    save()
    return { ok: false, code: 'FALLBACK_FAILED', detail: String((e && e.message) || e) }
  }
  finishStep(run, 'restart', 'done', '已直接启动，等待端口')
  run.status = 'waiting'
  save()

  startStep(run, 'ready', '等待直接启动的实例')
  save()
  const eligible = (pid) => {
    if (!pid || pid === Number(run.oldPid)) return false
    if (launchError) return false
    if (launcherChild && launcherChild.exitCode !== null) return false
    return isDshWebPid(pid)
  }
  const ready = await waitReady(
    Date.now() + healthTimeout,
    async () => {
      try {
        const listening = findPidByPort(port)
        if (listening && eligible(listening)) run.newPid = listening
        return listening
      } catch {
        return 0
      }
    },
    {
      isEligible: eligible,
      shouldAbort: () => !!launchError || !!(launcherChild && launcherChild.exitCode !== null),
      abortDetail: launchError || '兜底启动进程提前退出',
    },
  )
  if (!ready.ok) {
    finishStep(run, 'ready', 'failed', ready.detail || ready.code)
    save()
    return { ok: false, code: 'FALLBACK_FAILED', detail: ready.detail || ready.code }
  }
  if (!eligible(ready.pid)) {
    const detail = '端口 ' + port + ' 上的进程不是本轮兜底启动的 dsh web'
    finishStep(run, 'ready', 'failed', detail)
    save()
    return { ok: false, code: 'FALLBACK_FAILED', detail }
  }
  if (ready.degraded) run.degraded = true
  finishStep(run, 'ready', 'done', ready.degraded ? 'HTTP 已通（' + ready.detail + '）' : 'pid ' + ready.pid + ' 已就绪')
  save()

  startStep(run, 'verify', '核对监听端口 PID')
  save()
  const verified = await verifyListener(ready.pid)
  if (!verified.ok) {
    finishStep(run, 'verify', 'failed', '端口 ' + port + ' 监听 PID 不匹配')
    save()
    return { ok: false, code: 'FALLBACK_FAILED', detail: '兜底启动后监听 PID 不匹配' }
  }
  if (!eligible(verified.pid)) {
    const detail = '兜底启动后的监听进程不是 dsh web'
    finishStep(run, 'verify', 'failed', detail)
    save()
    return { ok: false, code: 'FALLBACK_FAILED', detail }
  }
  run.newPid = verified.pid
  finishStep(run, 'verify', 'done', 'pid ' + verified.pid + ' 正在监听 ' + port)
  save()
  return { ok: true, pid: verified.pid }
}

function fail(code, detail, extra) {
  if (!run || run.runId !== runId) return finish(1)
  run.status = 'failed'
  run.error = errorOf(code, undefined, [detail, extra].filter(Boolean).join(' | '))
  const active = Array.isArray(run.steps) ? run.steps.find((s) => s && s.status === 'active') : null
  if (active) {
    active.status = 'failed'
    active.finishedAt = new Date().toISOString()
    active.ms = active.startedAt ? Date.now() - Date.parse(active.startedAt) : 0
  }
  appendLog('失败 ' + code + '：' + detail)
  return finish(1)
}

function finish(code) {
  finished = true
  stopHeartbeat()
  if (!run || run.runId !== runId) {
    appendLog('没有属于本轮的 run 记录，不写终态（exit ' + code + '）')
    return code
  }
  if (!currentRunMatches()) {
    appendLog('当前 run 已不属于本轮，不写终态（self=' + runId + '，exit ' + code + '）')
    return code
  }
  run.status = run.status === 'done' ? 'done' : 'failed'
  run.finishedAt = run.finishedAt || new Date().toISOString()
  store.recordTerminal(run, 'runner')
  appendLog('结束：' + run.status + '（exit ' + code + '）')
  return code
}

async function runFlow() {
  appendLog('执行器启动 pid=' + process.pid + ' run=' + runId + ' unit=' + unit + ' port=' + port)
  const loaded = store.readRun()
  if (!loaded || loaded.runId !== runId) {
    appendLog('找不到对应的 run 记录，退出且不改写当前状态')
    finished = true
    run = null
    return 1
  }
  run = loaded
  if (!isActive(run)) {
    appendLog('run 已处于终态 ' + run.status + '，不重复执行')
    finished = true
    return 0
  }

  store.writeLock({ runId, pid: process.pid, at: Date.now(), unit })
  run.runnerPid = process.pid
  run.status = 'preflight'
  startStep(run, 'preflight', '检查单元与执行环境')
  save()
  startHeartbeat()

  if (!which(systemctl)) return fail('NO_SYSTEMCTL', '找不到 ' + systemctl, '')
  const state = await unitLoadState()
  if (state.load !== 'loaded') {
    return fail('UNIT_NOT_FOUND', 'systemd 单元 ' + unit + ' 不存在（LoadState=' + state.load + '）', state.error || '')
  }

  if (!reparented) {
    const handoff = await handOffToScope()
    if (handoff.needed) {
      if (!handoff.ok) return fail('NOT_ISOLATED', '执行器无法脱离 ' + unit + ' 的 cgroup', handoff.detail || '')
      // 独立执行器已接管；本进程留在 dsh-web cgroup 里，重启时会被一起杀掉，正好退出。
      stopHeartbeat()
      process.exit(0)
    }
  }
  finishStep(run, 'preflight', 'done', '单元 loaded · 执行器已独立')
  save()

  let lastFailure = null
  for (let n = 1; n <= maxAttempts; n++) {
    const result = await attemptOnce(n)
    if (result.ok) {
      run.status = 'done'
      run.error = null
      run.note = run.degraded ? '服务已恢复并响应；新实例没有回报启动标记。' : ''
      return finish(0)
    }
    lastFailure = result
    run.attempts.push({
      n,
      ok: false,
      at: new Date().toISOString(),
      ms: 0,
      code: result.code,
      detail: String(result.detail || '').slice(0, 300),
    })
    save()
    appendLog('第 ' + n + ' 次失败：' + result.code + ' ' + (result.detail || ''))
    if (n < maxAttempts) {
      resetSteps(run, ['restart', 'ready', 'verify'])
      save()
      await sleep(backoff)
    }
  }

  if (allowFallback) {
    appendLog('进入兜底启动')
    const fallback = await fallbackStart()
    if (fallback.ok) {
      run.status = 'done'
      run.error = null
      run.note = 'systemd 重启未成功，已通过直接启动恢复服务。'
      return finish(0)
    }
    lastFailure = fallback
  }

  return fail(lastFailure ? lastFailure.code : 'FALLBACK_FAILED', lastFailure ? lastFailure.detail : '未知失败', '')
}

process.on('uncaughtException', (err) => {
  try {
    if (run && run.runId === runId && currentRunMatches()) {
      run.status = 'failed'
      run.error = errorOf('CRASH', String((err && err.message) || err), String((err && err.stack) || ''))
      stopHeartbeat()
      store.recordTerminal(run, 'runner')
    }
    appendLog('未捕获异常：' + String((err && err.stack) || err))
  } catch {}
  process.exit(1)
})

process.on('unhandledRejection', (err) => {
  try {
    if (run && run.runId === runId && currentRunMatches()) {
      run.status = 'failed'
      run.error = errorOf('CRASH', String((err && err.message) || err), String((err && err.stack) || ''))
      stopHeartbeat()
      store.recordTerminal(run, 'runner')
    }
    appendLog('未处理的 rejection：' + String((err && err.stack) || err))
  } catch {}
  process.exit(1)
})

function onSignal(signal) {
  if (finished) return
  try {
    if (run && run.runId === runId && currentRunMatches()) {
      run.status = 'failed'
      run.error = errorOf('RUNNER_LOST', '执行器被信号终止：' + signal, '')
      finished = true
      stopHeartbeat()
      store.recordTerminal(run, 'runner')
    }
  } catch {}
  appendLog('收到 ' + signal + '，已写失败终态')
  process.exit(1)
}

process.on('SIGTERM', () => onSignal('SIGTERM'))
process.on('SIGINT', () => onSignal('SIGINT'))

runFlow()
  .then((code) => {
    if (!finished) finish(code === 0 ? 0 : 1)
    process.exit(code === 0 ? 0 : 1)
  })
  .catch((err) => {
    try {
      if (run && run.runId === runId && currentRunMatches()) {
        run.status = 'failed'
        run.error = errorOf('CRASH', String((err && err.message) || err), String((err && err.stack) || ''))
        finished = true
        stopHeartbeat()
        store.recordTerminal(run, 'runner')
      }
      appendLog('执行器异常：' + String((err && err.stack) || err))
    } catch {}
    process.exit(1)
  })
