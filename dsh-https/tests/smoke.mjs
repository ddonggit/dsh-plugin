import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { rm } from 'node:fs/promises';
import { normalizeConfig } from '../lib/config.js';
import { CertStore } from '../lib/certs.js';
import { HttpsProxyServer } from '../lib/https-server.js';

const upstream = http.createServer((req, res) => {
  if (req.url === '/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: one\n\n');
    setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 120);
    return;
  }
  if (req.url === '/cookie') {
    res.writeHead(200, { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/; Secure; HttpOnly'], 'content-type': 'text/plain' });
    res.end('cookie');
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream-host': req.headers.host || '' });
    res.end(`${req.method} ${req.url} ${Buffer.concat(chunks).length}`);
  });
});
upstream.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (data) => socket.write(data));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;
const dataDir = '/tmp/dsh-https-smoke';
await rm(dataDir, { recursive: true, force: true });
const { config, errors } = normalizeConfig({
  listen: { host: '127.0.0.1', port: 0 },
  upstream: { host: '127.0.0.1', port: upstreamPort },
  dataDir,
  localCa: { hosts: ['localhost'] },
}, { homePath: '/tmp/x', upstreamPort });
if (errors.length) throw new Error(errors.join('; '));

const store = new CertStore({ config, logger: { info() {}, warn: console.warn, error: console.error } });
await store.init();
const server = new HttpsProxyServer({ config, certStore: store, logger: { info() {}, warn: console.warn, error: console.error } });
await server.start();
const port = server.port;
const request = (path, options = {}) => new Promise((resolve, reject) => {
  const req = https.request({ host: '127.0.0.1', port, path, rejectUnauthorized: false, servername: 'localhost', ...options }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end(options.body);
});

const hello = await request('/hello', { headers: { host: 'localhost:3088' } });
if (hello.status !== 200 || !hello.body.startsWith('GET /hello')) throw new Error('hello failed: ' + JSON.stringify(hello));
if (hello.headers['x-upstream-host'] !== 'localhost:3088') throw new Error('host not preserved: ' + hello.headers['x-upstream-host']);

const cookie = await request('/cookie');
const cookies = cookie.headers['set-cookie'] || [];
if (!cookies.every((item) => /; secure/i.test(item))) throw new Error('cookies not secured: ' + JSON.stringify(cookies));

const body = Buffer.alloc(1024 * 1024, 97);
const post = await request('/body', { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } });
if (post.status !== 200 || !post.body.endsWith('1048576')) throw new Error('body failed: ' + post.body.slice(0, 80));

const sse = await request('/sse');
if (!sse.body.includes('data: one') || !sse.body.includes('data: two')) throw new Error('sse failed: ' + sse.body);

const wsResult = await new Promise((resolve, reject) => {
  const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false }, () => {
    const key = crypto.randomBytes(16).toString('base64');
    socket.write(`GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const timer = setTimeout(() => { socket.destroy(); reject(new Error('ws timeout')); }, 4000);
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (!upgraded) {
      const index = buffer.indexOf('\r\n\r\n');
      if (index < 0) return;
      const head = buffer.subarray(0, index).toString();
      if (!head.includes('101 Switching Protocols')) { clearTimeout(timer); socket.destroy(); reject(new Error('ws status: ' + head)); return; }
      upgraded = true;
      buffer = buffer.subarray(index + 4);
      socket.write('ping');
    }
    if (upgraded && buffer.includes('ping')) { clearTimeout(timer); socket.end(); resolve('ok'); }
  });
  socket.on('error', reject);
});

await server.stop();
upstream.close();
console.log(JSON.stringify({ ok: true, hello: hello.status, cookies: cookies.length, bodyBytes: post.body.split(' ').pop(), sse: true, ws: wsResult, port }));
