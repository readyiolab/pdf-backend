/**
 * AES-256-GCM for BYOC credentials at rest.
 *
 * Ciphertext formats:
 *   - Legacy: base64(iv(12) || authTag(16) || ciphertext)
 *   - Versioned: `v1:` + base64(...)  (current key)
 *
 * Rotation: set INFRA_CREDENTIALS_KEY to the new key and
 * INFRA_CREDENTIALS_KEY_PREVIOUS to the old one. Decrypt tries current then
 * previous; encrypt always uses current and prefixes `v1:`.
 * Callers may re-encrypt lazily on read via reencryptIfNeeded().
 */
import crypto from 'crypto';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler.middleware';

const CURRENT_PREFIX = 'v1:';

function decodeKeyMaterial(raw: string, label: string): Buffer {
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new AppError(`${label} must decode to exactly 32 bytes (AES-256).`, 503);
  }
  return key;
}

function resolveCurrentKey(): Buffer {
  const raw = env.INFRA_CREDENTIALS_KEY?.trim();
  if (!raw) {
    throw new AppError(
      'Server is missing INFRA_CREDENTIALS_KEY — cannot store infrastructure secrets.',
      503
    );
  }
  return decodeKeyMaterial(raw, 'INFRA_CREDENTIALS_KEY');
}

function resolvePreviousKey(): Buffer | null {
  const raw = env.INFRA_CREDENTIALS_KEY_PREVIOUS?.trim();
  if (!raw) return null;
  return decodeKeyMaterial(raw, 'INFRA_CREDENTIALS_KEY_PREVIOUS');
}

export function isSecretBoxConfigured(): boolean {
  try {
    resolveCurrentKey();
    return true;
  } catch {
    return false;
  }
}

function encryptWithKey(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptWithKey(payload: string, key: Buffer): string {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < 12 + 16 + 1) {
    throw new AppError('Invalid encrypted credential payload', 500);
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function encryptSecret(plain: string): string {
  return CURRENT_PREFIX + encryptWithKey(plain, resolveCurrentKey());
}

export function decryptSecret(payload: string): string {
  const stripped = payload.startsWith(CURRENT_PREFIX)
    ? payload.slice(CURRENT_PREFIX.length)
    : payload;

  const keys = [resolveCurrentKey()];
  const prev = resolvePreviousKey();
  if (prev) keys.push(prev);

  let lastErr: unknown;
  for (const key of keys) {
    try {
      return decryptWithKey(stripped, key);
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr instanceof AppError) throw lastErr;
  throw new AppError('Could not decrypt credential payload with available keys', 500);
}

/** True when ciphertext was produced with a previous key (or legacy unprefixed). */
export function needsReencrypt(payload: string): boolean {
  return !payload.startsWith(CURRENT_PREFIX);
}

/** Re-encrypt with the current key if needed. Returns null when unchanged. */
export function reencryptIfNeeded(payload: string): string | null {
  if (!needsReencrypt(payload)) return null;
  const plain = decryptSecret(payload);
  return encryptSecret(plain);
}

export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson<T = unknown>(payload: string): T {
  return JSON.parse(decryptSecret(payload)) as T;
}
