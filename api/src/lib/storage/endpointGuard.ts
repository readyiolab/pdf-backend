/**
 * SSRF protection for customer-supplied BYOC endpoints.
 *
 * MinIO legitimately needs arbitrary hostnames; AWS/R2/GCS have fixed shapes.
 * Every endpoint is DNS-resolved and rejected if any A/AAAA is private,
 * link-local, loopback, or CGNAT.
 */
import dns from 'dns/promises';
import net from 'net';
import { AppError } from '../../middleware/errorHandler.middleware';
import { env } from '../../config/env';
import type { StorageProviderKind } from './types';

function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80:')) return true; // link-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
    if (normalized.startsWith('::ffff:')) {
      const v4 = normalized.slice(7);
      return isPrivateOrReservedIp(v4);
    }
    return false;
  }
  return true;
}

function assertHostnameShape(provider: StorageProviderKind, hostname: string): void {
  const host = hostname.toLowerCase();
  if (provider === 'R2') {
    if (!host.endsWith('.r2.cloudflarestorage.com')) {
      throw new AppError(
        'Cloudflare R2 endpoint must be https://<accountid>.r2.cloudflarestorage.com',
        400
      );
    }
    return;
  }
  if (provider === 'GCS') {
    if (host !== 'storage.googleapis.com') {
      throw new AppError('GCS endpoint must be https://storage.googleapis.com', 400);
    }
    return;
  }
  if (provider === 'AWS_S3') {
    if (
      host &&
      !host.endsWith('.amazonaws.com') &&
      host !== 's3.amazonaws.com'
    ) {
      throw new AppError(
        'AWS S3 custom endpoint must be an amazonaws.com hostname (or leave blank for regional default).',
        400
      );
    }
    return;
  }
  // MINIO / AZURE_BLOB: arbitrary host, IP rules apply below.
}

/**
 * Validates a customer-supplied endpoint URL before constructing an S3/Azure client.
 * No-op when endpoint is empty (AWS regional default / Azure account URL built internally).
 */
export async function assertSafeStorageEndpoint(
  provider: StorageProviderKind,
  endpoint: string | null | undefined
): Promise<void> {
  const raw = endpoint?.trim();
  if (!raw) {
    if (provider === 'R2' || provider === 'MINIO') {
      throw new AppError(`${provider} requires an endpoint URL`, 400);
    }
    return;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('Storage endpoint must be a valid URL', 400);
  }

  if (url.protocol === 'http:') {
    if (env.NODE_ENV === 'production' && !env.BYOC_ALLOW_INSECURE_ENDPOINTS) {
      throw new AppError(
        'HTTP endpoints are not allowed in production. Use HTTPS, or set BYOC_ALLOW_INSECURE_ENDPOINTS=true for trusted MinIO.',
        400
      );
    }
  } else if (url.protocol !== 'https:') {
    throw new AppError('Storage endpoint must use https:// (or http:// only when explicitly allowed)', 400);
  }

  if (url.username || url.password) {
    throw new AppError('Storage endpoint must not include credentials in the URL', 400);
  }

  const hostname = url.hostname;
  if (!hostname) throw new AppError('Storage endpoint is missing a hostname', 400);

  // Literal IP in the URL — reject private ranges immediately
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new AppError('Storage endpoint must not target a private or reserved IP address', 400);
    }
  }

  assertHostnameShape(provider, hostname);

  // DNS resolution — reject if ANY record is private (DNS rebinding mitigation)
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!results.length) {
      throw new AppError('Storage endpoint hostname could not be resolved', 400);
    }
    for (const r of results) {
      if (isPrivateOrReservedIp(r.address)) {
        throw new AppError(
          'Storage endpoint resolves to a private or reserved IP address and is not allowed',
          400
        );
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      `Could not resolve storage endpoint hostname: ${(err as Error).message}`,
      400
    );
  }
}

/** Exported for unit tests. */
export const _test = { isPrivateOrReservedIp, assertHostnameShape };
