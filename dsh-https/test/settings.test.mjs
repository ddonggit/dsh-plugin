import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../lib/config.js';
import { mergeRawConfig, parseDomains, sanitizeSettings } from '../lib/settings.js';
import { maskSecret } from '../lib/secret-store.js';

const acmeBase = {
  publicCert: { mode: 'files', certFile: '/tmp/cert.pem', keyFile: '/tmp/key.pem' },
  acme: { enabled: false, email: '', domains: [], agreeTos: false },
};

test('parseDomains splits on mixed separators and normalizes', () => {
  assert.deepEqual(parseDomains('A.example.com, *.b.example.com；c.example.com\n a.example.com'), [
    'a.example.com',
    '*.b.example.com',
    'c.example.com',
  ]);
  assert.deepEqual(parseDomains([]), []);
  assert.deepEqual(parseDomains(undefined), []);
});

test('sanitizeSettings drops unknown modes and keeps ACME fields', () => {
  const value = sanitizeSettings({
    mode: 'bogus',
    acme: { email: ' a@example.com ', domains: ['Dsh.Example.com'], zone: 'Example.COM.', staging: false },
  });
  assert.equal(value.mode, null);
  assert.equal(value.acme.email, 'a@example.com');
  assert.deepEqual(value.acme.domains, ['dsh.example.com']);
  assert.equal(value.acme.zone, 'example.com');
  assert.equal(value.acme.staging, false);
  assert.deepEqual(sanitizeSettings(null), { mode: null, acme: {} });
});

test('mergeRawConfig switches mode to ACME and enables it', () => {
  const merged = mergeRawConfig(acmeBase, {
    mode: 'acme',
    acme: { email: 'ops@example.com', domains: ['dsh.example.com'], staging: false },
  });
  const { config, errors } = normalizeConfig(merged);
  assert.deepEqual(errors, []);
  assert.equal(config.publicCert.mode, 'acme');
  assert.equal(config.acme.enabled, true);
  assert.equal(config.acme.agreeTos, true);
  assert.equal(config.acme.usable, true);
  assert.equal(config.acme.staging, false);
  assert.deepEqual(config.acme.domains, ['dsh.example.com']);
});

test('mergeRawConfig switches back to files and stops ACME', () => {
  const merged = mergeRawConfig(
    { ...acmeBase, publicCert: { mode: 'acme', certFile: '/tmp/cert.pem', keyFile: '/tmp/key.pem' }, acme: { enabled: true, email: 'a@example.com', domains: ['d.example.com'], agreeTos: true } },
    { mode: 'files', acme: {} },
  );
  const { config, errors } = normalizeConfig(merged);
  assert.deepEqual(errors, []);
  assert.equal(config.publicCert.mode, 'files');
  assert.equal(config.acme.enabled, false);
  assert.equal(config.acme.usable, false);
});

test('mergeRawConfig leaves the profile untouched without saved settings', () => {
  const merged = mergeRawConfig(acmeBase, { mode: null, acme: {} });
  assert.equal(merged.publicCert.mode, 'files');
  assert.equal(merged.acme.enabled, false);
  assert.equal(merged.acme.email, '');
});

test('mergeRawConfig keeps an explicit dns zone', () => {
  const merged = mergeRawConfig(acmeBase, { mode: 'acme', acme: { zone: 'example.com' } });
  assert.equal(merged.acme.dns.zone, 'example.com');
});

test('maskSecret never leaks the middle of a key', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('abc'), '****');
  assert.equal(maskSecret('AKIDabcdefghijklmnop'), 'AKID****mnop');
});

test('sanitizeSettings accepts the comma string the settings page posts', () => {
  const value = sanitizeSettings({ mode: 'acme', acme: { domains: 'a.example.com, *.b.example.com' } });
  assert.deepEqual(value.acme.domains, ['a.example.com', '*.b.example.com']);
  assert.equal(value.mode, 'acme');
});
