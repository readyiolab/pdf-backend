/**
 * Unit tests for secretBox key rotation.
 * Run: npx tsx --test src/lib/secretBox.test.ts
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

const KEY_A = crypto.randomBytes(32).toString('base64');
const KEY_B = crypto.randomBytes(32).toString('base64');

process.env.INFRA_CREDENTIALS_KEY = KEY_B;
process.env.INFRA_CREDENTIALS_KEY_PREVIOUS = KEY_A;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-chars!!';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.DO_SPACES_KEY = process.env.DO_SPACES_KEY || 'x';
process.env.DO_SPACES_SECRET = process.env.DO_SPACES_SECRET || 'x';
process.env.DO_SPACES_BUCKET = process.env.DO_SPACES_BUCKET || 'b';
process.env.DO_SPACES_ENDPOINT =
  process.env.DO_SPACES_ENDPOINT || 'https://blr1.digitaloceanspaces.com';
process.env.DO_SPACES_REGION = process.env.DO_SPACES_REGION || 'blr1';
process.env.MYSQL_HOST = process.env.MYSQL_HOST || '127.0.0.1';
process.env.MYSQL_USER = process.env.MYSQL_USER || 'root';
process.env.MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || 'root';
process.env.MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'pdfsaas';

function encryptWithKey(plain: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

describe('secretBox rotation', () => {
  let encryptJson: typeof import('./secretBox').encryptJson;
  let decryptJson: typeof import('./secretBox').decryptJson;
  let needsReencrypt: typeof import('./secretBox').needsReencrypt;
  let reencryptIfNeeded: typeof import('./secretBox').reencryptIfNeeded;

  before(async () => {
    const mod = await import('./secretBox');
    encryptJson = mod.encryptJson;
    decryptJson = mod.decryptJson;
    needsReencrypt = mod.needsReencrypt;
    reencryptIfNeeded = mod.reencryptIfNeeded;
  });

  it('round-trips JSON with v1: prefix under current key', () => {
    const payload = encryptJson({ accessKeyId: 'AKIA', secretAccessKey: 'secret' });
    assert.ok(payload.startsWith('v1:'));
    assert.deepEqual(decryptJson(payload), {
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    });
    assert.equal(needsReencrypt(payload), false);
  });

  it('decrypts ciphertext produced with the previous key', () => {
    const legacy = encryptWithKey(JSON.stringify({ accessKeyId: 'OLD' }), KEY_A);
    assert.deepEqual(decryptJson(legacy), { accessKeyId: 'OLD' });
    assert.equal(needsReencrypt(legacy), true);
    const rotated = reencryptIfNeeded(legacy);
    assert.ok(rotated);
    assert.ok(rotated!.startsWith('v1:'));
    assert.deepEqual(decryptJson(rotated!), { accessKeyId: 'OLD' });
    assert.equal(needsReencrypt(rotated!), false);
  });
});
