#!/usr/bin/env node
// 自测：不碰真实 dsh-web 单元、不执行真实重启。
//   1) state/store 纯逻辑
//   2) findPidByPort 真实监听
//   3) 宿主路由（假 connection + 不存在的 unit）
//   4) 执行器端到端：假 systemctl + 假 dsh web 服务
// 用法：node test/selftest.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RUNNER = path.join(ROOT, 'lib', 'restart-runner.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshr-selftest-'))
const NODE = process.execPath
const MOCK_UNIT = 'dsh-restart-selftest-nonexistent'

process.env.DSH_RESTART_DATA_DIR = path.join(TMP, 'host-data')
process.env.DSH_RESTART_UNIT = MOCK_UNIT

const { newRun, startStep, finishStep, resetSteps, stepElapsedMs, errorOf, sanitizeRun, appendHistory, stepOf } =
  await import('../lib/state.mjs')
const { createStore } = await import('../lib/store.mjs')
const { cgroupHasUnit, findPidByPort, pidAlive } = await import('../lib/proc.mjs')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log('  ✓ ' + name)
  } catch (e) {
    failures.push({ name, error: e })
    console.log('  ✗ ' + name + '\n    ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n    '))
  }
}

function tmpDir(name) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve({ timeout: true, code: -1 })
    }, ms)
    child.on('exit', (code, signal) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// 假 systemctl：show/is-active/restart/stop 足够跑通执行器。
function writeFakeSystemctl(dir, behavior) {
  const file = path.join(dir, 'systemctl')
  const body = `#!/bin/bash
STATE=${JSON.stringify(dir)}
UNIT=dsh-web
cmd="$1"; shift
case "$cmd" in
  show)
    key=""; while [ $# -gt 0 ]; do case "$1" in -p) key="$2"; shift 2;; *) shift;; esac; done
    case "$key" in
      LoadState) echo loaded ;;
      MainPID) if [ -f "$STATE/pid" ]; then cat "$STATE/pid"; else echo 0; fi ;;
      *) echo "" ;;
    esac
    ;;
  is-active) echo active ;;
  stop)
    if [ -f "$STATE/pid" ]; then kill "$(cat "$STATE/pid")" 2>/dev/null; fi
    rm -f "$STATE/pid"
    ;;
  restart)
    if [ -f "$STATE/pid" ]; then kill "$(cat "$STATE/pid")" 2>/dev/null; sleep 0.2; fi
    ${behavior}
    ;;
  *) echo "unsupported: $cmd" >&2; exit 2 ;;
esac
`
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}

const mockWeb = `import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
const [port, dataDir, runId, handshake] = process.argv.slice(2)
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('ok') })
server.listen(Number(port), '127.0.0.1', () => {
  if (handshake === '1') {
    fs.writeFileSync(path.join(dataDir, 'boot.json'), JSON.stringify({
      runId, pid: process.pid, at: new Date().toISOString(), startedAtMs: Date.now() - 200, dshVersion: 'selftest',
    }))
  }
})
`

async function runRunnerCase(name, opts) {
  const dir = tmpDir(name)
  fs.writeFileSync(path.join(dir, 'mock-web.mjs'), mockWeb)
  const port = await freePort()
  const dataDir = path.join(dir, 'data')
  const runId = 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  const behavior = opts.behavior(port, dataDir, runId)
  const systemctl = writeFakeSystemctl(dir, behavior)
  const extra = opts.setup
    ? await opts.setup({ dir, port, dataDir, runId, systemctl, node: NODE, mockWeb: path.join(dir, 'mock-web.mjs') })
    : null
  const oldPid = Number(opts.oldPid || (extra && extra.oldPid) || 999999)
  const startCmd = opts.startCmd || (extra && extra.startCmd) || []
  const store = createStore(dataDir, { bootedAt: Date.now() })
  store.ensure()
  const run = newRun({ runId, unit: 'dsh-web', port, healthUrl: 'http://127.0.0.1:' + port + '/', maxAttempts: 1, oldPid })
  store.writeRun(run)

  const args = [
    RUNNER,
    '--run-id', runId,
    '--data-dir', dataDir,
    '--unit', 'dsh-web',
    '--port', String(port),
    '--health-url', 'http://127.0.0.1:' + port + '/',
    '--systemctl', systemctl,
    '--max-attempts', '1',
    '--health-timeout', String(opts.healthTimeout || 8000),
    '--handshake-grace', String(opts.grace || 3000),
    '--backoff', '500',
    '--fallback', opts.fallback ? '1' : '0',
    '--pid-timeout', String(opts.pidTimeout || 15000),
    '--reparented', '1',
  ]
  if (startCmd.length) args.push('--start-cmd', JSON.stringify(startCmd))
  const runnerEnv = Object.assign({}, process.env, opts.env || {}, (extra && extra.env) || {})
  const child = spawn(NODE, args, { stdio: ['ignore', 'pipe', 'pipe'], env: runnerEnv })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const exit = await waitExit(child, opts.timeout || 30000)
  const result = readJson(path.join(dataDir, 'run.json'))
  try {
    assert.equal(exit.timeout, undefined, '执行器没有在超时内退出\n' + log)
    await opts.check({ result, exit, log, dataDir, port, runId, store, dir, extra })
  } finally {
    const pidFile = path.join(dir, 'pid')
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      if (pid > 1) process.kill(pid, 'SIGKILL')
    } catch {}
    try {
      if (extra && typeof extra.cleanup === 'function') await extra.cleanup()
    } catch {}
  }
  return { result, log }
}

