import crypto from 'crypto';
import { env } from '../config/env';
import {
  getStorageForBinding,
  getStorageForOrg,
  getActiveStorageBindingId,
} from './storage';
import type { StorageProvider } from './storage/types';
import {
  createS3Client,
  S3CompatibleStorageProvider,
} from './storage/s3Compatible';
import { organizationIdFromKey } from './storage/bindingKey';

export { organizationIdFromKey } from './storage/bindingKey';

/** Legacy platform S3 client — prefer StorageProvider helpers below. */
export const s3 = createS3Client({
  region: env.DO_SPACES_REGION,
  endpoint: env.DO_SPACES_ENDPOINT,
  accessKeyId: env.DO_SPACES_KEY,
  secretAccessKey: env.DO_SPACES_SECRET,
  forcePathStyle: false,
});

export async function storageForBinding(
  bindingId: string | null | undefined
): Promise<StorageProvider> {
  return getStorageForBinding(bindingId);
}

/**
 * Resolve storage for a key when the caller has no binding id.
 * Platform keys → platform. org-* keys → active binding for that org (legacy).
 */
export async function storageForKey(key: string): Promise<StorageProvider> {
  const orgId = organizationIdFromKey(key);
  if (!orgId) return getStorageForBinding(null);
  const bindingId = await getActiveStorageBindingId(orgId);
  if (bindingId) return getStorageForBinding(bindingId);
  return getStorageForOrg(orgId, 'recipient_read');
}

function platformStorage(): StorageProvider {
  return new S3CompatibleStorageProvider('PLATFORM', env.DO_SPACES_BUCKET, s3);
}

async function resolve(
  key: string,
  bindingId?: string | null
): Promise<StorageProvider> {
  if (bindingId !== undefined) return storageForBinding(bindingId);
  return storageForKey(key);
}

export async function getSignedDownloadUrl(
  key: string,
  fileName?: string,
  ttlSeconds: number = env.DOWNLOAD_URL_TTL,
  bindingId?: string | null
): Promise<string> {
  const storage = await resolve(key, bindingId);
  return storage.presignGet(key, {
    ttlSeconds,
    fileName,
    disposition: 'attachment',
  });
}

export async function copyObject(
  sourceKey: string,
  destKey: string,
  bindingId?: string | null
): Promise<void> {
  const storage = await resolve(sourceKey, bindingId);
  await storage.copyObject(sourceKey, destKey);
}

export async function getSignedViewUrl(
  key: string,
  ttlSeconds: number = env.DOWNLOAD_URL_TTL,
  bindingId?: string | null
): Promise<string> {
  const storage = await resolve(key, bindingId);
  return storage.presignGet(key, {
    ttlSeconds,
    disposition: 'inline',
    contentType: 'application/pdf',
  });
}

export async function headObjectSize(
  key: string,
  bindingId?: string | null
): Promise<number> {
  const storage = await resolve(key, bindingId);
  return storage.headSize(key);
}

export async function readObjectHead(
  key: string,
  bytes = 1024,
  bindingId?: string | null
): Promise<Buffer> {
  const storage = await resolve(key, bindingId);
  return storage.readHead(key, bytes);
}

export async function getObjectBytes(
  key: string,
  bindingId?: string | null
): Promise<Buffer> {
  const storage = await resolve(key, bindingId);
  return storage.getObjectBytes(key);
}

export async function hashObject(
  key: string,
  bindingId?: string | null
): Promise<string> {
  const orgId = organizationIdFromKey(key);
  if (!orgId && !bindingId) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const res = await s3.send(
      new GetObjectCommand({ Bucket: env.DO_SPACES_BUCKET, Key: key })
    );
    const hash = crypto.createHash('sha256');
    for await (const chunk of res.Body as AsyncIterable<Buffer>) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  }
  const bytes = await getObjectBytes(key, bindingId);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function deleteObject(
  key: string,
  bindingId?: string | null
): Promise<void> {
  const storage = await resolve(key, bindingId);
  await storage.deleteObject(key).catch(() => undefined);
}

/** Delete keys that may live in different bindings. Prefer grouped deletes. */
export async function deleteObjects(
  keys: string[],
  bindingId?: string | null
): Promise<void> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (bindingId !== undefined) {
    const storage = await storageForBinding(bindingId);
    await storage.deleteObjects(unique).catch(() => undefined);
    return;
  }

  const groups = new Map<string | null, string[]>();
  for (const key of unique) {
    const orgId = organizationIdFromKey(key);
    const list = groups.get(orgId) ?? [];
    list.push(key);
    groups.set(orgId, list);
  }
  for (const [orgId, groupKeys] of groups) {
    if (!orgId) {
      await platformStorage().deleteObjects(groupKeys).catch(() => undefined);
      continue;
    }
    const bid = await getActiveStorageBindingId(orgId);
    const storage = bid
      ? await getStorageForBinding(bid)
      : await getStorageForOrg(orgId, 'recipient_read');
    await storage.deleteObjects(groupKeys).catch(() => undefined);
  }
}

export async function putObjectBytes(
  key: string,
  body: Buffer,
  contentType?: string,
  bindingId?: string | null
): Promise<void> {
  const storage = await resolve(key, bindingId);
  await storage.putObject(key, body, contentType);
}
