// 状态记录与磁盘工具：宿主半与执行器共用的纯逻辑。
// 约定：一个 run 只有一份 JSON；所有写入走原子替换，读方永远看到完整 JSON。
import fs from 'node:fs'
import path from 'node:path'

export const ACTIVE_STATUS = ['queued', 'preflight', 'restarting', 'waiting']
export const TERMINAL_STATUS = ['done', 'failed']

export const STEP_DEFS = [
  { id: 'preflight', label: '环境预检', hint: '单元可重启、执行器已脱离 dsh-web cgroup' },
  { id: 'restart', label: '重启服务', hint: 'systemctl restart 并取得新的 MainPID' },
  { id: 'ready', label: '等待就绪', hint: '新实例回报启动标记并通过 HTTP 探测' },
  { id: 'verify', label: '校验监听', hint: '监听端口的进程必须是新的 MainPID' },
]

// 失败码：前端直接展示 message/hint，不再猜日志。
export const ERRORS = {
  BUSY: { message: '已有重启正在进行', hint: '等当前这轮结束（通常 5–15 秒）再试。' },
  COOLDOWN: { message: '触发过于频繁', hint: '等 3 秒后再点，避免连点造成多轮重启。' },
  INVALID_BODY: { message: '请求体不是合法 JSON', hint: '使用 JSON 请求体，并带上 {"action":"restart"}。' },
  INVALID_ACTION: { message: '不支持的操作', hint: '重启接口只接受 action=restart。' },
  UNIT_NOT_FOUND: { message: '找不到 systemd 单元', hint: '用 systemctl status <unit> 确认单元名，或用 DSH_RESTART_UNIT 指定。' },
  NO_SYSTEMCTL: { message: '找不到 systemctl', hint: '本机没有可用的 systemd 控制命令，无法受控重启；可改用直接重启模式。' },
  NO_START_COMMAND: {
    message: '没有可用的启动命令',
    hint: '直接重启需要能重建 dsh web 的启动命令；检查启动方式，或用 DSH_RESTART_START_CMD 指定 JSON 数组。',
  },
  DIRECT_TARGET_UNSAFE: {
    message: '无法确认要停止的进程是 dsh web',
    hint: '为安全起见没有 kill。用端口和进程检查确认后重试，或改用 systemd 模式。',
  },
  DIRECT_RESTART_FAILED: {
    message: '直接重启没有拉起新实例',
    hint: '看执行器日志里启动命令的输出，以及端口是否被其他进程占用。',
  },
  NOT_ISOLATED: { message: '执行器无法脱离 dsh-web cgroup', hint: '重启会把执行器自己一起杀掉，已主动放弃；请从设置页触发，或确认 systemd-run 可用。' },
  UNIT_RESTART_FAILED: { message: 'systemctl 重启失败', hint: '看 systemctl status 与 journalctl -u <unit> -n 50 的报错。' },
  UNIT_RESTART_TIMEOUT: { message: 'systemctl restart 超时', hint: '通常是旧进程停止超时；检查 TimeoutStopSec 与进程是否卡住。' },
  NO_MAIN_PID: { message: '重启后没有 MainPID', hint: '单元可能启动即退出；看 journalctl -u <unit> -n 50。' },
  MAIN_PID_UNCHANGED: { message: '重启后 MainPID 没有变化', hint: 'systemctl 返回成功但实例未替换；检查 unit 的 ExecStart/Type 以及是否存在 no-op restart。' },
  READY_TIMEOUT: { message: '新实例在超时内没有就绪', hint: '端口没响应：看执行器日志和服务单元日志。' },
  HANDSHAKE_TIMEOUT: { message: 'HTTP 已通，但新实例没有回报启动标记', hint: '新进程可能没加载到本插件；重启后刷新页面，或检查插件是否被禁用。' },
  VERIFY_LISTENER_MISMATCH: { message: '监听端口的不是新的 MainPID', hint: '端口上还有旧实例或旁路进程；先清理 3081 上的残留进程再重试。' },
  FALLBACK_FAILED: { message: '兜底裸启动也失败', hint: 'systemd 链路与直接启动都没能把服务拉起来，需要手工排查。' },
  RUNNER_LOST: { message: '执行器心跳中断', hint: '执行器可能被连带杀掉或崩溃；服务是否恢复请看当前进程与页面连接。' },
  LAUNCH_TIMEOUT: { message: '执行器没有启动', hint: 'systemd-run 未能拉起执行器；检查 systemd-run 是否可用。' },
  RUNNER_MISSING: { message: '插件文件不完整', hint: '安装包里缺少 lib/restart-runner.mjs，重新安装插件。' },
  CRASH: { message: '执行器内部异常', hint: '见错误详情与执行器日志，可重试。' },
}

export function isActive(run) {
  return !!run && ACTIVE_STATUS.indexOf(run.status) >= 0
}

export function isTerminal(run) {
  return !!run && TERMINAL_STATUS.indexOf(run.status) >= 0
}

export function makeSteps() {
  return STEP_DEFS.map((d) => ({
    id: d.id,
    label: d.label,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    ms: 0,
    detail: '',
  }))
}

export function newRun(options) {
  const o = options || {}
  const now = new Date().toISOString()
  return {
    v: 1,
    runId: o.runId || '',
    mode: o.mode || '',
    manager: o.manager || '',
    unit: o.unit || '',
    unitSource: o.unitSource || '',
    host: o.host || '',
    port: Number(o.port) || 0,
    healthUrl: o.healthUrl || '',
    status: 'queued',
    attempt: 0,
    maxAttempts: Number(o.maxAttempts) || 3,
    oldPid: Number(o.oldPid) || 0,
    newPid: 0,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
    triggeredBy: o.triggeredBy || 'web',
    clientRequestId: o.clientRequestId ? cap(String(o.clientRequestId), 128) : '',
    runnerPid: 0,
    fallback: false,
    degraded: false,
    steps: makeSteps(),
    attempts: [],
    error: null,
    note: '',
    completedBy: '',
  }
}