console.log('dsh-restart 自测 · ' + TMP)

await test('state: 阶段推进与耗时可序列化', () => {
  const run = newRun({ runId: 'r1', unit: 'dsh-web', port: 3081, oldPid: 10, clientRequestId: 'req-1' })
  startStep(run, 'preflight', '检查')
  finishStep(run, 'preflight', 'done', 'ok')
  assert.equal(stepOf(run, 'preflight').status, 'done')
  assert.ok(stepElapsedMs(stepOf(run, 'preflight')) >= 0)
  resetSteps(run, ['preflight'])
  assert.equal(stepOf(run, 'preflight').status, 'pending')
  const sanitized = sanitizeRun(run)
  assert.equal(sanitized.steps.length, 4)
  assert.equal(sanitized.error, null)
  assert.equal(JSON.parse(JSON.stringify(sanitized)).runId, 'r1')
  assert.equal(sanitized.clientRequestId, 'req-1')
})

await test('proc.cgroupHasUnit: 精确匹配自定义 unit，不误判其他服务', () => {
  assert.equal(cgroupHasUnit('0::/system.slice/dsh-web.service', 'dsh-web'), true)
  assert.equal(cgroupHasUnit('0::/system.slice/my-dsh-web.service', 'my-dsh-web'), true)
  assert.equal(cgroupHasUnit('0::/system.slice/my-dsh-web.service', 'my-dsh-web.service'), true)
  assert.equal(cgroupHasUnit('0::/system.slice/other.service', 'my-dsh-web'), false)
  assert.equal(cgroupHasUnit('0::/system.slice/dsh-web.service', 'my-dsh-web'), false)
  assert.equal(cgroupHasUnit('4:memory:/system.slice/dsh-web.service\n3:cpu:/system.slice/dsh-web.service', 'dsh-web'), true)
})

await test('state: errorOf 带 message/hint，历史按 runId 去重', () => {
  const err = errorOf('UNIT_NOT_FOUND', '', 'LoadState=not-found')
  assert.equal(err.code, 'UNIT_NOT_FOUND')
  assert.ok(err.message.length > 0 && err.hint.length > 0)
  const file = path.join(tmpDir('history'), 'history.json')
  appendHistory(file, { runId: 'a', ok: true }, 3)
  appendHistory(file, { runId: 'b', ok: false }, 3)
  appendHistory(file, { runId: 'a', ok: true, again: true }, 3)
  const list = readJson(file)
  assert.equal(list.length, 2)
  assert.equal(list[0].runId, 'a')
  assert.equal(list[0].again, true)
})

await test('store.recordTerminal: 不删除另一轮的 lock/heartbeat', () => {
  const dir = tmpDir('terminal-owned-state')
  const store = createStore(dir, { bootedAt: Date.now() })
  const oldRun = newRun({ runId: 'old', unit: 'dsh-web', port: 3081, oldPid: 1 })
  oldRun.status = 'done'
  store.writeRun(oldRun)
  const nextRun = newRun({ runId: 'next', unit: 'dsh-web', port: 3081, oldPid: 2 })
  nextRun.runnerPid = 333333
  store.writeLock({ runId: 'next', pid: 333333, at: Date.now() })
  store.writeHeartbeat(nextRun, 'restart')
  store.recordTerminal(oldRun, 'test')
  assert.equal(store.readLock().runId, 'next')
  assert.equal(store.readHeartbeat().runId, 'next')
})

