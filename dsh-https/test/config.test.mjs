import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../lib/config.js';

test('defaults: local CA on 0.0.0.0:3088 proxying 127.0.0.1:3081', () => {
  const { config, errors } = normalizeConfig({}, { homePath: '/tmp/dsh-home', upstreamPort: 3081 });
  assert.deepEqual(errors, []);
  assert.equal(config.listen.host, '0.0.0.0');
  assert.equal(config.listen.port, 3088);
  assert.equal(config.upstream.host, '127.0.0.1');
  assert.equal(config.upstream.port, 3081);
  assert.equal(config.publicCert.mode, 'local');
  assert.equal(config.localCa.enabled, true);
  assert.equal(config.acme.enabled, false);
  assert.equal(config.dataDir, '/tmp/dsh-home/https');
});

test('files mode requires both certFile and keyFile', () => {
  const { errors } = normalizeConfig({ publicCert: { mode: 'files', certFile: '/tmp/a.pem' } });
  assert.ok(errors.some((error) => error.includes('certFile 与 keyFile')));
});

test('listen port must differ from upstream port', () => {
  const { errors } = normalizeConfig({ listen: { port: 3081 } }, { upstreamPort: 3081 });
  assert.ok(errors.some((error) => error.includes('listen.port')));
});

test('ACME requires email, domains and ToS agreement', () => {
  const { config, errors } = normalizeConfig({
    publicCert: { mode: 'acme' },
    acme: { enabled: true, email: '', domains: [], agreeTos: false },
  });
  assert.equal(config.acme.usable, false);
  assert.deepEqual(errors, []);
});

test('ACME usable with complete config and auto zone', () => {
  const { config, errors } = normalizeConfig({
    publicCert: { mode: 'acme' },
    acme: { enabled: true, email: 'a@example.com', domains: ['dsh.example.com'], agreeTos: true },
  });
  assert.deepEqual(errors, []);
  assert.equal(config.acme.usable, true);
  assert.equal(config.acme.dns.zone, '');
});

test('relative file paths resolve under dataDir', () => {
  const { config } = normalizeConfig({
    dataDir: '/tmp/data',
    publicCert: { mode: 'files', certFile: 'cert.pem', keyFile: 'key.pem' },
  });
  assert.equal(config.publicCert.certFile, '/tmp/data/cert.pem');
  assert.equal(config.publicCert.keyFile, '/tmp/data/key.pem');
});

test('undiscovered webserver port (0/undefined) is ignored, not turned into a config error', () => {
  for (const upstreamPort of [0, undefined, null]) {
    const { config, errors } = normalizeConfig({}, { upstreamPort });
    assert.deepEqual(errors, []);
    assert.equal(config.upstream.port, 3081);
  }
});

test('leafDays above the browser limit is clamped to 397 with a warning', () => {
  const { config, warnings } = normalizeConfig({ localCa: { leafDays: 1000 } });
  assert.equal(config.localCa.leafDays, 397);
  assert.ok(warnings.some((warning) => warning.includes('398')));
});

test('files mode disables ACME even with a complete ACME config', () => {
  const { config, warnings } = normalizeConfig({
    publicCert: { mode: 'files', certFile: '/tmp/a.pem', keyFile: '/tmp/b.pem' },
    acme: { enabled: true, email: 'a@example.com', domains: ['dsh.example.com'], agreeTos: true },
  });
  assert.equal(config.acme.usable, false);
  assert.ok(warnings.some((warning) => warning.includes('mode=files')));
});

test('renewBeforeDays not below leafDays is warned about', () => {
  const { warnings } = normalizeConfig({ localCa: { leafDays: 30, renewBeforeDays: 30 } });
  assert.ok(warnings.some((warning) => warning.includes('每次启动都会重签')));
});