export function stepOf(run, id) {
  if (!run || !Array.isArray(run.steps)) return null
  return run.steps.find((s) => s && s.id === id) || null
}

export function activeStep(run) {
  if (!run || !Array.isArray(run.steps)) return null
  return run.steps.find((s) => s && s.status === 'active') || null
}

export function startStep(run, id, detail) {
  const step = stepOf(run, id)
  if (!step) return run
  step.status = 'active'
  step.startedAt = new Date().toISOString()
  step.finishedAt = null
  step.ms = 0
  if (detail !== undefined) step.detail = String(detail)
  return run
}

export function finishStep(run, id, status, detail) {
  const step = stepOf(run, id)
  if (!step) return run
  step.status = status || 'done'
  step.finishedAt = new Date().toISOString()
  step.ms = step.startedAt ? Date.now() - Date.parse(step.startedAt) : 0
  if (detail !== undefined) step.detail = String(detail)
  return run
}

export function resetSteps(run, ids) {
  if (!run || !Array.isArray(run.steps)) return run
  for (const step of run.steps) {
    if (ids.indexOf(step.id) < 0) continue
    step.status = 'pending'
    step.startedAt = null
    step.finishedAt = null
    step.ms = 0
    step.detail = ''
  }
  return run
}

export function stepElapsedMs(step, now) {
  if (!step) return 0
  if (step.ms) return step.ms
  if (step.status === 'active' && step.startedAt) return Math.max(0, (now || Date.now()) - Date.parse(step.startedAt))
  return 0
}

export function errorOf(code, message, detail) {
  const base = ERRORS[code] || { message: '重启失败', hint: '' }
  return {
    code: code || 'UNKNOWN',
    message: message || base.message,
    hint: base.hint || '',
    detail: cap(detail || '', 500),
    at: new Date().toISOString(),
  }
}

export function cap(value, max) {
  const s = String(value === undefined || value === null ? '' : value)
  return s.length > max ? s.slice(0, max) + '…' : s
}

// ── 原子写 ────────────────────────────────────────────────────────────────
let tmpSeq = 0

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {}
}

export function atomicWriteText(file, text) {
  ensureDir(path.dirname(file))
  const tmp = file + '.' + process.pid + '.' + ++tmpSeq + '.tmp'
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    try {
      fs.writeFileSync(file, text, { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }
}

export function atomicWriteJson(file, value) {
  return atomicWriteText(file, JSON.stringify(value, null, 2))
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// 只读文件尾部：执行器日志可能很大，状态接口不能整份读。
export function readTextTail(file, maxBytes) {
  const limit = Number(maxBytes) || 4096
  let fd
  try {
    const stat = fs.statSync(file)
    if (!stat.size) return ''
    const start = Math.max(0, stat.size - limit)
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
  }
}

// 历史按 runId 去重、最新在前，容量固定。
export function appendHistory(file, entry, limit) {
  const max = Number(limit) || 12
  const list = readJson(file, [])
  const rows = Array.isArray(list) ? list.filter((x) => x && x.runId !== entry.runId) : []
  const next = [entry].concat(rows).slice(0, max)
  atomicWriteJson(file, next)
  return next
}

export function parseCmdArgs(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim()
  if (!raw) return []
  if (raw[0] === '[') {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.map(String).filter(Boolean)
    } catch {}
  }
  return raw.split(/\s+/).filter(Boolean)
}

// 只下发前端需要的字段，并限制长度，避免状态接口被日志撑爆。
export function sanitizeRun(run) {
  if (!run || typeof run !== 'object') return null
  const steps = Array.isArray(run.steps)
    ? run.steps.slice(0, 8).map((s) => ({
        id: String(s.id || ''),
        label: String(s.label || ''),
        status: String(s.status || 'pending'),
        startedAt: s.startedAt || null,
        finishedAt: s.finishedAt || null,
        ms: Number(s.ms) || 0,
        detail: cap(s.detail || '', 240),
      }))
    : []
  const attempts = Array.isArray(run.attempts)
    ? run.attempts.slice(-8).map((a) => ({
        n: Number(a.n) || 0,
        ok: !!a.ok,
        at: a.at || null,
        ms: Number(a.ms) || 0,
        code: String(a.code || ''),
        detail: cap(a.detail || '', 200),
      }))
    : []
  return {
    runId: String(run.runId || ''),
    status: String(run.status || ''),
    mode: String(run.mode || ''),
    manager: String(run.manager || ''),
    unit: String(run.unit || ''),
    unitSource: String(run.unitSource || ''),
    host: String(run.host || ''),
    port: Number(run.port) || 0,
    attempt: Number(run.attempt) || 0,
    maxAttempts: Number(run.maxAttempts) || 0,
    oldPid: Number(run.oldPid) || 0,
    newPid: Number(run.newPid) || 0,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    updatedAt: run.updatedAt || null,
    triggeredBy: String(run.triggeredBy || ''),
    clientRequestId: cap(run.clientRequestId || '', 128),
    runnerPid: Number(run.runnerPid) || 0,
    fallback: !!run.fallback,
    degraded: !!run.degraded,
    completedBy: String(run.completedBy || ''),
    note: cap(run.note || '', 300),
    steps,
    attempts,
    error: run.error
      ? {
          code: String(run.error.code || ''),
          message: cap(run.error.message || '', 200),
          hint: cap(run.error.hint || '', 240),
          detail: cap(run.error.detail || '', 400),
          at: run.error.at || null,
        }
      : null,
  }
}
