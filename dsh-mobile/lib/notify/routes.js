/**
 * HTTP surface of the notification feature.
 *
 * Public (no browser session needed, key-gated where it returns history):
 *   GET  /plugins/dsh-mobile/meta            deployment hints for the client half
 *   GET  /plugins/dsh-mobile/feed?key=…      event history for an optional desktop helper
 *   POST /plugins/dsh-mobile/test?key=…      send a test message through the live config
 *
 * Authenticated (official connection extension point, cookie + Host/Origin fence):
 *   GET  /api/dsh-mobile/feed                the browser half's catch-up source
 *   GET  /api/dsh-mobile/notice?sessionId=…  last composed notice for one session
 *   GET  /api/dsh-mobile/notice?sample=1     sample notice for the settings preview
 *   GET  /api/dsh-mobile/host-settings       auto-answer fields, browser settings + defaults
 *   POST /api/dsh-mobile/host-settings       validate, merge into settings.json, reply
 *
 * The feed is what makes a sleeping tab recoverable: the client remembers the
 * last `seq` it displayed and asks for anything newer when it wakes up. The
 * notice route is how the browser half's own webhook gets the same task/result
 * content the host path sends; it is read-only and in-memory.
 */

import { timingSafeEqual } from 'node:crypto';
import { HOST_TIMEOUT_MAX_MS, HOST_TIMEOUT_MIN_MS, validateHostPatch } from './host-settings.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': payload.length, ...extraHeaders });
  res.end(payload);
}

function parseUrl(req) {
  try {
    return new URL(req.url, 'http://placeholder.local');
  } catch {
    return undefined;
  }
}

