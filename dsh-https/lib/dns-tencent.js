import { createHash, createHmac } from 'node:crypto';
import { stripTrailingDot } from './util.js';

const SERVICE = 'dnspod';
const VERSION = '2021-03-23';
const ALGORITHM = 'TC3-HMAC-SHA256';

export class TencentDnsError extends Error {
  constructor(code, message, requestId) {
    super(message || code || 'Tencent DNS error');
    this.name = 'TencentDnsError';
    this.code = code;
    this.requestId = requestId;
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

export function tc3Headers({ secretId, secretKey, action, payload, timestamp, host, contentType = 'application/json; charset=utf-8' }) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(payload)].join('\n');
  const scope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [ALGORITHM, ts, scope, sha256Hex(canonicalRequest)].join('\n');
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
  return {
    authorization: `${ALGORITHM} Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    contentType,
    timestamp: ts,
    action,
    version: VERSION,
    host,
    canonicalRequest,
    stringToSign,
  };
}

function relativeName(name, zone) {
  const fqdn = stripTrailingDot(name).toLowerCase();
  const apex = stripTrailingDot(zone).toLowerCase();
  if (fqdn === apex) return '@';
  if (!fqdn.endsWith(`.${apex}`)) throw new Error(`记录 ${fqdn} 不在 zone ${apex} 内`);
  return fqdn.slice(0, -(apex.length + 1));
}

export class TencentDnsProvider {
  constructor({ zone, recordLine = '默认', ttl = 600, endpoint = 'https://dnspod.tencentcloudapi.com', secretId, secretKey, fetchImpl = fetch }) {
    if (!secretId || !secretKey) throw new Error('腾讯云 DNS 凭据缺失');
    this.zone = stripTrailingDot(zone).toLowerCase();
    this.recordLine = recordLine;
    this.ttl = ttl;
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.host = new URL(this.endpoint).host;
    this.secretId = secretId;
    this.secretKey = secretKey;
    this.fetchImpl = fetchImpl;
    this.zoneInfo = null;
  }

  async request(action, payload = {}, { retries = 0 } = {}) {
    const body = JSON.stringify(payload);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const headers = tc3Headers({
        secretId: this.secretId,
        secretKey: this.secretKey,
        action,
        payload: body,
        host: this.host,
      });
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: headers.authorization,
            'Content-Type': headers.contentType,
            'X-TC-Action': action,
            'X-TC-Version': VERSION,
            'X-TC-Timestamp': String(headers.timestamp),
          },
          body,
          signal: AbortSignal.timeout(20000),
        });
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        throw new Error(`腾讯云 DNS 请求失败（${action}）：${error.message}`);
      }
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`腾讯云 DNS 返回非 JSON（HTTP ${response.status}）`);
      }
      const result = data?.Response;
      // Tencent returns API errors (auth, domain not found, ...) with a JSON
      // body; surface them even when the HTTP status is not 2xx.
      if (result?.Error) {
        throw new TencentDnsError(result.Error.Code, result.Error.Message, result.RequestId);
      }
      if (!response.ok || !result) {
        throw new Error(`腾讯云 DNS HTTP ${response.status}（${action}）`);
      }
      return result;
    }
    throw lastError || new Error(`腾讯云 DNS 请求失败（${action}）`);
  }

  async describeZone(zone = this.zone) {
    const result = await this.request('DescribeDomain', { Domain: zone }, { retries: 2 });
    const info = result.DomainInfo;
    if (!info || stripTrailingDot(info.Domain).toLowerCase() !== zone) {
      throw new Error(`腾讯云 DNS 未找到域名 ${zone}`);
    }
    this.zoneInfo = info;
    return info;
  }

  async detectZone(domains) {
    if (this.zone) {
      await this.describeZone(this.zone);
      return this.zone;
    }
    const candidate = stripTrailingDot(domains[0]).toLowerCase();
    const labels = candidate.split('.');
    let lastError;
    for (let index = 0; index < labels.length - 1; index += 1) {
      const zone = labels.slice(index).join('.');
      try {
        await this.describeZone(zone);
        this.zone = zone;
        return zone;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('无法从 ACME 域名推断 DNSPod zone');
  }

  async listTxt(name) {
    const result = await this.request(
      'DescribeRecordList',
      {
        Domain: this.zone,
        Subdomain: relativeName(name, this.zone),
        RecordType: 'TXT',
        Limit: 100,
      },
      { retries: 2 },
    );
    return Array.isArray(result.RecordList) ? result.RecordList : [];
  }

  async createTxt(name, value) {
    const existing = await this.listTxt(name);
    const same = existing.find((record) => String(record.Value).replace(/^"|"$/g, '') === value);
    if (same) return { recordId: same.RecordId, existed: true };

    const result = await this.request('CreateRecord', {
      Domain: this.zone,
      SubDomain: relativeName(name, this.zone),
      RecordType: 'TXT',
      RecordLine: this.recordLine,
      Value: value,
      TTL: this.ttl,
    });
    return { recordId: result.RecordId, existed: false };
  }

  async deleteTxt(recordId) {
    if (recordId === undefined || recordId === null) return;
    await this.request('DeleteRecord', {
      Domain: this.zone,
      RecordId: Number(recordId),
    }, { retries: 1 });
  }
}
