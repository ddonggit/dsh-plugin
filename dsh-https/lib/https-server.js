import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';
import { sanitizeError } from './util.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function copyHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (name.toLowerCase().startsWith('x-forwarded-')) continue;
    if (name.toLowerCase() === 'forwarded') continue;
    if (name.toLowerCase() === 'x-real-ip') continue;
    out[name] = value;
  }
  return out;
}

function withSecureCookie(setCookie, enabled) {
  if (!enabled || !setCookie) return setCookie;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies.map((cookie) => {
    if (/;\s*secure\b/i.test(cookie)) return cookie;
    return `${cookie}; Secure`;
  });
}

function filterResponseHeaders(headers, addSecureCookie) {
  const out = copyHeaders(headers);
  if (out['set-cookie']) out['set-cookie'] = withSecureCookie(out['set-cookie'], addSecureCookie);
  return out;
}

function sendText(res, statusCode, text, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(text, 'utf8');
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function requestTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl || '/', 'http://placeholder.local');
  } catch {
    return null;
  }
  return `${parsed.pathname}${parsed.search}`;
}

function rawUpgradeHead(req, target) {
  const lines = [`${req.method || 'GET'} ${target} HTTP/1.1`];
  const raw = req.rawHeaders || [];
  let hasUpgrade = false;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    const lower = String(name).toLowerCase();
    if (lower === 'connection' || lower === 'keep-alive' || lower === 'proxy-connection') continue;
    // Keep the upgrade path consistent with the request path: never forward
    // client-supplied forwarding headers to the upstream.
    if (lower === 'forwarded' || lower === 'x-real-ip' || lower.startsWith('x-forwarded-')) continue;
    if (lower === 'upgrade') hasUpgrade = true;
    lines.push(`${name}: ${value}`);
  }
  lines.push('Connection: Upgrade');
  if (!hasUpgrade && req.headers.upgrade) lines.push(`Upgrade: ${req.headers.upgrade}`);
  lines.push('', '');
  return Buffer.from(lines.join('\r\n'), 'latin1');
}

export class HttpsProxyServer {
  constructor({ config, certStore, logger = console }) {
    this.config = config;
    this.certStore = certStore;
    this.logger = logger;
    this.server = null;
    this.sockets = new Set();
    this.agent = null;
    this.secureAgent = null;
    this.listenPort = null;
  }

  get port() {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : this.listenPort;
  }