function safeEqual(actual, expected) {
  const a = Buffer.from(String(actual ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Turn the request's Host header into a likely HTTPS origin for the same host. */
function secureOrigin(req, hostKind) {
  const host = String(req.headers?.host ?? '').trim();
  if (!host) return '';
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!name) return '';
  return `https://${name}:${hostKind.httpsPort}`;
}

export function registerRoutes({ ctx, logger, webServer, feed, getFeedKey, dispatcher, meta, hostSettings }) {
  const disposers = [];

  const keyed = (req, url) => safeEqual(url.searchParams.get('key'), getFeedKey());

  const feedPayload = (since) => ({
    bootId: feed.bootId,
    seq: feed.latest(),
    items: feed.since(since),
  });

  const handler = (req, res) => {
    const url = parseUrl(req);
    if (!url) {
      json(res, 400, { ok: false, error: 'bad request' });
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();

    if (url.pathname === '/plugins/dsh-mobile/meta') {
      if (method !== 'GET' && method !== 'HEAD') {
        json(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET, HEAD' });
        return;
      }
      json(res, 200, { ok: true, ...meta(), secureUrl: secureOrigin(req, { httpsPort: 3088 }) });
      return;
    }

    if (url.pathname === '/plugins/dsh-mobile/feed') {
      if (method !== 'GET' && method !== 'HEAD') {
        json(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET, HEAD' });
        return;
      }
      if (!keyed(req, url)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
      json(res, 200, { ok: true, ...feedPayload(Number.isFinite(since) ? since : 0) });
      return;
    }

    if (url.pathname === '/plugins/dsh-mobile/test') {
      if (method !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'POST' });
        return;
      }
      if (!keyed(req, url)) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      const requested = url.searchParams.get('channel');
      const names = requested ? [requested] : undefined;
      dispatcher
        .test(names)
        .then((result) => json(res, result.ok ? 200 : 502, { ok: result.ok, ...result }))
        .catch((error) => json(res, 500, { ok: false, error: error?.message ?? String(error) }));
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  };

  for (const path of ['/plugins/dsh-mobile/meta', '/plugins/dsh-mobile/feed', '/plugins/dsh-mobile/test']) {
    disposers.push(
      ctx.effect(
        () => webServer.register({ kind: 'exact', path, handler }),
        `dsh-mobile: public ${path}`,
      ),
    );
  }

  // Authenticated routes for the browser half.
  //
  // They live on the connection service, which the web app provides *after* this
  // plugin applies — `ctx.get('connection')` at that point returns undefined, so
  // sampling for it costs every authenticated route silently (the browser then
  // sees 404 and degrades). Wait for the service instead.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (connectionCtx) => {
      const connection = connectionCtx.connection ?? connectionCtx.get?.('connection');
      if (!connection?.fetch || typeof connection.fetch.register !== 'function') {
        logger?.warn?.('[dsh-mobile] connection 服务没有 fetch 注册点，浏览器接口未注册');
        return;
      }
      const register = (options, label) => connectionCtx.effect(() => connection.fetch.register(options), label);

      register(
        {
          path: '/api/dsh-mobile/feed',
          methods: ['GET'],
          requestBody: 'buffered',
          async fetch(request) {
            const url = new URL(request.url);
            const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
            const payload = { ok: true, ...feedPayload(Number.isFinite(since) ? since : 0) };
            return new Response(JSON.stringify(payload), { headers: JSON_HEADERS });
          },
        },
        'dsh-mobile: /api/dsh-mobile/feed',
      );

      register(
        {
          path: '/api/dsh-mobile/notice',
          methods: ['GET'],
          requestBody: 'buffered',
          async fetch(request) {
            const url = new URL(request.url);
            if (url.searchParams.has('sample')) {
              return new Response(JSON.stringify({ ok: true, notice: dispatcher.sampleNotice() }), {
                headers: JSON_HEADERS,
              });
            }
            const sessionId = String(url.searchParams.get('sessionId') ?? '').slice(0, 128);
            const notice = sessionId ? dispatcher.noticeFor(sessionId) : null;
            return new Response(JSON.stringify({ ok: true, notice }), { headers: JSON_HEADERS });
          },
        },
        'dsh-mobile: /api/dsh-mobile/notice',
      );

      if (hostSettings) {
        // The browser's only way to change what the host does while nobody is
        // watching. GET reports the effective values, POST merges a validated
        // subset into settings.json (see host-settings.js for why it is a merge).
        const range = { minMs: HOST_TIMEOUT_MIN_MS, maxMs: HOST_TIMEOUT_MAX_MS };
        register(
          {
            path: '/api/dsh-mobile/host-settings',
            methods: ['GET', 'POST'],
            requestBody: 'buffered',
            async fetch(request) {
              const payload = (body, status = 200) =>
                new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
              const method = (request.method ?? 'GET').toUpperCase();
              // `storedBrowserSettings` is the raw object from settings.json (null
              // when absent) so the browser can tell "the host never had this"
              // from "the host explicitly chose the default" and migrate only the
              // fields the host has never seen.
              const stored = () => (typeof hostSettings.stored === 'function' ? hostSettings.stored() : null);
              if (method === 'GET') {
                return payload({
                  ok: true,
                  settings: hostSettings.read(),
                  defaults: hostSettings.defaults(),
                  range,
                  storedBrowserSettings: stored(),
                });
              }
              let body;
              try {
                body = await request.json();
              } catch {
                return payload({ ok: false, error: 'body must be JSON' }, 400);
              }
              const validated = validateHostPatch(body);
              if (!validated.ok) return payload({ ok: false, error: validated.error }, 400);
              try {
                const settings = hostSettings.write(validated.patch);
                return payload({
                  ok: true,
                  settings,
                  defaults: hostSettings.defaults(),
                  range,
                  storedBrowserSettings: stored(),
                });
              } catch (error) {
                logger?.warn?.(`[dsh-mobile] 保存宿主端自动回答失败：${error?.message ?? error}`);
                const corrupt = error?.code === 'settings-unreadable';
                return payload(
                  {
                    ok: false,
                    error: corrupt
                      ? 'settings.json could not be read; refusing to overwrite it'
                      : 'failed to persist settings',
                  },
                  corrupt ? 409 : 500,
                );
              }
            },
          },
          'dsh-mobile: /api/dsh-mobile/host-settings',
        );
      }
    });
  } else {
    logger?.warn?.('[dsh-mobile] 运行时没有 ctx.inject，浏览器接口未注册');
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch {
        // Detach is best effort.
      }
    }
  };
}
