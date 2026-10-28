// 运行环境探测：把「dsh web 是怎么被拉起来的」这件事从代码里的硬编码假设，变成运行时事实。
//
// 目标：同一个安装包在下面这些机器上都能工作——
//   · systemd 服务（单元名任意，system 或 user 管理器）
//   · 裸进程 / tmux / nohup / 容器（没有 systemd，直接重启）
//   · HTTP 或 HTTPS、回环或具体网卡 / IPv6
// 探测失败时宁可退化为「直接重启」，也不要因为假设不成立而拒绝服务。
import fs from 'node:fs'
import net from 'node:net'

export const MODES = ['auto', 'systemd', 'direct']
export const MANAGERS = ['system', 'user']

export function readCgroupText() {
  try {
    return fs.readFileSync('/proc/self/cgroup', 'utf8')
  } catch {
    return ''
  }
}

// 从 cgroup 里取「最后一个 .service」：
//   /system.slice/dsh-web.service                                   → dsh-web.service / system
//   /user.slice/user-1000.slice/user@1000.service/app.slice/x.service → x.service / user
//   /system.slice/docker-abc.scope                                  → 无（scope 没有可重启的单元）
const UNIT_NAME = /^[A-Za-z0-9:_.@\\-]+$/

export function parseCgroupUnit(text) {
  const raw = String(text || '')
  let unit = ''
  let manager = 'system'
  for (const line of raw.split('\n')) {
    const parts = line.split(':')
    if (parts.length < 3) continue
    const cgroup = parts.slice(2).join(':')
    const found = cgroup.match(/\/[^/]*\.service(?:\/|$)/g)
    if (!found || !found.length) continue
    const name = found[found.length - 1].replace(/^\//, '').replace(/\/$/, '')
    if (!UNIT_NAME.test(name)) continue
    // user@1000.service 是用户管理器本身，不是可重启的业务单元；遇到它说明进程
    // 直接挂在管理器下面，按"没有单元"处理，绝不能去 restart 它。
    if (/^user@[^/]*\.service$/.test(name)) {
      unit = ''
      manager = 'user'
      continue
    }
    unit = name
    manager = /(^|\/)(user@[^/]+|user\.slice)/.test(cgroup) ? 'user' : 'system'
  }
  return { unit, manager }
}

// 绑 0.0.0.0 会被 dsh 拒绝，但历史配置/未来版本可能残留；探测时统一落到回环。
export function normalizeHost(host) {
  let value = String(host === undefined || host === null ? '' : host).trim()
  if (!value) return '127.0.0.1'
  const zone = value.indexOf('%')
  if (zone > 0) value = value.slice(0, zone)
  if (value[0] === '[' && value[value.length - 1] === ']') value = value.slice(1, -1)
  if (value === '0.0.0.0' || value === '::') return '127.0.0.1'
  return value
}

export function stripBrackets(host) {
  const value = String(host || '').trim()
  return value[0] === '[' && value[value.length - 1] === ']' ? value.slice(1, -1) : value
}

export function isIpLiteral(host) {
  const value = stripBrackets(host)
  return net.isIP(value) !== 0
}

export function hostForUrl(host) {
  const value = stripBrackets(host)
  return value.indexOf(':') >= 0 ? '[' + value + ']' : value
}

function httpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : ''
}

// 探测优先用「本机自己能看到的口」：绑定地址 + 端口。公网 URL 可能没有 NAT 回环，
// 只能作为兜底；展示用的 --public-url 不应该决定重启成功与否。
export function resolveProbeUrl({ origin, advertised, host, port }) {
  const local = httpUrl(origin)
  if (local) return local
  const publicUrl = httpUrl(advertised)
  if (publicUrl) return publicUrl
  const value = normalizeHost(host)
  const numeric = Number(port) || 0
  return numeric ? 'http://' + hostForUrl(value) + ':' + numeric + '/' : ''
}

export function decideMode({ requested, unit, unitSource, hasSystemctl }) {
  const pref = MODES.indexOf(requested) >= 0 ? requested : 'auto'
  if (pref !== 'auto') return { mode: pref, reason: 'explicit' }
  if (unit && hasSystemctl) {
    return { mode: 'systemd', reason: unitSource === 'cgroup' ? 'cgroup-unit' : 'configured-unit' }
  }
  return { mode: 'direct', reason: unit ? 'systemctl-missing' : 'no-unit' }
}

// 只有「被 systemd 托管」时才需要把执行器搬出 cgroup。
export function needsIsolation({ mode, unit, hasSystemctl }) {
  if (mode === 'systemd') return true
  return !!(unit && hasSystemctl)
}

export function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

export function normalizeMode(value) {
  const text = String(value || '').trim().toLowerCase()
  if (text === 'systemd') return 'systemd'
  if (text === 'direct') return 'direct'
  return 'auto'
}

export function normalizeManager(value) {
  const text = String(value || '').trim().toLowerCase()
  if (text === 'user') return 'user'
  if (text === 'system') return 'system'
  return ''
}

export function managerArgs(manager) {
  return manager === 'user' ? ['--user'] : []
}
