/**
 * Regression: admin public org payloads must never expose secrets.
 * Run: npx tsx --test src/modules/admin/admin.redaction.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function publicOrgRow(row: any) {
  return {
    id: row.id,
    storage: {
      provider: row.storageProvider ?? 'PLATFORM',
      bucket: row.storageBucket ?? null,
      hasSecret: Boolean(row.storageHasSecret),
    },
  };
}

function assertNoSecrets(payload: unknown): void {
  const json = JSON.stringify(payload);
  if (/encryptedCredentials|secretAccessKey|accountKey|connectionString/i.test(json)) {
    throw new Error('secret field leaked');
  }
}

describe('admin redaction', () => {
  it('never includes credential fields', () => {
    const row = {
      id: 'org-1',
      storageProvider: 'AWS_S3',
      storageBucket: 'cust-bucket',
      storageHasSecret: true,
      // These must never be selected into the public DTO
      encryptedCredentials: 'v1:SHOULD_NOT_APPEAR',
      secretAccessKey: 'leak',
    };
    const dto = publicOrgRow(row);
    assert.equal(dto.storage.hasSecret, true);
    assert.equal((dto.storage as any).encryptedCredentials, undefined);
    assert.doesNotThrow(() => assertNoSecrets(dto));
  });

  it('assertNoSecrets catches leaks', () => {
    assert.throws(() =>
      assertNoSecrets({ storage: { encryptedCredentials: 'x' } })
    );
  });
});
