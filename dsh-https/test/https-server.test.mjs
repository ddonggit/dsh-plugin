import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpsProxyServer } from '../lib/https-server.js';

function makeServer(auth) {
  const config = {
    listen: {},
    upstream: { host: '127.0.0.1', port: 9, protocol: 'http' },
    proxy: {},
  };
  const logger = { info() {}, warn() {}, error() {} };
  const server = new HttpsProxyServer({ config, certStore: {}, logger, auth });
  const calls = { forwarded: 0 };
  server.forwardRequest = () => { calls.forwarded += 1; };
  server.forwardUpgrade = () => { calls.forwarded += 1; };
  return { server, calls };
}

function makeResponse() {
  return {
    statusCode: 0,
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    },
    end(payload) {
      this.writableEnded = true;
      if (payload !== undefined) this.body += Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    },
  };
}

test('a throwing gate is fail-closed for HTTP requests', () => {
  const { server, calls } = makeServer({ handleRequest() { throw new Error('gate exploded'); } });
  const res = makeResponse();
  server.handleRequest({ url: '/api/secret', method: 'GET', headers: {}, socket: {} }, res);
  assert.equal(calls.forwarded, 0, 'the upstream must never see an unauthenticated request');
  assert.equal(res.statusCode, 500);
  assert.equal(res.body, 'Internal Server Error');
});

test('a throwing gate is fail-closed for WebSocket upgrades', () => {
  const { server, calls } = makeServer({ handleUpgrade() { throw new Error('gate exploded'); } });
  const socket = { ended: '', end(value) { this.ended += value; } };
  server.handleUpgrade({ url: '/api/remote.mux', headers: { upgrade: 'websocket' }, socket: {} }, socket, Buffer.alloc(0));
  assert.equal(calls.forwarded, 0, 'the upstream must never see an unauthenticated upgrade');
  assert.match(socket.ended, /^HTTP\/1\.1 500 /);
});

test('a gate that declines still reaches the proxy', () => {
  const { server, calls } = makeServer({ handleRequest() { return false; } });
  server.handleRequest({ url: '/', headers: {}, socket: {} }, makeResponse());
  assert.equal(calls.forwarded, 1);
});
