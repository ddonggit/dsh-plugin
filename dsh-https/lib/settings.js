import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWrite, isPlainObject, sanitizeError } from './util.js';

// Runtime settings written by the settings page. The profile's
// cordis.patch.yml stays the source of defaults; this file only carries the
// values the user changed in the UI. Secrets never live here — API keys go to
// the credentials service (or the 0600 credentials file as a fallback).
export const SETTINGS_FILE_NAME = 'settings.json';
const SETTINGS_VERSION = 1;
export const MODES = new Set(['files', 'acme']);

export function settingsPath(dataDir) {
  return path.join(dataDir, SETTINGS_FILE_NAME);
}

export function emptySettings() {
  return { mode: null, acme: {} };
}

export function sanitizeSettings(value) {
  const raw = isPlainObject(value) ? value : {};
  const out = emptySettings();
  if (MODES.has(raw.mode)) out.mode = raw.mode;
  const acme = isPlainObject(raw.acme) ? raw.acme : {};
  if (typeof acme.email === 'string') out.acme.email = acme.email.trim();
  if (typeof acme.domains === 'string' || Array.isArray(acme.domains)) {
    out.acme.domains = parseDomains(acme.domains);
  }
  if (typeof acme.zone === 'string') out.acme.zone = acme.zone.trim().toLowerCase().replace(/\.$/, '');
  if (typeof acme.staging === 'boolean') out.acme.staging = acme.staging;
  return out;
}

/**
 * Read the runtime settings file. A missing file is normal (first run); any
 * other failure is reported and treated as "no overrides" so a broken file can
 * never stop the plugin from starting.
 */
export function loadSettingsSync(dataDir, logger) {
  const file = settingsPath(dataDir);
  try {
    return sanitizeSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`[dsh-https] 读取 ${file} 失败，忽略运行时设置：${sanitizeError(error)}`);
    }
    return emptySettings();
  }
}

export async function saveSettings(dataDir, settings) {
  const file = settingsPath(dataDir);
  await atomicWrite(file, `${JSON.stringify({ version: SETTINGS_VERSION, ...settings }, null, 2)}\n`, 0o600);
  return file;
}

/** Split "a.com, *.b.com；c.com" (any common separator) into normalized names. */
export function parseDomains(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，;；、]+/);
  const out = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim().toLowerCase().replace(/\.$/, '');
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Merge the runtime overrides onto the profile config. Only the fields the
 * settings page owns are touched; everything else keeps the profile's value.
 */
export function mergeRawConfig(raw, settings) {
  const base = isPlainObject(raw) ? raw : {};
  const out = { ...base };
  const publicCert = { ...(isPlainObject(base.publicCert) ? base.publicCert : {}) };
  const acme = { ...(isPlainObject(base.acme) ? base.acme : {}) };
  const dns = { ...(isPlainObject(base.acme?.dns) ? base.acme.dns : {}) };

  if (settings?.mode) {
    publicCert.mode = settings.mode;
    acme.enabled = settings.mode === 'acme';
    if (settings.mode === 'acme') acme.agreeTos = true;
  }
  const override = isPlainObject(settings?.acme) ? settings.acme : {};
  if (typeof override.email === 'string' && override.email) acme.email = override.email;
  if (Array.isArray(override.domains) && override.domains.length > 0) acme.domains = override.domains;
  if (typeof override.staging === 'boolean') acme.staging = override.staging;
  if (typeof override.zone === 'string' && override.zone) dns.zone = override.zone;

  out.publicCert = publicCert;
  out.acme = { ...acme, dns };
  return out;
}
