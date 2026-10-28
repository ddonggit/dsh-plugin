// 磁盘状态仓库：宿主半与执行器共用同一份布局，但「谁写」是明确分工的——
//   run.json 只由执行器推进阶段；宿主只在执行器心跳消失后补写终态（recover）。
//   heartbeat/lock 由执行器维护；boot.json 只由新实例自己在 apply 时写。
import fs from 'node:fs'
import path from 'node:path'
import {
  appendHistory,
  atomicWriteJson,
  errorOf,
  isActive,
  readJson,
  readTextTail,
} from './state.mjs'
import { pidAlive } from './proc.mjs'

export const STALE_HEARTBEAT_MS = 45000
export const LAUNCH_TIMEOUT_MS = 25000
export const HISTORY_LIMIT = 12

export function createStore(dataDir, options) {
  const opts = options || {}
  const dir = path.resolve(dataDir)
  const files = {
    run: path.join(dir, 'run.json'),
    boot: path.join(dir, 'boot.json'),
    heartbeat: path.join(dir, 'heartbeat.json'),
    lock: path.join(dir, 'lock.json'),
    history: path.join(dir, 'history.json'),
    log: path.join(dir, 'runner.log'),
  }

  const store = {
    dir,
    files,

    ensure() {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      } catch {}
    },

    readRun() {
      return readJson(files.run, null)
    },

    writeRun(run) {
      if (!run) return null
      run.updatedAt = new Date().toISOString()
      atomicWriteJson(files.run, run)
      return run
    },

    readBoot() {
      return readJson(files.boot, null)
    },

    writeBoot(boot) {
      atomicWriteJson(files.boot, boot)
      return boot
    },

    readHeartbeat() {
      return readJson(files.heartbeat, null)
    },

    writeHeartbeat(run, step) {
      if (!run) return
      atomicWriteJson(files.heartbeat, {
        runId: run.runId,
        pid: run.runnerPid || 0,
        step: step || '',
        at: Date.now(),
      })
    },

    removeHeartbeat() {
      try {
        fs.rmSync(files.heartbeat, { force: true })
      } catch {}
    },

    readLock() {
      return readJson(files.lock, null)
    },

    writeLock(lock) {
      atomicWriteJson(files.lock, lock)
      return lock
    },

    removeLock() {
      try {
        fs.rmSync(files.lock, { force: true })
      } catch {}
    },

    readHistory() {
      const list = readJson(files.history, [])
      return Array.isArray(list) ? list : []
    },

    logTail(maxBytes) {
      return readTextTail(files.log, Number(maxBytes) || 6000)
    },

    // 终态写盘 + 历史。执行器和宿主共用，runId 去重。
    recordTerminal(run, completedBy) {
      if (!run) return run
      run.completedBy = completedBy || run.completedBy || ''
      run.finishedAt = run.finishedAt || new Date().toISOString()
      store.writeRun(run)
      const startedAt = Date.parse(run.startedAt || '') || 0
      appendHistory(
        files.history,
        {
          runId: run.runId,
          at: run.finishedAt,
          ok: run.status === 'done',
          status: run.status,
          ms: startedAt ? Date.parse(run.finishedAt) - startedAt : 0,
          attempts: Number(run.attempt) || 0,
          fallback: !!run.fallback,
          degraded: !!run.degraded,
          oldPid: Number(run.oldPid) || 0,
          newPid: Number(run.newPid) || 0,
          completedBy: run.completedBy,
          code: run.error ? run.error.code : '',
        },
        HISTORY_LIMIT,
      )
      // 只清理本轮自己的锁与心跳。旧执行器晚到时不得误删新一轮的状态。
      const lock = store.readLock()
      if (!lock || !lock.runId || lock.runId === run.runId) store.removeLock()
      const heartbeat = store.readHeartbeat()
      if (!heartbeat || !heartbeat.runId || heartbeat.runId === run.runId) store.removeHeartbeat()
      return run
    },

    // 宿主拉起执行器失败：直接以 LAUNCH_TIMEOUT 收尾，别让状态停在 queued。
    failLaunch(run, detail) {
      if (!run) return run
      run.status = 'failed'
      run.error = errorOf('LAUNCH_TIMEOUT', '执行器没有启动', String(detail || ''))
      run.completedBy = 'host'
      run.finishedAt = new Date().toISOString()
      const active = Array.isArray(run.steps) ? run.steps.find((s) => s && s.status === 'active') : null
      if (active) {
        active.status = 'failed'
        active.finishedAt = run.finishedAt
        active.ms = active.startedAt ? Date.parse(run.finishedAt) - Date.parse(active.startedAt) : 0
      }
      store.recordTerminal(run, 'host')
      return run
    },

    // 执行器心跳消失后的收尾。返回可能被改写过的 run。
    //   · 本进程是新起的实例（oldPid ≠ 自己，且自己启动得比 run 晚）⇒ 重启实际成功，补写 done；
    //   · 否则（本进程没被换掉）⇒ failed / RUNNER_LOST，按钮可以重试。
    recover(logger) {
      const run = store.readRun()
      if (!run || !isActive(run)) return run

      const now = Date.now()
      const startedAt = Date.parse(run.startedAt || '') || 0
      const heartbeat = store.readHeartbeat()
      const heartbeatAt = heartbeat && heartbeat.runId === run.runId ? Number(heartbeat.at) || 0 : 0
      const lock = store.readLock()
      const lockPid = lock && lock.runId === run.runId ? Number(lock.pid) || 0 : 0
      const runnerAlive = lockPid > 0 && pidAlive(lockPid)

      const silence = heartbeatAt ? now - heartbeatAt : (startedAt ? now - startedAt : Number.MAX_SAFE_INTEGER)
      const limit = heartbeatAt ? STALE_HEARTBEAT_MS : LAUNCH_TIMEOUT_MS
      if (silence <= limit) return run
      // 进程还在但心跳停了：可能只是被调度拖慢，给到 2 倍窗口再判死。
      if (runnerAlive && silence < STALE_HEARTBEAT_MS * 2) return run

      const bootedAt = Number(opts.bootedAt) || (Date.now() - Math.round(process.uptime() * 1000))
      const replaced = Number(run.oldPid) > 0 && Number(run.oldPid) !== process.pid && startedAt > 0 && startedAt < bootedAt

      if (replaced) {
        run.status = 'done'
        run.newPid = process.pid
        run.note = '新进程已接管；执行器没来得及写终态（心跳中断），由宿主补写。'
        run.error = null
        run.completedBy = 'host'
        run.finishedAt = new Date().toISOString()
        if (run.steps && Array.isArray(run.steps)) {
          for (const step of run.steps) {
            if (step.status === 'active' || step.status === 'pending') {
              step.status = 'done'
              step.finishedAt = step.finishedAt || run.finishedAt
              step.ms = step.ms || (step.startedAt ? Date.parse(step.finishedAt) - Date.parse(step.startedAt) : 0)
            }
          }
        }
      } else {
        run.status = 'failed'
        run.error = errorOf(
          heartbeatAt ? 'RUNNER_LOST' : 'LAUNCH_TIMEOUT',
          heartbeatAt ? '执行器心跳中断，且本进程未被替换' : '执行器没有启动，重启未发生',
          '最后心跳 ' + (heartbeatAt ? new Date(heartbeatAt).toISOString() : '无') + '；本进程 PID ' + process.pid,
        )
        run.completedBy = 'host'
        run.finishedAt = new Date().toISOString()
        const active = Array.isArray(run.steps) ? run.steps.find((s) => s && s.status === 'active') : null
        if (active) {
          active.status = 'failed'
          active.finishedAt = run.finishedAt
          active.ms = active.startedAt ? Date.parse(run.finishedAt) - Date.parse(active.startedAt) : 0
        }
      }

      store.recordTerminal(run, 'host')
      try {
        logger?.warn?.(
          '[dsh-restart] 陈旧重启状态已收尾: ' +
            run.runId +
            ' → ' +
            run.status +
            '（' +
            (replaced ? '新进程 ' + process.pid : '本进程未被替换') +
            '）',
        )
      } catch {}
      return run
    },
  }

  return store
}
