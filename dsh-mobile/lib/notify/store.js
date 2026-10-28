/**
 * Files this plugin owns, all under `$DSH_HOME/dsh-mobile/`:
 *
 *   settings.json  user-entered channel config (0600, hot-reloaded)
 *   feed.key       permanent read key for the public event feed (0600)
 *   notify.log     delivery log (0600, rotated at 1 MiB)
 *
 * Nothing here is ever written into the workspace or the profile.
 */

import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watchFile,
  unwatchFile,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const SETTINGS_FILE = 'settings.json';
export const FEED_KEY_FILE = 'feed.key';
export const LOG_FILE = 'notify.log';
export const LOG_MAX_BYTES = 1024 * 1024;

export function pluginDir(homePath) {
  return path.join(homePath, 'dsh-mobile');
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Best-effort chmod; a read-only or foreign filesystem must not break startup. */
function tighten(file) {
  try {
    chmodSync(file, 0o600);
  } catch {
    // Ignore: ownership/permissions are advisory on some NAS filesystems.
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Runtime settings. A missing file is normal; a corrupt one is reported once
 * and treated as empty so a typo can never stop the plugin from starting.
 */
export function loadSettings(dir, logger) {
  const file = path.join(dir, SETTINGS_FILE);
  if (!existsSync(file)) return {};
  const parsed = readJson(file);
  if (parsed === undefined) {
    logger?.warn?.(`[dsh-mobile] ${file} 不是合法 JSON，已忽略运行时设置`);
    return {};
  }
  if (parsed && typeof parsed === 'object' && parsed.notify && typeof parsed.notify === 'object') {
    return parsed.notify;
  }
  return parsed && typeof parsed === 'object' ? parsed : {};
}

export function saveSettings(dir, notify, logger) {
  const file = writeRawSettings(dir, { version: 1, notify }, logger);
  logger?.info?.(`[dsh-mobile] 已保存通知设置到 ${file}`);
  return file;
}

/**
 * The settings document exactly as stored (never normalized).
 *
 * Reports a corrupt file instead of pretending it is empty: the host-settings
 * route merges a few fields into this document, and merging into `{}` would
 * write a fresh file over the channel webhooks and tokens that are still in the
 * damaged one. A missing (or empty) file is a legitimate empty document.
 *
 * @returns `{ ok: true, document }` or `{ ok: false, error }`.
 */
export function readSettingsDocument(dir) {
  const file = path.join(dir, SETTINGS_FILE);
  if (!existsSync(file)) return { ok: true, document: {} };
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: `cannot read settings.json: ${error?.message ?? error}` };
  }
  if (raw.trim() === '') return { ok: true, document: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `settings.json is not valid JSON: ${error?.message ?? error}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'settings.json is not a JSON object' };
  }
  return { ok: true, document: parsed };
}

/** Atomic 0600 write of a whole settings document (temp file + rename). */
export function writeRawSettings(dir, document, logger) {
  const file = path.join(dir, SETTINGS_FILE);
  const body = `${JSON.stringify(document, null, 2)}\n`;
  const temp = `${file}.tmp`;
  writeFileSync(temp, body, { mode: 0o600 });
  renameSync(temp, file);
  tighten(file);
  return file;
}

/** Watch settings.json; `onChange` runs with the freshly parsed block. */
export function watchSettings(dir, onChange, logger) {
  const file = path.join(dir, SETTINGS_FILE);
  if (!existsSync(file)) {
    // watchFile on a missing path still fires once it appears.
    try {
      writeFileSync(file, `${JSON.stringify({ version: 1, notify: {} }, null, 2)}\n`, { mode: 0o600 });
      tighten(file);
    } catch (error) {
      logger?.warn?.(`[dsh-mobile] 无法创建 ${file}：${error?.message ?? error}`);
      return () => {};
    }
  }
  const listener = (current) => {
    if (current.mtimeMs === 0 && !existsSync(file)) return;
    try {
      onChange(loadSettings(dir, logger));
    } catch (error) {
      logger?.warn?.(`[dsh-mobile] 重载 ${file} 失败：${error?.message ?? error}`);
    }
  };
  watchFile(file, { interval: 1000, persistent: false }, listener);
  return () => unwatchFile(file, listener);
}

/** Stable read key for the public feed; generated once, never rotated automatically. */
export function ensureFeedKey(dir) {
  const file = path.join(dir, FEED_KEY_FILE);
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  }
  const key = randomBytes(24).toString('base64url');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  tighten(file);
  return key;
}

export function rotateLogIfNeeded(dir) {
  const file = path.join(dir, LOG_FILE);
  try {
    if (statSync(file).size < LOG_MAX_BYTES) return;
    renameSync(file, `${file}.1`);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    try {
      unlinkSync(`${file}.1`);
      renameSync(file, `${file}.1`);
    } catch {
      // Rotation is best effort.
    }
  }
}

export function appendLog(dir, line) {
  const file = path.join(dir, LOG_FILE);
  try {
    rotateLogIfNeeded(dir);
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    tighten(file);
  } catch {
    // Logging must never break delivery.
  }
}
