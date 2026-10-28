import { sanitizeError } from './util.js';

const RENEW_COOLDOWN_MS = 10 * 60_000;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function registerApi({ ctx, state, actions }) {
  const connection = ctx.get('connection');
  if (!connection?.fetch || typeof connection.fetch.register !== 'function') {
    ctx.logger?.warn?.('[dsh-https] 缺少 connection.fetch 服务，状态 API 未注册');
    return [];
  }
  let lastManualRenewAt = 0;

  const handle = async (request) => {
    let pathname;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return json({ ok: false, error: 'bad request' }, 400);
    }
    const method = (request.method || 'GET').toUpperCase();

    if (pathname === '/api/dsh-https/status') {
      if (method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405, { allow: 'GET' });
      return json({ ok: true, ...state.status() });
    }

    if (pathname === '/api/dsh-https/renew') {
      if (method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405, { allow: 'POST' });
      if (!actions.acme || !state.acmeUsable()) {
        return json({ ok: false, error: state.acmeError() || 'ACME 未启用或配置不完整' }, 400);
      }
      const now = Date.now();
      if (now - lastManualRenewAt < RENEW_COOLDOWN_MS) {
        const retryAfter = Math.ceil((RENEW_COOLDOWN_MS - (now - lastManualRenewAt)) / 1000);
        return json({ ok: false, error: '手动续期过于频繁，请稍后再试' }, 429, { 'retry-after': String(retryAfter) });
      }
      try {
        const result = await actions.acme.check({ force: true, reason: 'manual' });
        if (result.status === 'busy') return json({ ok: false, error: '已有签发任务进行中' }, 409);
        if (result.status === 'misconfigured') return json({ ok: false, error: 'ACME 配置不完整' }, 400);
        if (result.status === 'error') return json({ ok: false, error: result.error }, 502);
        lastManualRenewAt = now;
        if (result.promise) {
          result.promise.catch((error) => {
            ctx.logger?.warn?.(`[dsh-https] 手动续期失败：${sanitizeError(error)}`);
          });
        }
        return json({ ok: true, status: result.status, nextAttempt: state.status().acme?.nextAttempt ?? null }, 202);
      } catch (error) {
        return json({ ok: false, error: sanitizeError(error) }, 500);
      }
    }

    if (pathname === '/api/dsh-https/settings') {
      if (method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405, { allow: 'POST' });
      if (!actions.saveSettings) return json({ ok: false, error: '设置接口未就绪' }, 503);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
      }
      try {
        const result = await actions.saveSettings(body ?? {});
        return json({ ok: true, ...result, status: state.status() });
      } catch (error) {
        return json({ ok: false, error: sanitizeError(error) }, 400);
      }
    }

    if (pathname === '/api/dsh-https/credentials') {
      if (method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405, { allow: 'POST' });
      if (!actions.saveCredentials) return json({ ok: false, error: '密钥接口未就绪' }, 503);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
      }
      try {
        const result = await actions.saveCredentials(body ?? {});
        return json({ ok: true, ...result, status: state.status() });
      } catch (error) {
        return json({ ok: false, error: sanitizeError(error) }, 400);
      }
    }

    return json({ ok: false, error: 'not found' }, 404);
  };

  const route = (path, methods, label) =>
    ctx.effect(
      () => connection.fetch.register({ path, methods, requestBody: 'buffered', fetch: handle }),
      `dsh-https: ${label}`,
    );

  return [
    route('/api/dsh-https/status', ['GET'], '/api/dsh-https/status'),
    route('/api/dsh-https/renew', ['POST'], '/api/dsh-https/renew'),
    route('/api/dsh-https/settings', ['POST'], '/api/dsh-https/settings'),
    route('/api/dsh-https/credentials', ['POST'], '/api/dsh-https/credentials'),
  ];
}
