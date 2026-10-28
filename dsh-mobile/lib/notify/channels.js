/**
 * Channel adapters. Every adapter is a plain async function that resolves to
 * `{ ok, detail }` and never throws: a broken webhook must not reach the agent
 * loop, and one dead channel must not block the others.
 *
 * Payload shapes live in `compose.js` (the notice already carries a rendered
 * `payloads[name]`), so an adapter only knows how to send and how to read the
 * provider's success marker. Feishu retries once as plain text when the tenant
 * rejects the interactive card.
 */

import { renderPlain } from './compose.js';

const TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text().catch(() => '');
  return { response, text };
}

async function jsonRequest(url, payload, headers = {}) {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(payload),
  });
}

function preview(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Read a JSON reply; non-JSON is a failure with the body as detail. */
function parseReply(text) {
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    return { error: `非 JSON 响应 ${preview(text)}` };
  }
}

/** HTTP check shared by adapters whose success marker is JSON. */
function httpFailure(response, text) {
  if (response.ok) return '';
  return `HTTP ${response.status} ${preview(text)}`;
}

/** WeCom group robot: HTTP 200 with `errcode: 0`; anything else is a failure. */
async function sendWecom(config, notice) {
  const { response, text } = await jsonRequest(config.webhook, notice.payloads.wecom);
  const http = httpFailure(response, text);
  if (http) return { ok: false, detail: http };
  const { parsed, error } = parseReply(text);
  if (error) return { ok: false, detail: error };
  if (parsed?.errcode !== 0) return { ok: false, detail: `errcode=${parsed?.errcode} ${preview(parsed?.errmsg)}` };
  return { ok: true, detail: 'ok' };
}

/** DingTalk group robot: same `errcode` contract as WeCom. */
async function sendDingtalk(config, notice) {
  const { response, text } = await jsonRequest(config.webhook, notice.payloads.dingtalk);
  const http = httpFailure(response, text);
  if (http) return { ok: false, detail: http };
  const { parsed, error } = parseReply(text);
  if (error) return { ok: false, detail: error };
  if (parsed?.errcode !== 0) return { ok: false, detail: `errcode=${parsed?.errcode} ${preview(parsed?.errmsg)}` };
  return { ok: true, detail: 'ok' };
}

/** Feishu group robot: `code: 0` (older tenants answer `StatusCode: 0`). */
async function sendFeishu(config, notice) {
  const { response, text } = await jsonRequest(config.webhook, notice.payloads.feishu);
  const http = httpFailure(response, text);
  if (http) return { ok: false, detail: http };
  const { parsed, error } = parseReply(text);
  if (error) return { ok: false, detail: error };
  const code = parsed?.code ?? parsed?.StatusCode;
  if (code === 0) return { ok: true, detail: 'ok' };

  // A tenant that forbids custom cards answers 200 + non-zero code; the same
  // notice as plain text still gets through, so delivery beats layout.
  const fallback = await jsonRequest(config.webhook, { msg_type: 'text', content: { text: renderPlain(notice) } });
  const fallbackHttp = httpFailure(fallback.response, fallback.text);
  if (fallbackHttp) return { ok: false, detail: `card code=${code}; text retry ${fallbackHttp}` };
  const retried = parseReply(fallback.text);
  if (retried.error) return { ok: false, detail: `card code=${code}; text retry ${retried.error}` };
  const retriedCode = retried.parsed?.code ?? retried.parsed?.StatusCode;
  if (retriedCode !== 0) {
    return { ok: false, detail: `card code=${code} ${preview(parsed?.msg)}; text code=${retriedCode}` };
  }
  return { ok: true, detail: `ok (text fallback, card code=${code})` };
}

/** Telegram Bot API. Plain text: MarkdownV2 escaping is a footgun for dynamic titles. */
async function sendTelegram(config, notice) {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const { response, text } = await jsonRequest(url, { chat_id: config.chatId, ...notice.payloads.telegram });
  const http = httpFailure(response, text);
  if (http) return { ok: false, detail: http };
  const { parsed, error } = parseReply(text);
  if (error) return { ok: false, detail: error };
  if (parsed?.ok !== true) return { ok: false, detail: `ok=false ${preview(parsed?.description)}` };
  return { ok: true, detail: 'ok' };
}

