#!/usr/bin/env node
/**
 * ACME preflight: validates the plugin's ACME config without issuing a certificate.
 *
 *   node scripts/acme-preflight.mjs --config ./acme-config.json
 *   node scripts/acme-preflight.mjs --config ./acme-config.json --json
 *
 * The config file is the `config:` object you would put under `id: dsh-https`
 * in cordis.patch.yml, in JSON form. Nothing is written.
 */
import { readFile } from 'node:fs/promises';
import { normalizeConfig } from '../lib/config.js';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const configIndex = args.indexOf('--config');
if (configIndex < 0 || !args[configIndex + 1]) {
  console.error('usage: node scripts/acme-preflight.mjs --config <config.json> [--json]');
  process.exit(2);
}

const raw = JSON.parse(await readFile(args[configIndex + 1], 'utf8'));
const { config, warnings, errors } = normalizeConfig(raw, { upstreamPort: 3081 });
const result = { ok: false, errors, warnings, directory: null, domains: [], credentials: null };

function print() {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`ACME enabled: ${config.acme.enabled}`);
  console.log(`staging: ${config.acme.staging}`);
  console.log(`domains: ${config.acme.domains.join(', ') || '(none)'}`);
  console.log(`zone: ${config.acme.dns.zone || '(auto)'}`);
  console.log(`credentialsFile: ${config.acme.dns.credentialsFile || '(none)'}`);
  for (const warning of warnings) console.log(`WARN  ${warning}`);
  for (const error of errors) console.log(`ERROR ${error}`);
  for (const item of result.domains) {
    console.log(`${item.ok ? 'OK' : 'FAIL'}  DNS ${item.domain}: ${item.detail}`);
  }
  if (result.directory) console.log(`${result.directory.ok ? 'OK' : 'FAIL'}  ACME directory: ${result.directory.detail}`);
}

if (errors.length > 0 || !config.acme.enabled || !config.acme.usable) {
  result.errors = errors.length > 0 ? errors : ['ACME 未启用或配置不完整（email/domains/zone/agreeTos）'];
  print();
  process.exit(1);
}

async function dnsLookup(name, type) {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  const response = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`DoH HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.Answer) ? data.Answer : [];
}

for (const domain of config.acme.domains) {
  try {
    const answers = await dnsLookup(domain, 'NS');
    const ns = answers.filter((answer) => answer.type === 2).map((answer) => String(answer.data).replace(/\.$/, ''));
    result.domains.push({
      domain,
      ok: ns.length > 0,
      detail: ns.length > 0 ? `NS ${ns.join(', ')}` : '没有公网 NS，Let\'s Encrypt 无法验证 DNS-01',
    });
  } catch (error) {
    result.domains.push({ domain, ok: false, detail: `DNS 查询失败：${error.message}` });
  }
}

const directoryUrl = config.acme.staging
  ? 'https://acme-staging-v02.api.letsencrypt.org/directory'
  : 'https://acme-v02.api.letsencrypt.org/directory';
try {
  const response = await fetch(directoryUrl, { signal: AbortSignal.timeout(10000) });
  result.directory = { ok: response.ok, detail: `HTTP ${response.status} ${directoryUrl}` };
} catch (error) {
  result.directory = { ok: false, detail: `${error.message} ${directoryUrl}` };
}

result.credentials = config.acme.dns.credentialsFile ? 'file configured' : 'env/credentials service';
result.ok = result.domains.every((item) => item.ok) && result.directory?.ok === true;
print();
process.exit(result.ok ? 0 : 1);