await test('store.recover: 新进程接管 ⇒ done', () => {
  const dir = tmpDir('recover-done')
  const store = createStore(dir, { bootedAt: Date.now() })
  const run = newRun({ runId: 'rd', unit: 'dsh-web', port: 3081, oldPid: 111111 })
  run.status = 'waiting'
  run.startedAt = new Date(Date.now() - 120000).toISOString()
  startStep(run, 'ready', '等')
  store.writeRun(run)
  store.writeHeartbeat({ runId: 'rd', runnerPid: 999999 }, 'ready')
  store.writeLock({ runId: 'rd', pid: 999999, at: Date.now() })
  const heartbeat = readJson(store.files.heartbeat)
  heartbeat.at = Date.now() - 90000
  fs.writeFileSync(store.files.heartbeat, JSON.stringify(heartbeat))
  const recovered = store.recover()
  assert.equal(recovered.status, 'done')
  assert.equal(recovered.newPid, process.pid)
  assert.equal(store.readHistory().length, 1)
  assert.equal(store.readLock(), null)
})

await test('store.recover: 本进程未被替换 ⇒ failed/RUNNER_LOST', () => {
  const dir = tmpDir('recover-failed')
  const store = createStore(dir, { bootedAt: Date.now() })
  const run = newRun({ runId: 'rf', unit: 'dsh-web', port: 3081, oldPid: process.pid })
  run.status = 'waiting'
  run.startedAt = new Date(Date.now() - 120000).toISOString()
  startStep(run, 'ready', '等')
  store.writeRun(run)
  const heartbeat = { runId: 'rf', pid: 999999, at: Date.now() - 90000 }
  fs.writeFileSync(store.files.heartbeat, JSON.stringify(heartbeat))
  fs.writeFileSync(store.files.lock, JSON.stringify({ runId: 'rf', pid: 999999 }))
  const recovered = store.recover()
  assert.equal(recovered.status, 'failed')
  assert.equal(recovered.error.code, 'RUNNER_LOST')
})

await test('store.recover: 心跳新鲜 ⇒ 不插手', () => {
  const dir = tmpDir('recover-live')
  const store = createStore(dir, { bootedAt: Date.now() })
  const run = newRun({ runId: 'rl', unit: 'dsh-web', port: 3081, oldPid: 42 })
  run.status = 'restarting'
  store.writeRun(run)
  fs.writeFileSync(store.files.heartbeat, JSON.stringify({ runId: 'rl', at: Date.now() - 1000 }))
  assert.equal(store.recover().status, 'restarting')
})

await test('proc.findPidByPort: 返回真实监听进程', async () => {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    assert.equal(findPidByPort(port), process.pid)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  assert.equal(findPidByPort(port), 0)
})

await test('host: status 路由返回宿主信息；未知 unit 触发被拦下', async () => {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          },
        }
      }
      if (name === 'dshHomePath') return () => TMP
      return undefined
    },
    effect(fn) {
      return fn()
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  const mod = await import('../lib/index.js')
  mod.apply(ctx, {})
  assert.ok(routes.size >= 3)

  const statusRes = await routes
    .get('/api/dsh-restart/status')
    .fetch(new Request('http://127.0.0.1/api/dsh-restart/status'))
  assert.equal(statusRes.status, 200)
  const status = await statusRes.json()
  assert.equal(status.ok, true)
  assert.equal(status.sys.pid, process.pid)
  assert.equal(status.sys.unit, MOCK_UNIT)
  assert.equal(typeof status.logTail, 'string')

  const badJsonRes = await routes.get('/api/dsh-restart/restart').fetch(
    new Request('http://127.0.0.1/api/dsh-restart/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    }),
  )
  assert.equal(badJsonRes.status, 400)
  assert.equal((await badJsonRes.json()).code, 'INVALID_BODY')

  const badActionRes = await routes.get('/api/dsh-restart/restart').fetch(
    new Request('http://127.0.0.1/api/dsh-restart/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'bogus' }),
    }),
  )
  assert.equal(badActionRes.status, 400)
  assert.equal((await badActionRes.json()).code, 'INVALID_ACTION')

  const restartRes = await routes.get('/api/dsh-restart/restart').fetch(
    new Request('http://127.0.0.1/api/dsh-restart/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restart' }),
    }),
  )
  assert.equal(restartRes.status, 400)
  const failure = await restartRes.json()
  assert.equal(failure.code, 'UNIT_NOT_FOUND')
  assert.ok(failure.hint)

  const busyDir = process.env.DSH_RESTART_DATA_DIR
  const store = createStore(busyDir, { bootedAt: Date.now() })
  const run = newRun({ runId: 'busy', unit: MOCK_UNIT, port: 3081, oldPid: process.pid })
  run.status = 'restarting'
  store.writeRun(run)
  store.writeHeartbeat({ runId: 'busy', runnerPid: process.pid }, 'restart')
  const busyRes = await routes.get('/api/dsh-restart/restart').fetch(
    new Request('http://127.0.0.1/api/dsh-restart/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restart' }),
    }),
  )
  assert.equal(busyRes.status, 409)
  assert.equal((await busyRes.json()).code, 'BUSY')
  store.recordTerminal({ ...run, status: 'failed', error: errorOf('CRASH', '', '') }, 'test')
})