/**
 * ntfy: publish as JSON at the server root.
 *
 * The plain-text publish puts the title in an HTTP header, and every title here
 * starts with an emoji (✅/❌/❓). `fetch` rejects a header value that is not a
 * ByteString, so that form could never leave the process: the failure happened
 * before the request, on the first non-Latin-1 character. The JSON endpoint
 * carries the same fields in a UTF-8 body instead.
 */
async function sendNtfy(config, notice) {
  const payload = notice.payloads.ntfy;
  const body = {
    topic: config.topic,
    title: payload.title,
    message: payload.body,
    tags: payload.tags ? [payload.tags] : [],
    priority: payload.priority,
  };
  if (payload.click) body.click = payload.click;
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  // The JSON endpoint is the server root; a self-hosted base path keeps working.
  const base = String(config.server ?? '').replace(/\/+$/, '');
  const { response, text } = await request(`${base}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const http = httpFailure(response, text);
  if (http) return { ok: false, detail: http };
  return { ok: true, detail: 'ok' };
}

/** Server酱 (sctapi.ftqq.com): form-encoded title/desp, `code: 0` on success. */
async function sendServerchan(config, notice) {
  const payload = notice.payloads.serverchan;
  const body = new URLSearchParams({ title: payload.title.slice(0, 100), desp: payload.desp });
  const { response, text } = await request(`https://sctapi.ftqq.com/${encodeURIComponent(config.sendKey)}.send`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: body.toString(),
  });
  const http = httpFailure(response, text);
  if (http) return { ok: false, detail: http };
  const { parsed, error } = parseReply(text);
  if (error) return { ok: false, detail: error };
  if (parsed?.code !== 0) return { ok: false, detail: `code=${parsed?.code} ${preview(parsed?.message ?? parsed?.info)}` };
  return { ok: true, detail: 'ok' };
}

/** Generic webhook: stable JSON envelope, any extra headers from configuration. */
async function sendWebhook(config, notice) {
  const { response, text } = await jsonRequest(config.url, notice.payloads.generic, config.headers);
  const http = httpFailure(response, text);
  if (http) return { ok: false, detail: http };
  return { ok: true, detail: 'ok' };
}

const SENDERS = {
  wecom: sendWecom,
  dingtalk: sendDingtalk,
  feishu: sendFeishu,
  telegram: sendTelegram,
  ntfy: sendNtfy,
  serverchan: sendServerchan,
  webhook: sendWebhook,
};

/** True for failures worth one retry: network errors, timeouts and 5xx. */
function retryable(result) {
  if (result.ok) return false;
  return /^(HTTP 5\d\d|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|TimeoutError|AbortError)/i.test(result.detail)
    || /timeout|aborted|fetch failed|network/i.test(result.detail);
}

export async function deliver(name, config, notice) {
  const sender = SENDERS[name];
  if (!sender) return { ok: false, detail: `未知渠道 ${name}` };
  let last = { ok: false, detail: '未发送' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      last = await sender(config, notice);
    } catch (error) {
      const cause = error?.cause?.code ?? error?.name ?? 'Error';
      last = { ok: false, detail: `${cause}: ${error?.message ?? error}` };
    }
    if (!retryable(last)) return last;
    if (attempt === 0) await sleep(RETRY_DELAY_MS);
  }
  return last;
}

/** Human-readable channel label used in the test endpoint response. */
export function describeTarget(name, config) {
  switch (name) {
    case 'wecom':
    case 'dingtalk':
    case 'feishu':
      return config.webhook ? new URL(config.webhook).host : '(未配置)';
    case 'telegram':
      return `chat ${config.chatId || '(未配置)'}`;
    case 'ntfy':
      return `${config.server}/${config.topic || '(未配置)'}`;
    case 'serverchan':
      return config.sendKey ? 'sctapi.ftqq.com' : '(未配置)';
    case 'webhook':
      return config.url ? new URL(config.url).host : '(未配置)';
    default:
      return name;
  }
}
