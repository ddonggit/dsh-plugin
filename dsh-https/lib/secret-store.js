import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWrite, sanitizeError } from './util.js';

// Tencent Cloud API keypair entered on the settings page. Written next to the
// plugin's other state with mode 0600 and never echoed back to the browser:
// the status API only reports whether a key is stored and a masked hint.
export const SECRET_FILE_NAME = 'tencent-credentials.json';

export function secretsPath(dataDir) {
  return path.join(dataDir, SECRET_FILE_NAME);
}

export function emptySecrets() {
  return { secretId: '', secretKey: '' };
}

export function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 8) return '****';
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

export function loadSecretsSync(dataDir, logger) {
  try {
    const raw = JSON.parse(readFileSync(secretsPath(dataDir), 'utf8'));
    return {
      secretId: typeof raw?.secretId === 'string' ? raw.secretId : '',
      secretKey: typeof raw?.secretKey === 'string' ? raw.secretKey : '',
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`[dsh-https] 读取腾讯云密钥失败：${sanitizeError(error)}`);
    }
    return emptySecrets();
  }
}

/**
 * Store the keypair. An empty `secretKey` keeps the stored key, so the user
 * can change only the SecretId (or the reverse) without retyping both.
 */
export async function saveSecrets(dataDir, input, current = emptySecrets()) {
  const secretId = typeof input?.secretId === 'string' && input.secretId.trim() ? input.secretId.trim() : current.secretId;
  const secretKey =
    typeof input?.secretKey === 'string' && input.secretKey.trim() ? input.secretKey.trim() : current.secretKey;
  if (!secretId || !secretKey) throw new Error('腾讯云 SecretId 与 SecretKey 都需要填写');
  const file = secretsPath(dataDir);
  await atomicWrite(file, `${JSON.stringify({ secretId, secretKey }, null, 2)}\n`, 0o600);
  return { secretId, secretKey, file };
}
