// 进程 / 端口 / 命令行探测：重启链路的"眼睛"。
// 红线：任何 kill 之前都必须确认目标是 dsh web，且只按目标端口定位，绝不按进程名扫。
//
// 可移植性：
//   · Linux 优先读 /proc（快、无外部命令）
//   · 没有 /proc 的系统（macOS 等）退回 lsof / ss / ps
//   · 只做只读探测；找不到返回 0 / 空，由上层决定是否失败
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HAS_PROC = fs.existsSync('/proc/net/tcp') || fs.existsSync('/proc/net/tcp6')

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function which(bin) {
  const name = String(bin || '').trim()
  if (!name) return ''
  if (name.indexOf('/') >= 0) return fs.existsSync(name) ? name : ''
  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .concat(process.platform === 'win32' ? [] : ['/usr/bin', '/bin', '/usr/local/bin', '/usr/sbin', '/sbin'])
  const exts = process.platform === 'win32' ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {}
    }
  }
  return ''
}

function execTrim(cmd, args) {
  try {
    return String(execFileSync(cmd, args, { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim()
  } catch {
    return ''
  }
}

export function pidAlive(pid) {
  const n = Number(pid)
  if (!n || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    return !!(e && e.code === 'EPERM')
  }
}

export function readCmdline(pid) {
  const n = Number(pid)
  if (!n || n <= 0) return []
  try {
    const argv = fs.readFileSync('/proc/' + n + '/cmdline', 'utf8').split('\0').filter(Boolean)
    if (argv.length) return argv
  } catch {}
  if (HAS_PROC) return []
  // 非 Linux：ps 的 command 列没有 \0 分隔，按空白切分；只用于识别 dsh web 形态。
  const ps = which('ps')
  if (!ps) return []
  const text = execTrim(ps, ['-p', String(n), '-o', 'command='])
  return text ? text.split(/\s+/).filter(Boolean) : []
}

// 启动形态：
//   node <...>/.bin/dsh --profile web --host 127.0.0.1 --port 3081
//   node <...>/@deepseek-ai/dsh/lib/bin.js web --trusted-host ...
// 只认 dsh 主程序 + web 形态；拒绝误杀 node server.mjs 之类同端口进程。
export function isDshWebPid(pid) {
  const argv = readCmdline(pid)
  if (!argv.length) return false
  const isDsh = argv.slice(0, 2).some((x) => /(?:^|\/)dsh$/.test(x) || /@deepseek-ai\/dsh\//.test(x) || /(?:^|\/)dsh\.js$/.test(x))
  if (!isDsh) return false
  if (argv.indexOf('web') >= 0) return true
  if (argv.indexOf('--profile') >= 0 && (argv.indexOf('--port') >= 0 || argv.indexOf('--host') >= 0)) return true
  return false
}

// cgroup 是否属于目标 systemd 服务。unit 可以写成 foo 或 foo.service。
// 用完整单元名匹配，不能只认 dsh-*：DSH_RESTART_UNIT 支持自定义单元。
export function cgroupHasUnit(cgroup, unit) {
  const raw = String(unit || '').trim()
  if (!raw) return false
  const service = raw.endsWith('.service') ? raw : raw + '.service'
  const escaped = service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(?:^|/)' + escaped + '(?:/|$)', 'm').test(String(cgroup || ''))
}

// 目标端口上的 LISTEN 进程（IPv4 + IPv6）。找不到返回 0。
export function findPidByPort(port) {
  const want = Number(port)
  if (!want) return 0
  if (HAS_PROC) return findPidByPortProc(want)
  return findPidByPortCommand(want)
}

function findPidByPortProc(want) {
  const hexPort = want.toString(16).toUpperCase().padStart(4, '0')
  const inodes = new Set()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/)
      if (parts.length < 10) continue
      if (parts[3] !== '0A') continue // TCP_LISTEN
      const colon = parts[1].lastIndexOf(':')
      if (colon < 0 || parts[1].slice(colon + 1) !== hexPort) continue
      inodes.add(parts[9])
    }
  }
  if (!inodes.size) return 0
  let entries = []
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    let fds = []
    try {
      fds = fs.readdirSync('/proc/' + pid + '/fd')
    } catch {
      continue
    }
    for (const fd of fds) {
      let link = ''
      try {
        link = fs.readlinkSync('/proc/' + pid + '/fd/' + fd)
      } catch {
        continue
      }
      if (link.indexOf('socket:[') !== 0) continue
      if (inodes.has(link.slice(8, -1))) return pid
    }
  }
  return 0
}

function findPidByPortCommand(want) {
  const lsof = which('lsof')
  if (lsof) {
    const out = execTrim(lsof, ['-nP', '-iTCP:' + want, '-sTCP:LISTEN', '-t'])
    for (const line of out.split('\n')) {
      const pid = Number(line.trim())
      if (pid > 0) return pid
    }
  }
  const ss = which('ss')
  if (ss) {
    const out = execTrim(ss, ['-lntp', 'sport = :' + want])
    const match = /pid=(\d+)/.exec(out)
    if (match) return Number(match[1]) || 0
  }
  const netstat = which('netstat')
  if (netstat && process.platform === 'win32') {
    // Windows: netstat -ano -p tcp 的 LISTENING 行，最后一段是 PID。
    const out = execTrim(netstat, ['-ano', '-p', 'tcp'])
    for (const line of out.split('\n')) {
      if (!/LISTENING/i.test(line)) continue
      const cols = line.trim().split(/\s+/)
      if (cols.length < 5) continue
      const local = cols[1]
      if (!local || local.slice(local.lastIndexOf(':') + 1) !== String(want)) continue
      const pid = Number(cols[cols.length - 1])
      if (pid > 0) return pid
    }
  }
  return 0
}
