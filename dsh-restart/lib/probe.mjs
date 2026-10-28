// 服务探测：判断「新实例是不是已经能用了」。
//
// 旧实现只发一个 http://127.0.0.1:<port>/ 请求，于是遇到两种部署就误判：
//   · 绑的是具体网卡（10.1.0.2），回环口根本没监听 → ECONNREFUSED
//   · 自己终止 TLS（https），用 http 探测 → 协议不匹配
// 这里先做 TCP 连接（只关心端口是否在监听），再尽量补一次 HTTP(S) 探测拿状态码：
//   · 有 HTTP 响应且 < 500 → 在线
//   · 有 HTTP 响应但 >= 500 → 不健康
//   · HTTP 探测出错（TLS/cert/超时等）但 TCP 通 → 仍然在线，只记录探测方式为 tcp
// 对 IP 字面量上的 HTTPS 放宽证书校验：证书是签给域名的，拿绑定 IP 探测必然不匹配。
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { isIpLiteral, stripBrackets } from './environment.mjs'

export function tcpProbe(host, port, timeoutMs) {
  const timeout = Math.max(500, Number(timeoutMs) || 3000)
  const target = stripBrackets(host)
  const numeric = Number(port) || 0
  if (!target || !numeric) return Promise.resolve({ ok: false, error: 'bad-target' })
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host: target, port: numeric })
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeout)
    socket.once('connect', () => finish({ ok: true }))
    socket.once('error', (e) => finish({ ok: false, error: String((e && (e.code || e.message)) || 'error') }))
  })
}

export function httpProbe(url, timeoutMs, options) {
  const timeout = Math.max(500, Number(timeoutMs) || 3000)
  const opts = options || {}
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return Promise.resolve({ ok: false, error: 'bad-url' })
  }
  const secure = parsed.protocol === 'https:'
  const mod = secure ? https : http
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const request = mod.request(
      parsed,
      {
        method: 'GET',
        headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
        rejectUnauthorized: opts.rejectUnauthorized !== false,
      },
      (res) => {
        const status = Number(res.statusCode) || 0
        res.resume()
        res.on('end', () => finish({ ok: status > 0 && status < 500, status, error: status >= 500 ? 'HTTP ' + status : '' }))
        res.on('error', (e) => finish({ ok: false, status, error: String((e && (e.code || e.message)) || e) }))
      },
    )
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })))
    request.on('error', (e) => finish({ ok: false, error: String((e && (e.code || e.message)) || e) }))
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })), timeout)
    request.end()
  })
}

function lenientTls(url) {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === 'https:' && isIpLiteral(parsed.hostname)
  } catch {
    return false
  }
}

// 返回 { ok, via: 'tcp'|'http', status?, detail?, error? }
export async function probeService({ host, port, url, timeout }) {
  const target = stripBrackets(host)
  const numeric = Number(port) || 0
  const tcp = await tcpProbe(target, numeric, timeout)
  if (!tcp.ok) {
    return {
      ok: false,
      via: 'tcp',
      error: tcp.error,
      detail: 'TCP ' + (target || '?') + ':' + (numeric || '?') + ' ' + (tcp.error || 'failed'),
    }
  }
  if (!url) return { ok: true, via: 'tcp', detail: 'TCP ' + target + ':' + numeric + ' 已连通' }
  const res = await httpProbe(url, timeout, { rejectUnauthorized: !lenientTls(url) })
  if (res.status) {
    if (res.ok) return { ok: true, via: 'http', status: res.status, detail: 'HTTP ' + res.status }
    return { ok: false, via: 'http', status: res.status, error: res.error, detail: 'HTTP ' + res.status }
  }
  // TCP 已在监听，但 HTTP 探测没拿到响应（TLS 校验、代理、冷启动等）：不据此判失败。
  return {
    ok: true,
    via: 'tcp',
    detail: 'TCP ' + target + ':' + numeric + ' 已连通；HTTP 探测未完成（' + (res.error || 'unknown') + '）',
  }
}
