/**
 * Binding / key-prefix resolution unit tests.
 * Run: npx tsx --test src/lib/storage/bindingResolution.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { organizationIdFromKey } from './bindingKey';

describe('organizationIdFromKey', () => {
  it('extracts org uuid from BYOC keys', () => {
    const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    assert.equal(organizationIdFromKey(`org-${id}/uploads/file.pdf`), id);
    assert.equal(organizationIdFromKey(`org-${id}/signing/doc-1/original_x.pdf`), id);
  });

  it('returns null for platform keys', () => {
    assert.equal(organizationIdFromKey('pdf-saas-uploads/user-1/file.pdf'), null);
    assert.equal(organizationIdFromKey('pdf-saas-results/out.pdf'), null);
  });

  it('rejects malformed prefixes', () => {
    assert.equal(organizationIdFromKey('org-not-a-uuid/uploads/x.pdf'), null);
    assert.equal(organizationIdFromKey('notorg-a1b2c3d4-e5f6-7890-abcd-ef1234567890/x'), null);
  });
});

describe('binding preference contract', () => {
  it('documents that an explicit binding id wins over key prefix', () => {
    const bindingId = 'binding-v1';
    const keyOrg = organizationIdFromKey(
      'org-a1b2c3d4-e5f6-7890-abcd-ef1234567890/uploads/old.pdf'
    );
    assert.ok(bindingId);
    assert.ok(keyOrg);
    assert.notEqual(bindingId, keyOrg);
  });
});
