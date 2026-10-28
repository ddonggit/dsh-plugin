import { createPrivateKey, randomBytes, X509Certificate as NodeCertificate } from 'node:crypto';
import { webcrypto as crypto } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as x509 from '@peculiar/x509';
import { isDnsName, isIpLiteral } from './config.js';
import { missingSans, parseSanString, uniq } from './san.js';
import {
  atomicWrite,
  daysLeft,
  ensureDir,
  fingerprintSha256,
  normalizePem,
  readIfExists,
  sanitizeError,
} from './util.js';

x509.cryptoProvider.set(crypto);

const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

function randomSerial() {
  return `01${randomBytes(15).toString('hex')}`;
}

function derToPem(der, label) {
  const body = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

async function exportPrivateKey(privateKey) {
  return derToPem(await crypto.subtle.exportKey('pkcs8', privateKey), 'PRIVATE KEY');
}

async function importPrivateKey(pem) {
  const key = createPrivateKey(pem);
  const der = key.export({ type: 'pkcs8', format: 'der' });
  const curve = key.asymmetricKeyDetails?.namedCurve === 'secp384r1' ? 'P-384' : 'P-256';
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: curve }, true, ['sign']);
}

function safeCommonName(value) {
  return String(value || 'DSH').replace(/[,\n\r]/g, ' ').trim().slice(0, 64) || 'DSH';
}

export function collectLocalHosts(config) {
  const hosts = ['localhost', '127.0.0.1', '::1'];
  const hostname = os.hostname().toLowerCase();
  if (isDnsName(hostname)) hosts.push(hostname);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || entry.address.includes('%')) continue;
      if (entry.family === 'IPv4' || entry.family === 4) hosts.push(entry.address);
      else if (entry.family === 'IPv6' || entry.family === 6) hosts.push(entry.address);
    }
  }
  const listenHost = String(config.listen?.host ?? '').replace(/^\[|\]$/g, '');
  if (listenHost && listenHost !== '0.0.0.0' && listenHost !== '::' && isIpLiteral(listenHost)) hosts.push(listenHost);
  hosts.push(...(config.localCa?.hosts || []));
  if (config.acme?.domains?.length) hosts.push(...config.acme.domains);
  return uniq(hosts.map((host) => String(host).trim().replace(/\.$/, ''))).filter((host) => isDnsName(host));
}

function sanEntries(hosts) {
  return hosts.map((host) => ({ type: isIP(host) ? 'ip' : 'dns', value: host.toLowerCase() }));
}

function paths(dataDir) {
  const dir = path.join(dataDir, 'local-ca');
  return {
    dir,
    caCert: path.join(dir, 'ca.crt'),
    caKey: path.join(dir, 'ca.key.pem'),
    leafCert: path.join(dir, 'leaf.crt'),
    leafKey: path.join(dir, 'leaf.key.pem'),
    meta: path.join(dir, 'meta.json'),
  };
}

async function generateCa(config) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const commonName = safeCommonName(config.localCa.commonName);
  const organization = safeCommonName(config.localCa.organization);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: `CN=${commonName}, O=${organization}`,
    notBefore: new Date(Date.now() - 5 * 60_000),
    notAfter: new Date(Date.now() + config.localCa.rootDays * 86_400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign | x509.KeyUsageFlags.digitalSignature,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return {
    caPem: normalizePem(cert.toString('pem')),
    caKeyPem: normalizePem(await exportPrivateKey(keys.privateKey)),
    caNode: new NodeCertificate(cert.toString('pem')),
    caSubject: cert.subject,
    signingKey: keys.privateKey,
  };
}

async function loadCa(config, p) {
  const [caPemRaw, caKeyRaw] = await Promise.all([readIfExists(p.caCert), readIfExists(p.caKey)]);
  if (!caPemRaw || !caKeyRaw) return null;
  const caPem = normalizePem(caPemRaw.toString());
  const caKeyPem = normalizePem(caKeyRaw.toString());
  const node = new NodeCertificate(caPem);
  if (!node.checkIssued(node)) throw new Error('CA 证书不是自签名');
  if (!node.verify(node.publicKey)) throw new Error('CA 证书签名校验失败');
  if (!node.checkPrivateKey(createPrivateKey(caKeyPem))) throw new Error('CA 证书与私钥不匹配');
  if (daysLeft(node.validTo) <= 30) throw new Error('CA 证书将在 30 天内过期');
  const signingKey = await importPrivateKey(caKeyPem);
  const peculiar = new x509.X509Certificate(caPem);
  return { caPem, caKeyPem, caNode: node, caSubject: peculiar.subject, signingKey };
}

