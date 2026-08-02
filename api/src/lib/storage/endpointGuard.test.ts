/**
 * Unit tests for BYOC endpoint SSRF guard.
 * Run: npx tsx --test src/lib/storage/endpointGuard.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _test } from './endpointGuard';

describe('endpointGuard.isPrivateOrReservedIp', () => {
  it('rejects loopback and RFC1918', () => {
    assert.equal(_test.isPrivateOrReservedIp('127.0.0.1'), true);
    assert.equal(_test.isPrivateOrReservedIp('10.0.0.1'), true);
    assert.equal(_test.isPrivateOrReservedIp('192.168.1.1'), true);
    assert.equal(_test.isPrivateOrReservedIp('172.16.0.1'), true);
    assert.equal(_test.isPrivateOrReservedIp('169.254.169.254'), true);
    assert.equal(_test.isPrivateOrReservedIp('100.64.0.1'), true);
  });

  it('allows public addresses', () => {
    assert.equal(_test.isPrivateOrReservedIp('8.8.8.8'), false);
    assert.equal(_test.isPrivateOrReservedIp('1.1.1.1'), false);
  });
});

describe('endpointGuard.assertHostnameShape', () => {
  it('enforces R2 / GCS shapes', () => {
    assert.doesNotThrow(() =>
      _test.assertHostnameShape('R2', 'abc123.r2.cloudflarestorage.com')
    );
    assert.throws(() => _test.assertHostnameShape('R2', 'evil.example.com'));
    assert.doesNotThrow(() => _test.assertHostnameShape('GCS', 'storage.googleapis.com'));
    assert.throws(() => _test.assertHostnameShape('GCS', 'storage.example.com'));
  });
});
