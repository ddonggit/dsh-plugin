import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { normalizeConfig } from '../lib/config.js';
import { ensureLocalCa } from '../lib/local-ca.js';

test('local CA: generates a valid chain, trusted SANs, 0600 key, stable reload', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-https-ca-'));
  try {
    const { config, errors } = normalizeConfig(
      { dataDir: dir, localCa: { hosts: ['dsh.test'] } },
      { homePath: dir, upstreamPort: 3081 },
    );
    assert.deepEqual(errors, []);
    const first = await ensureLocalCa(config, {});
    assert.ok(first.caPem.includes('BEGIN CERTIFICATE'));
    assert.ok(first.leafKeyPem.includes('PRIVATE KEY'));

    const ca = new X509Certificate(first.caPem);
    const leaf = new X509Certificate(first.leafPem);
    assert.equal(leaf.checkIssued(ca), true);
    assert.equal(ca.verify(ca.publicKey), true);
    assert.equal(leaf.checkPrivateKey(createPrivateKey(first.leafKeyPem)), true);

    assert.match(leaf.subjectAltName, /DNS:localhost/);
    assert.match(leaf.subjectAltName, /IP Address:127\.0\.0\.1/);
    assert.match(leaf.subjectAltName, /DNS:dsh\.test/);
    assert.ok(new Date(leaf.validTo).getTime() > Date.now());

    const mode = (await stat(first.paths.caKey)).mode & 0o777;
    assert.equal(mode, 0o600);

    const second = await ensureLocalCa(config, {});
    assert.equal(second.regenerated, false);
    assert.equal(second.leafFingerprintSha256, first.leafFingerprintSha256);
    assert.equal(second.caFingerprintSha256, first.caFingerprintSha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