async function generateLeaf(config, ca, hosts) {
  const leafKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const sans = sanEntries(hosts);
  const commonName = sans.find((san) => san.type === 'dns')?.value || hosts[0] || 'localhost';
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: `CN=${safeCommonName(commonName)}`,
    issuer: ca.caSubject,
    notBefore: new Date(Date.now() - 5 * 60_000),
    notAfter: new Date(Date.now() + config.localCa.leafDays * 86_400_000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    publicKey: leafKeys.publicKey,
    signingKey: ca.signingKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([OID_SERVER_AUTH], false),
      new x509.SubjectAlternativeNameExtension(sans, false),
    ],
  });
  const leafPem = normalizePem(cert.toString('pem'));
  const leafKeyPem = normalizePem(await exportPrivateKey(leafKeys.privateKey));
  return { leafPem, leafKeyPem, leafNode: new NodeCertificate(leafPem), sans };
}

async function loadLeaf(ca, p) {
  const [certRaw, keyRaw] = await Promise.all([readIfExists(p.leafCert), readIfExists(p.leafKey)]);
  if (!certRaw || !keyRaw) return null;
  const leafPem = normalizePem(certRaw.toString());
  const leafKeyPem = normalizePem(keyRaw.toString());
  const node = new NodeCertificate(leafPem);
  if (!node.checkIssued(ca.caNode)) throw new Error('本地站点证书不是由当前 CA 签发');
  if (!node.checkPrivateKey(createPrivateKey(leafKeyPem))) throw new Error('本地站点证书与私钥不匹配');
  return { leafPem, leafKeyPem, leafNode: node, sans: parseSanString(node.subjectAltName) };
}

async function writeLocalCa(config, p, ca, leaf) {
  await ensureDir(p.dir, 0o700);
  await atomicWrite(p.caKey, ca.caKeyPem, 0o600);
  await atomicWrite(p.caCert, ca.caPem, 0o644);
  await atomicWrite(p.leafKey, leaf.leafKeyPem, 0o600);
  await atomicWrite(p.leafCert, leaf.leafPem, 0o644);
  await atomicWrite(
    p.meta,
    JSON.stringify(
      {
        caFingerprintSha256: fingerprintSha256(ca.caPem),
        caNotAfter: new Date(ca.caNode.validTo).toISOString(),
        leafNotAfter: new Date(leaf.leafNode.validTo).toISOString(),
        sans: leaf.sans,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    0o644,
  );
}

export async function ensureLocalCa(config, logger = console) {
  if (!config.localCa.enabled) return null;
  const p = paths(config.dataDir);
  let ca = null;
  let leaf = null;
  let regeneratedCa = false;
  let regeneratedLeaf = false;
  let lastError = null;

  try {
    ca = await loadCa(config, p);
  } catch (error) {
    lastError = error;
  }
  if (!ca) {
    ca = await generateCa(config);
    regeneratedCa = true;
    logger.warn?.(`[dsh-https] 本地 CA 已重新生成${lastError ? `：${sanitizeError(lastError)}` : ''}`);
  }

  try {
    leaf = await loadLeaf(ca, p);
  } catch (error) {
    lastError = error;
  }
  const hosts = collectLocalHosts(config);
  const missing = leaf ? missingSans(leaf.sans, hosts) : hosts;
  if (!leaf || daysLeft(leaf.leafNode.validTo) <= config.localCa.renewBeforeDays || missing.length > 0) {
    leaf = await generateLeaf(config, ca, hosts);
    regeneratedLeaf = true;
    if (missing.length > 0) {
      logger.info?.(`[dsh-https] 本地站点证书补发 SAN：${missing.join(', ')}`);
    }
  }

  if (regeneratedCa || regeneratedLeaf || !(await readIfExists(p.meta))) {
    await writeLocalCa(config, p, ca, leaf);
  }

  const caMode = await stat(p.caKey).then((info) => info.mode & 0o777).catch(() => null);
  return {
    caPem: ca.caPem,
    caKeyPem: ca.caKeyPem,
    leafPem: leaf.leafPem,
    leafKeyPem: leaf.leafKeyPem,
    caFingerprintSha256: fingerprintSha256(ca.caPem),
    leafFingerprintSha256: fingerprintSha256(leaf.leafPem),
    caNotAfter: new Date(ca.caNode.validTo),
    leafNotAfter: new Date(leaf.leafNode.validTo),
    sans: leaf.sans,
    hosts,
    paths: p,
    caKeyMode: caMode,
    regenerated: regeneratedCa || regeneratedLeaf,
  };
}
