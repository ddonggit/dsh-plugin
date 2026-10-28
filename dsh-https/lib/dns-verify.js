import { sleep } from './util.js';

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

function normalizeTxtData(data) {
  return String(data ?? '')
    .replace(/"/g, '')
    .replace(/\s+/g, '')
    .trim();
}

export async function queryTxtDoh(name, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=TXT`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`DoH HTTP ${response.status}`);
  const body = await response.json();
  const answers = Array.isArray(body?.Answer) ? body.Answer : [];
  return answers.filter((answer) => answer.type === 16).map((answer) => normalizeTxtData(answer.data));
}

export async function waitForTxt(name, value, options = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs = 180_000,
    initialDelayMs = 15_000,
    intervalMs = 5000,
    strict = false,
    logger = console,
  } = options;
  await sleep(initialDelayMs);
  const started = Date.now();
  let lastError = null;
  let consecutiveErrors = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const records = await queryTxtDoh(name, { fetchImpl });
      consecutiveErrors = 0;
      if (records.some((record) => record === value || record.includes(value))) {
        return { verified: true, elapsedMs: Date.now() - started };
      }
    } catch (error) {
      lastError = error;
      consecutiveErrors += 1;
      if (!strict && consecutiveErrors >= 3) {
        logger.warn?.(`[dsh-https] DoH 校验不可用，跳过等待：${error.message}`);
        return { verified: false, skipped: true, error: error.message };
      }
    }
    await sleep(intervalMs);
  }
  const message = lastError ? `DoH 查询失败：${lastError.message}` : 'TXT 记录未在超时前出现在公共 DNS';
  if (strict) throw new Error(message);
  logger.warn?.(`[dsh-https] ${message}，继续尝试签发`);
  return { verified: false, timedOut: true, error: message };
}