await test('host: 执行器启动超时会停止 scope 并落下 LAUNCH_TIMEOUT', async () => {
  const dir = tmpDir('host-launch-timeout')
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const marker = path.join(dir, 'scope-stopped')
  const runnerPidFile = path.join(dir, 'fake-systemd-run.pid')
  const fakeSctl = path.join(bin, 'systemctl')
  fs.writeFileSync(
    fakeSctl,
    `#!/bin/bash
cmd="$1"; shift
case "$cmd" in
  show) echo loaded ;;
  stop) printf '%s\n' "$@" > ${JSON.stringify(marker)}; exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(bin, 'systemd-run'),
    `#!/bin/bash
echo $$ > ${JSON.stringify(runnerPidFile)}
sleep 30
`,
    { mode: 0o755 },
  )
  const oldEnv = {
    PATH: process.env.PATH,
    DSH_RESTART_DATA_DIR: process.env.DSH_RESTART_DATA_DIR,
    DSH_RESTART_UNIT: process.env.DSH_RESTART_UNIT,
    DSH_RESTART_SYSTEMCTL: process.env.DSH_RESTART_SYSTEMCTL,
  }
  process.env.PATH = bin + ':' + (oldEnv.PATH || '')
  process.env.DSH_RESTART_DATA_DIR = path.join(dir, 'data')
  process.env.DSH_RESTART_UNIT = 'dsh-unit-test'
  process.env.DSH_RESTART_SYSTEMCTL = fakeSctl
  try {
    const routes = new Map()
    const ctx = {
      get(name) {
        if (name === 'connection') {
          return {
            fetch: {
              register(route) {
                routes.set(route.path, route)
                return () => routes.delete(route.path)
              },
            },
          }
        }
        if (name === 'dshHomePath') return () => dir
        return undefined
      },
      effect(fn) {
        return fn()
      },
      logger: { info() {}, warn() {}, error() {} },
    }
    const mod = await import('../lib/index.js')
    mod.apply(ctx, {})
    const res = await routes.get('/api/dsh-restart/restart').fetch(
      new Request('http://127.0.0.1/api/dsh-restart/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restart' }),
      }),
    )
    assert.equal(res.status, 500)
    assert.equal((await res.json()).code, 'LAUNCH_TIMEOUT')
    const run = readJson(path.join(process.env.DSH_RESTART_DATA_DIR, 'run.json'))
    assert.equal(run.status, 'failed')
    assert.equal(run.error.code, 'LAUNCH_TIMEOUT')
    assert.match(fs.readFileSync(marker, 'utf8'), /dsh-restart-/)
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    try {
      const pid = Number(fs.readFileSync(runnerPidFile, 'utf8').trim())
      if (pid > 1) process.kill(pid, 'SIGKILL')
    } catch {}
  }
})

await test('runner e2e: 重启成功（假 systemctl 换出新进程 + 启动标记）', async () => {
  await runRunnerCase('e2e-ok', {
    behavior: (port, dataDir, runId) => `nohup ${NODE} "$STATE/mock-web.mjs" ${port} ${dataDir} ${runId} 1 >/dev/null 2>&1 & echo $! > "$STATE/pid"; sleep 0.5`,
    check: async ({ result, exit, log, port }) => {
      assert.equal(exit.code, 0, '执行器 exit=' + exit.code + '\n' + log)
      assert.equal(result.status, 'done')
      assert.equal(result.error, null)
      assert.ok(result.newPid > 1)
      assert.equal(result.steps.every((s) => s.status === 'done'), true, JSON.stringify(result.steps))
      assert.equal(result.degraded, false)
      assert.equal(findPidByPort(port), result.newPid)
      assert.match(log, /结束：done/)
    },
  })
})

await test('runner e2e: 新实例不写启动标记 ⇒ 降级 done', async () => {
  await runRunnerCase('e2e-degraded', {
    grace: 1500,
    behavior: (port, dataDir, runId) => `nohup ${NODE} "$STATE/mock-web.mjs" ${port} ${dataDir} ${runId} 0 >/dev/null 2>&1 & echo $! > "$STATE/pid"; sleep 0.5`,
    check: async ({ result, exit, log }) => {
      assert.equal(exit.code, 0, '执行器 exit=' + exit.code + '\n' + log)
      assert.equal(result.status, 'done')
      assert.equal(result.degraded, true)
      assert.match(result.note, /没有回报启动标记/)
    },
  })
})

await test('runner e2e: 单元起不来 ⇒ failed/READY_TIMEOUT', async () => {
  await runRunnerCase('e2e-fail', {
    healthTimeout: 6000,
    behavior: () => `nohup sleep 30 >/dev/null 2>&1 & echo $! > "$STATE/pid"; sleep 0.2`,
    check: async ({ result, exit, log }) => {
      assert.equal(exit.code, 1)
      assert.equal(result.status, 'failed')
      assert.equal(result.error.code, 'READY_TIMEOUT')
      assert.equal(result.steps.find((s) => s.id === 'ready').status, 'failed')
      assert.match(log, /失败 READY_TIMEOUT|结束：failed/)
    },
  })
})

await test('runner: 过期 run-id 不写坏当前另一轮状态', async () => {
  const dir = tmpDir('stale-runner')
  const dataDir = path.join(dir, 'data')
  const store = createStore(dataDir, { bootedAt: Date.now() })
  store.ensure()
  const current = newRun({ runId: 'current-run', unit: 'dsh-web', port: 59999, oldPid: 123 })
  current.status = 'waiting'
  store.writeRun(current)
  const child = spawn(
    NODE,
    [RUNNER, '--run-id', 'stale-run', '--data-dir', dataDir, '--unit', 'dsh-web', '--port', '59999', '--reparented', '1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const exit = await waitExit(child, 5000)
  const after = readJson(path.join(dataDir, 'run.json'))
  assert.equal(exit.code, 1, log)
  assert.equal(after.runId, 'current-run')
  assert.equal(after.status, 'waiting')
  assert.equal(after.completedBy, '')
  assert.equal(after.error, null)
})

await test('runner e2e: MainPID 未变化 ⇒ failed/MAIN_PID_UNCHANGED', async () => {
  await runRunnerCase('e2e-main-pid-unchanged', {
    pidTimeout: 1200,
    behavior: () => ':',
    setup: async ({ dir, port, dataDir, runId, node, mockWeb }) => {
      const mock = spawn(node, [mockWeb, String(port), dataDir, runId, '0'], { detached: true, stdio: 'ignore' })
      mock.unref()
      fs.writeFileSync(path.join(dir, 'pid'), String(mock.pid))
      return { oldPid: mock.pid }
    },
    check: async ({ result, exit, log }) => {
      assert.equal(exit.code, 1, log)
      assert.equal(result.status, 'failed')
      assert.equal(result.error.code, 'MAIN_PID_UNCHANGED')
      assert.equal(result.newPid, 0)
    },
  })
})

await test('runner e2e: 等待期间 MainPID 变化时记录最终监听 PID', async () => {
  await runRunnerCase('e2e-pid-change', {
    healthTimeout: 8000,
    grace: 3000,
    behavior: (port, dataDir, runId) => {
      const dir = path.dirname(dataDir)
      const flip = path.join(dir, 'flip-pid.sh')
      fs.writeFileSync(
        flip,
        `#!/bin/bash
STATE="$1"; PORT="$2"; DATA="$3"; RUN="$4"
nohup ${JSON.stringify(NODE)} "$STATE/mock-web.mjs" "$PORT" "$DATA" "$RUN" 0 >/dev/null 2>&1 & p1=$!
echo $p1 > "$STATE/first-pid"
echo $p1 > "$STATE/pid"
sleep 1.5
kill $p1 2>/dev/null
sleep 0.2
nohup ${JSON.stringify(NODE)} "$STATE/mock-web.mjs" "$PORT" "$DATA" "$RUN" 1 >/dev/null 2>&1 & p2=$!
echo $p2 > "$STATE/pid"
`,
        { mode: 0o755 },
      )
      return 'nohup ' + JSON.stringify(flip) + ' ' + JSON.stringify(dir) + ' ' + port + ' ' + JSON.stringify(dataDir) + ' ' + JSON.stringify(runId) + ' >/dev/null 2>&1 & sleep 0.5'
    },
    check: async ({ result, exit, log, dir }) => {
      const firstPid = Number(fs.readFileSync(path.join(dir, 'first-pid'), 'utf8').trim())
      const listenerPid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim())
      assert.equal(exit.code, 0, log)
      assert.equal(result.status, 'done')
      assert.notEqual(listenerPid, firstPid)
      assert.equal(result.newPid, listenerPid)
      assert.match(result.steps.find((s) => s.id === 'ready').detail, new RegExp('pid ' + listenerPid))
    },
  })
})

await test('runner e2e: 兜底启动真实 dsh 形态进程仍能成功', async () => {
  await runRunnerCase('e2e-fallback-ok', {
    fallback: true,
    healthTimeout: 6000,
    grace: 2000,
    pidTimeout: 1000,
    behavior: () => 'exit 1',
    setup: async ({ dir, port, dataDir, runId, node }) => {
      const bin = path.join(dir, 'bin')
      fs.mkdirSync(bin, { recursive: true })
      fs.writeFileSync(
        path.join(bin, 'systemd-run'),
        `#!/bin/bash
while [ $# -gt 0 ]; do
  case "$1" in --*) shift ;; *) break ;; esac
done
exec "$@"
`,
        { mode: 0o755 },
      )
      const mockDsh = path.join(dir, 'dsh')
      fs.writeFileSync(
        mockDsh,
        `import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
const argv = process.argv.slice(2)
const value = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : ''
}
const port = Number(value('--port'))
const dataDir = value('--data-dir')
const runId = value('--run-id')
const stateDir = value('--state-dir')
const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok') })
server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(path.join(stateDir, 'pid'), String(process.pid))
  fs.writeFileSync(path.join(dataDir, 'boot.json'), JSON.stringify({
    runId,
    pid: process.pid,
    at: new Date().toISOString(),
    startedAtMs: Date.now() - 100,
  }))
})
`,
        { mode: 0o755 },
      )
      return {
        startCmd: [node, mockDsh, 'web', '--port', String(port), '--data-dir', dataDir, '--run-id', runId, '--state-dir', dir],
        env: { PATH: bin + ':' + (process.env.PATH || '') },
      }
    },
    check: async ({ result, exit, log, dir }) => {
      const listenerPid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim())
      assert.equal(exit.code, 0, log)
      assert.equal(result.status, 'done')
      assert.equal(result.fallback, true)
      assert.equal(result.degraded, false)
      assert.equal(result.newPid, listenerPid)
    },
  })
})

await test('runner e2e: 兜底不把无关 HTTP 监听者当成功', async () => {
  await runRunnerCase('e2e-fallback-foreign-listener', {
    fallback: true,
    healthTimeout: 5000,
    grace: 1000,
    pidTimeout: 1000,
    behavior: () => 'exit 1',
    setup: async ({ dir, port }) => {
      const stray = http.createServer((req, res) => {
        res.writeHead(200)
        res.end('not dsh')
      })
      await new Promise((resolve) => stray.listen(port, '127.0.0.1', resolve))
      const childPidFile = path.join(dir, 'fallback-child.pid')
      const startCmd = [
        NODE,
        '-e',
        "require('fs').writeFileSync(" + JSON.stringify(childPidFile) + ",String(process.pid));setTimeout(()=>{},15000)",
      ]
      return {
        startCmd,
        cleanup: async () => {
          try {
            const pid = Number(fs.readFileSync(childPidFile, 'utf8').trim())
            if (pid > 1) process.kill(pid, 'SIGKILL')
          } catch {}
          await new Promise((resolve) => stray.close(resolve))
        },
      }
    },
    check: async ({ result, exit, log }) => {
      assert.equal(exit.code, 1, log)
      assert.equal(result.status, 'failed')
      assert.equal(result.error.code, 'FALLBACK_FAILED')
      assert.equal(result.newPid, 0)
    },
  })
})

try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {}

console.log('')
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项：' + failures.map((f) => f.name).join('、'))
  process.exit(1)
}
console.log('通过 ' + passed + ' 项')
process.exit(0)
