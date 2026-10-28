import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDir(dir, mode = 0o700) {
  await mkdir(dir, { recursive: true, mode });
  try {
    await chmod(dir, mode);
  } catch {
    // Best effort: the directory may be on a filesystem without chmod support.
  }
}

export async function atomicWrite(file, data, mode = 0o644) {
  await ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, file);
  try {
    await chmod(file, mode);
  } catch {
    // Best effort.
  }
}

export async function readIfExists(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function statMode(file) {
  try {
    const info = await stat(file);
    return { mode: info.mode & 0o777, size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function copyIfExists(from, to) {
  try {
    await copyFile(from, to);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function removeIfExists(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

export function splitPemBlocks(text) {
  const input = String(text ?? '');
  const blocks = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;
  let match;
  while ((match = re.exec(input))) {
    blocks.push({ label: match[1], pem: match[0] });
  }
  return blocks;
}

export function normalizePem(text) {
  return `${String(text).replace(/\r\n/g, '\n').trim()}\n`;
}

export function pemToDer(pem) {
  return Buffer.from(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

export function fingerprintSha256(pem) {
  const hex = createHash('sha256').update(pemToDer(pem)).digest('hex').toUpperCase();
  return hex.match(/.{2}/g).join(':');
}

export function daysLeft(date, now = Date.now()) {
  const value = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(value)) return null;
  return Math.floor((value - now) / 86_400_000);
}

export function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function sanitizeError(error, fallback = 'unknown error') {
  if (!error) return fallback;
  let message;
  if (typeof error === 'string') message = error;
  else if (typeof error.message === 'string') message = error.message;
  else message = String(error);
  message = message.replace(/\s+/g, ' ').trim();
  if (message.length > 400) message = `${message.slice(0, 397)}...`;
  return message || fallback;
}

export function errorCode(error) {
  return error && typeof error.code === 'string' ? error.code : undefined;
}

export function stripTrailingDot(value) {
  return String(value ?? '').trim().replace(/\.$/, '');
}

export function redactErrorMessage(message) {
  return String(message)
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/("?(?:secretId|secretKey|token|password|apiKey)"?\s*[:=]\s*")[^"]+"/gi, '$1***"');
}
