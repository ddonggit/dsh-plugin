// 进程 / 端口 / HTTP 探测：重启链路的"眼睛"。
// 红线：任何 kill 之前都必须确认目标是 dsh web，且只按目标端口定位，绝不按进程名扫。
import fs from 'node:fs'

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  try {
    return fs.readFileSync('/proc/' + Number(pid) + '/cmdline', 'utf8').split('\0').filter(Boolean)
  } catch {
    return []
  }
}

// 启动形态：
//   node <...>/.bin/dsh --profile web --host 127.0.0.1 --port 3081
//   node <...>/@deepseek-ai/dsh/lib/bin.js web --trusted-host ...
// 只认 dsh 主程序 + web 形态；拒绝误杀 node server.mjs 之类同端口进程。
// cgroup 是否属于目标 systemd 服务。unit 可以写成 foo 或 foo.service。
// 用完整单元名匹配，不能只认 dsh-*：DSH_RESTART_UNIT 支持自定义单元。
export function cgroupHasUnit(cgroup, unit) {
  const raw = String(unit || '').trim()
  if (!raw) return false
  const service = raw.endsWith('.service') ? raw : raw + '.service'
  const escaped = service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(?:^|/)' + escaped + '(?:/|$)', 'm').test(String(cgroup || ''))
}

export function isDshWebPid(pid) {
  const argv = readCmdline(pid)
  if (!argv.length) return false
  const isDsh = argv.slice(0, 2).some((x) => /(?:^|\/)dsh$/.test(x) || /@deepseek-ai\/dsh\//.test(x))
  if (!isDsh) return false
  if (argv.indexOf('web') >= 0) return true
  if (argv.indexOf('--profile') >= 0 && (argv.indexOf('--port') >= 0 || argv.indexOf('--host') >= 0)) return true
  return false
}

// 目标端口上的 LISTEN 进程（IPv4 + IPv6）。找不到返回 0。
export function findPidByPort(port) {
  const want = Number(port)
  if (!want) return 0
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

// dsh web 带 BrowserAuth：无 token 的 GET / 返回 401 也是"在线"。
// 判定只看服务端是否 5xx 或连不上。
export async function httpProbe(url, timeoutMs) {
  const timeout = Number(timeoutMs) || 3000
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeout) })
    if (res.status < 500) return { ok: true, status: res.status }
    return { ok: false, status: res.status, error: 'HTTP ' + res.status }
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.code) || (e && e.name) || String((e && e.message) || e) }
  }
}
