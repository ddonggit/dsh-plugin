import { isIP } from 'node:net';

export function expandIpv6(value) {
  let input = String(value).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!input.includes(':')) return input;
  if (input.includes('.')) {
    const last = input.split(':').pop();
    const parts = last.split('.').map(Number);
    if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      const high = ((parts[0] << 8) | parts[1]).toString(16);
      const low = ((parts[2] << 8) | parts[3]).toString(16);
      input = `${input.slice(0, input.length - last.length)}${high}:${low}`;
    }
  }
  const [head, tail] = input.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  return groups.map((group) => group.padStart(4, '0')).join(':');
}

export function normalizeIp(value) {
  const raw = String(value ?? '').trim().replace(/^\[|\]$/g, '');
  const version = isIP(raw);
  if (version === 4) return raw;
  if (version === 6) return expandIpv6(raw);
  return raw.toLowerCase();
}

export function parseSanString(text) {
  const result = [];
  for (const part of String(text ?? '').split(/,\s*/)) {
    const item = part.trim();
    if (!item) continue;
    if (item.startsWith('DNS:')) result.push({ type: 'dns', value: item.slice(4).trim().toLowerCase() });
    else if (item.startsWith('IP Address:')) result.push({ type: 'ip', value: normalizeIp(item.slice(11)) });
    else if (item.startsWith('IPAddress:')) result.push({ type: 'ip', value: normalizeIp(item.slice(10)) });
  }
  return result;
}

export function certSanList(cert) {
  return parseSanString(cert.subjectAltName);
}

export function sanCovers(sans, hostname) {
  const host = String(hostname ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (isIP(host)) {
    const normalized = normalizeIp(host);
    return sans.some((san) => san.type === 'ip' && normalizeIp(san.value) === normalized);
  }
  return sans.some((san) => {
    if (san.type !== 'dns') return false;
    if (san.value === host) return true;
    if (san.value.startsWith('*.')) {
      const suffix = san.value.slice(2);
      return host.endsWith(`.${suffix}`) && host.split('.').length === suffix.split('.').length + 1;
    }
    return false;
  });
}

export function missingSans(sans, hosts) {
  return hosts.filter((host) => !sanCovers(sans, host));
}

export function uniq(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = String(value ?? '').trim();
    if (!key) continue;
    const lowered = key.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    out.push(key);
  }
  return out;
}
