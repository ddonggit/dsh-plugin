import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../lib/config.js';
import { createAcmeManager } from '../lib/acme.js';

function manager(acmeOverrides = {}) {
  const { config } = normalizeConfig({
    publicCert: { mode: 'acme' },
    acme: {
      enabled: true,
      email: 'a@example.com',
      domains: ['dsh.example.com'],
      agreeTos: true,
      checkIntervalHours: 6,
      ...acmeOverrides,
    },
  });
  return createAcmeManager({ config, certStore: {}, logger: {} });
}

test('retry delay backs off exponentially and caps at the check interval', () => {
  const acme = manager();
  assert.equal(acme.nextDelay(), 6 * 3_600_000);
  acme.failures = 1;
  assert.equal(acme.nextDelay(), 5 * 60_000);
  acme.failures = 2;
  assert.equal(acme.nextDelay(), 10 * 60_000);
  acme.failures = 3;
  assert.equal(acme.nextDelay(), 20 * 60_000);
  acme.failures = 12;
  assert.equal(acme.nextDelay(), 6 * 3_600_000);
});

test('files mode reports a dedicated misconfiguration reason', async () => {
  const acme = manager();
  acme.config.publicCert.mode = 'files';
  acme.config.acme.usable = false;
  await acme.start();
  assert.equal(acme.status().phase, 'misconfigured');
  assert.match(acme.status().lastError, /mode=files/);
});

test('stop() prevents further scheduling', () => {
  const acme = manager();
  acme.stop();
  acme.schedule(1000);
  assert.equal(acme.timer, null);
});