  async start() {
    const pair = this.certStore.getDefaultPairForTls();
    if (!pair) throw new Error('没有可用的默认 TLS 证书');
    this.agent = new http.Agent({
      keepAlive: this.config.proxy.keepAlive,
      maxSockets: Math.max(32, this.config.proxy.maxConnections),
      maxFreeSockets: 32,
    });
    this.secureAgent = new https.Agent({
      keepAlive: this.config.proxy.keepAlive,
      maxSockets: Math.max(32, this.config.proxy.maxConnections),
      maxFreeSockets: 32,
    });

    this.server = https.createServer(
      {
        cert: pair.cert,
        key: pair.key,
        minVersion: 'TLSv1.2',
        ALPNProtocols: ['http/1.1'],
        handshakeTimeout: 15000,
        SNICallback: (servername, callback) => {
          try {
            callback(null, this.certStore.getContextForHostname(servername) || this.certStore.getDefaultContext());
          } catch (error) {
            callback(error);
          }
        },
      },
      (req, res) => this.handleRequest(req, res),
    );
    this.server.maxConnections = this.config.proxy.maxConnections;
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.server.on('connect', (req, socket) => this.handleConnect(req, socket));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server.on('tlsClientError', () => {
      // Common for port scanners and stale TLS sessions; never log handshake data.
    });
    this.server.on('clientError', (error, socket) => {
      if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    this.server.on('error', (error) => {
      this.logger.error?.(`[dsh-https] HTTPS 监听错误：${sanitizeError(error)}`);
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.config.listen.port, this.config.listen.host);
    });

    this.listenPort = this.port;
  }

  reloadDefault() {
    if (!this.server) return;
    const pair = this.certStore.getDefaultPairForTls();
    if (pair) this.server.setSecureContext({ cert: pair.cert, key: pair.key });
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
      try {
        server.closeAllConnections?.();
      } catch {
        // Ignore.
      }
      for (const socket of this.sockets) {
        try {
          socket.destroy();
        } catch {
          // Ignore.
        }
      }
      this.sockets.clear();
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
    });
    this.agent?.destroy();
    this.secureAgent?.destroy();
    this.agent = null;
    this.secureAgent = null;
  }

  upstreamRequestOptions(method, target, headers) {
    return {
      protocol: `${this.config.upstream.protocol}:`,
      host: this.config.upstream.host,
      port: this.config.upstream.port,
      method,
      path: target,
      headers,
      agent: this.config.upstream.protocol === 'https' ? this.secureAgent : this.agent,
    };
  }

  handleRequest(req, res) {
    const target = requestTarget(req.url);
    if (!target) {
      sendText(res, 400, 'Bad Request');
      return;
    }
    const transport = this.config.upstream.protocol === 'https' ? https : http;
    let upstreamReq;
    try {
      const headers = copyHeaders(req.headers);
      headers.connection = this.config.proxy.keepAlive ? 'keep-alive' : 'close';
      upstreamReq = transport.request(this.upstreamRequestOptions(req.method || 'GET', target, headers));
    } catch (error) {
      sendText(res, 502, `Bad Gateway: ${sanitizeError(error)}`);
      return;
    }

    upstreamReq.setTimeout(this.config.proxy.connectTimeoutMs, () => {
      upstreamReq.destroy(new Error('upstream timeout'));
    });
    upstreamReq.on('response', (upstreamRes) => {
      upstreamReq.setTimeout(0);
      if (res.writableEnded || res.destroyed) {
        upstreamRes.destroy();
        return;
      }
      try {
        res.writeHead(
          upstreamRes.statusCode || 502,
          upstreamRes.statusMessage,
          filterResponseHeaders(upstreamRes.headers, this.config.proxy.addSecureCookie),
        );
      } catch (error) {
        upstreamRes.destroy();
        res.destroy();
        return;
      }
      upstreamRes.on('error', () => res.destroy());
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', (error) => {
      if (res.writableEnded || res.destroyed) return;
      if (!res.headersSent) sendText(res, 502, `Bad Gateway: ${sanitizeError(error)}`);
      else res.destroy();
    });
    res.on('close', () => {
      if (!res.writableEnded) upstreamReq.destroy();
    });
    req.on('error', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  }

  handleUpgrade(req, socket, head) {
    const target = requestTarget(req.url);
    if (!target) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // WebSocket upgrades must follow the same transport as normal requests;
    // otherwise an HTTPS upstream would receive a plaintext handshake.
    const useTls = this.config.upstream.protocol === 'https';
    const upstream = useTls
      ? tls.connect({
          host: this.config.upstream.host,
          port: this.config.upstream.port,
          servername: net.isIP(this.config.upstream.host) ? undefined : this.config.upstream.host,
          ALPNProtocols: ['http/1.1'],
        })
      : net.connect({
          host: this.config.upstream.host,
          port: this.config.upstream.port,
        });
    upstream.setNoDelay(true);
    upstream.setTimeout(this.config.proxy.connectTimeoutMs, () => {
      upstream.destroy(new Error('upstream connect timeout'));
    });
    let connected = false;
    socket.pause();
    upstream.once(useTls ? 'secureConnect' : 'connect', () => {
      connected = true;
      upstream.setTimeout(0);
      try {
        upstream.write(rawUpgradeHead(req, target));
        if (head && head.length > 0) upstream.write(head);
      } catch (error) {
        upstream.destroy();
        socket.destroy();
        return;
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.resume();
    });
    upstream.on('error', (error) => {
      if (!connected && !socket.destroyed) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
      if (!socket.destroyed) socket.destroy();
    });
    upstream.on('close', () => {
      if (!socket.destroyed) socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  }

  handleConnect(req, socket) {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
}
