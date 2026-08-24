/**
 * Worker object storage — platform Spaces by default; BYOC when the job
 * carries an organizationId (resolved from MySQL + INFRA_CREDENTIALS_KEY).
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';
import { env } from '../config/env';
import { db } from '../lib/mysql';
import { logger } from '../lib/logger';
import { redis } from '../lib/redis';
import { getJobOrganizationId, getJobStorageBindingId } from './context';

type ResolvedClient =
  | { kind: 's3'; bucket: string; client: S3Client }
  | { kind: 'azure'; bucket: string; service: BlobServiceClient };

const TEMP_DIR = path.join(process.cwd(), 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const cache = new Map<string, { client: ResolvedClient; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_CHANNEL = 'byoc:storage-cache-invalidate';
const CIRCUIT_TTL_MS = 60_000;
const openCircuits = new Map<string, number>();
let cacheSubStarted = false;

function tripCircuit(organizationId: string): void {
  openCircuits.set(organizationId, Date.now() + CIRCUIT_TTL_MS);
}

function isCircuitOpen(organizationId: string): boolean {
  const until = openCircuits.get(organizationId);
  if (!until) return false;
  if (Date.now() >= until) {
    openCircuits.delete(organizationId);
    return false;
  }
  return true;
}

function isTerminalStorageError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '').toLowerCase();
  const code = String((err as any)?.name || (err as any)?.Code || (err as any)?.code || '');
  return [
    'InvalidAccessKeyId',
    'SignatureDoesNotMatch',
    'AccessDenied',
    'NoSuchBucket',
    'AuthenticationFailed',
    'AuthorizationFailure',
  ].some((c) => code.includes(c) || msg.includes(c.toLowerCase()));
}

async function markOrgStorageError(organizationId: string, errorMessage: string): Promise<void> {
  const rows = await db.queryAll(
    `SELECT status, consecutiveFailures, activeBindingId, provider
       FROM tbl_org_storage_config WHERE organizationId = ? LIMIT 1`,
    [organizationId]
  );
  const cfg = rows[0] as any;
  if (!cfg || cfg.provider === 'PLATFORM') return;

  const wasHealthy = cfg.status === 'CONNECTED';
  await db.execute(
    `UPDATE tbl_org_storage_config
        SET status = 'ERROR', lastError = ?, lastTestedAt = ?,
            consecutiveFailures = consecutiveFailures + 1
      WHERE organizationId = ?`,
    [errorMessage.slice(0, 2000), new Date(), organizationId]
  );
  tripCircuit(organizationId);
  invalidateLocalCache(organizationId, cfg.activeBindingId);
  await redis
    .publish(CACHE_CHANNEL, JSON.stringify({ organizationId, bindingId: cfg.activeBindingId }))
    .catch(() => undefined);

  if (wasHealthy) {
    await redis
      .publish(
        'byoc:storage-health-alert',
        JSON.stringify({ organizationId, error: errorMessage })
      )
      .catch(() => undefined);
  }
}

function invalidateLocalCache(organizationId?: string, bindingId?: string): void {
  if (!organizationId && !bindingId) {
    cache.clear();
    return;
  }
  if (organizationId) cache.delete(`org:${organizationId}`);
  if (bindingId) cache.delete(`binding:${bindingId}`);
}

/** Subscribe to API/worker cache invalidation pub/sub. Call once at boot. */
export function startWorkerStorageCacheSubscriber(): void {
  if (cacheSubStarted) return;
  cacheSubStarted = true;
  try {
    const sub = redis.duplicate();
    void sub.subscribe(CACHE_CHANNEL);
    sub.on('message', (_ch, message) => {
      try {
        const { organizationId, bindingId } = JSON.parse(message) as {
          organizationId?: string;
          bindingId?: string;
        };
        invalidateLocalCache(organizationId, bindingId);
        if (!organizationId && !bindingId) cache.clear();
      } catch {
        /* ignore */
      }
    });
    logger.info('Worker BYOC storage cache subscriber started');
  } catch (err) {
    logger.warn({ err }, 'Worker BYOC storage cache pub/sub unavailable');
  }
}

function platformClient(): ResolvedClient {
  return {
    kind: 's3',
    bucket: env.DO_SPACES_BUCKET,
    client: new S3Client({
      endpoint: env.DO_SPACES_ENDPOINT,
      region: env.DO_SPACES_REGION,
      credentials: {
        accessKeyId: env.DO_SPACES_KEY,
        secretAccessKey: env.DO_SPACES_SECRET,
      },
      forcePathStyle: false,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }),
  };
}

/** Legacy export used by older call sites (platform client only). */
export const s3 = (() => {
  const p = platformClient();
  if (p.kind !== 's3') throw new Error('Platform client must be S3');
  return p.client;
})();

function decodeKeyMaterial(raw: string): Buffer {
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('INFRA_CREDENTIALS_KEY must be 32 bytes');
  return key;
}

function decryptWithKey(payload: string, key: Buffer): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function decryptJson(payload: string): any {
  const current = env.INFRA_CREDENTIALS_KEY?.trim();
  if (!current) throw new Error('INFRA_CREDENTIALS_KEY is not configured on the worker');

  const stripped = payload.startsWith('v1:') ? payload.slice(3) : payload;
  const keys = [decodeKeyMaterial(current)];
  const prev = env.INFRA_CREDENTIALS_KEY_PREVIOUS?.trim();
  if (prev) keys.push(decodeKeyMaterial(prev));

  let lastErr: unknown;
  for (const key of keys) {
    try {
      return JSON.parse(decryptWithKey(stripped, key));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Could not decrypt BYOC credentials');
}

function buildS3(
  region: string | null,
  endpoint: string | null,
  accessKeyId: string,
  secretAccessKey: string,
  forcePathStyle: boolean,
  bucket: string
): ResolvedClient {
  return {
    kind: 's3',
    bucket,
    client: new S3Client({
      region: region || 'us-east-1',
      endpoint: endpoint || undefined,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }),
  };
}

function clientFromBindingRow(row: any): ResolvedClient {
  const creds = row.encryptedCredentials ? decryptJson(row.encryptedCredentials) : {};
  const bucket = String(row.bucket || '');
  if (!bucket) throw new Error('BYOC bucket is missing');

  if (row.provider === 'AZURE_BLOB') {
    let service: BlobServiceClient;
    if (creds.connectionString) {
      service = BlobServiceClient.fromConnectionString(creds.connectionString);
    } else if (creds.accountName && creds.accountKey) {
      service = new BlobServiceClient(
        `https://${creds.accountName}.blob.core.windows.net`,
        new StorageSharedKeyCredential(creds.accountName, creds.accountKey)
      );
    } else {
      throw new Error('Azure credentials incomplete');
    }
    return { kind: 'azure', bucket, service };
  }

  if (row.provider === 'R2' || row.provider === 'MINIO' || row.provider === 'GCS') {
    return buildS3(
      row.region,
      row.endpoint || (row.provider === 'GCS' ? 'https://storage.googleapis.com' : null),
      creds.accessKeyId,
      creds.secretAccessKey,
      true,
      bucket
    );
  }

  return buildS3(
    row.region,
    row.endpoint,
    creds.accessKeyId,
    creds.secretAccessKey,
    Boolean(row.endpoint),
    bucket
  );
}

async function resolveByBindingId(bindingId: string): Promise<ResolvedClient> {
  const cacheKey = `binding:${bindingId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.client;

  const rows = await db.queryAll(
    'SELECT * FROM tbl_org_storage_binding WHERE id = ? LIMIT 1',
    [bindingId]
  );
  const row = rows[0] as any;
  if (!row || row.provider === 'PLATFORM') return platformClient();

  const resolved = clientFromBindingRow(row);
  cache.set(cacheKey, { client: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
  return resolved;
}

async function resolveClient(
  organizationId: string | null,
  storageBindingId?: string | null
): Promise<ResolvedClient> {
  if (storageBindingId) {
    return resolveByBindingId(storageBindingId);
  }
  if (!organizationId) return platformClient();

  if (isCircuitOpen(organizationId)) {
    throw new Error('Organization cloud storage circuit open');
  }

  const cached = cache.get(`org:${organizationId}`);
  if (cached && cached.expiresAt > Date.now()) return cached.client;

  const orgRows = await db.queryAll('SELECT id, status FROM tbl_organization WHERE id = ? LIMIT 1', [
    organizationId,
  ]);
  const org = orgRows[0] as any;
  if (!org) return platformClient();
  if (org.status !== 'ACTIVE') {
    throw new Error('Organization is suspended');
  }

  const cfgRows = await db.queryAll(
    'SELECT * FROM tbl_org_storage_config WHERE organizationId = ? LIMIT 1',
    [organizationId]
  );
  const cfg = cfgRows[0] as any;
  if (!cfg || cfg.provider === 'PLATFORM' || cfg.status === 'UNCONFIGURED') {
    const p = platformClient();
    cache.set(`org:${organizationId}`, { client: p, expiresAt: Date.now() + CACHE_TTL_MS });
    return p;
  }
  if (cfg.status === 'ERROR') {
    tripCircuit(organizationId);
    throw new Error('Organization cloud storage is in ERROR state');
  }

  if (cfg.activeBindingId) {
    const resolved = await resolveByBindingId(cfg.activeBindingId);
    cache.set(`org:${organizationId}`, { client: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
    return resolved;
  }

  // Legacy config without binding row
  const resolved = clientFromBindingRow(cfg);
  cache.set(`org:${organizationId}`, { client: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
  return resolved;
}

function rewriteResultKey(destinationKey: string, organizationId: string | null): string {
  if (!organizationId) return destinationKey;
  if (destinationKey.startsWith('pdf-saas-results/')) {
    return destinationKey.replace('pdf-saas-results/', `org-${organizationId}/results/`);
  }
  return destinationKey;
}

export async function downloadFromS3(fileKey: string): Promise<string> {
  const storageBindingId = getJobStorageBindingId();
  const organizationId = getJobOrganizationId() ?? organizationIdFromKey(fileKey);
  logger.info({ fileKey, organizationId, storageBindingId }, 'Downloading file from storage');

  try {
    const resolved = await resolveClient(organizationId, storageBindingId);
    const fileExt = path.extname(fileKey);
    const tempFileName = `${crypto.randomUUID()}${fileExt}`;
    const localFilePath = path.join(TEMP_DIR, tempFileName);

    if (resolved.kind === 'azure') {
      const container = resolved.service.getContainerClient(resolved.bucket);
      const blob = container.getBlobClient(fileKey);
      await blob.downloadToFile(localFilePath);
    } else {
      const response = await resolved.client.send(
        new GetObjectCommand({ Bucket: resolved.bucket, Key: fileKey })
      );
      if (!response.Body) throw new Error(`Object Body is empty for key: ${fileKey}`);
      const writeStream = fs.createWriteStream(localFilePath);
      await pipeline(response.Body as any, writeStream);
    }

    logger.debug({ fileKey, localFilePath }, 'Storage download complete');
    return localFilePath;
  } catch (err) {
    if (organizationId && isTerminalStorageError(err)) {
      await markOrgStorageError(organizationId, String((err as any)?.message || err)).catch(
        () => undefined
      );
    }
    throw err;
  }
}

export async function uploadToS3(
  localFilePath: string,
  destinationKey: string,
  contentType: string
): Promise<string> {
  const organizationId = getJobOrganizationId();
  const storageBindingId = getJobStorageBindingId();
  const key = rewriteResultKey(destinationKey, organizationId);
  logger.info(
    { localFilePath, destinationKey: key, organizationId, storageBindingId },
    'Uploading file to storage'
  );

  try {
    const resolved = await resolveClient(organizationId, storageBindingId);

    if (resolved.kind === 'azure') {
      const container = resolved.service.getContainerClient(resolved.bucket);
      const block = container.getBlockBlobClient(key);
      await block.uploadFile(localFilePath, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
    } else {
      const body = fs.createReadStream(localFilePath);
      await resolved.client.send(
        new PutObjectCommand({
          Bucket: resolved.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        })
      );
    }

    return key;
  } catch (err) {
    if (organizationId && isTerminalStorageError(err)) {
      await markOrgStorageError(organizationId, String((err as any)?.message || err)).catch(
        () => undefined
      );
    }
    throw err;
  }
}

export async function deleteFromS3(keys: string[]): Promise<void> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return;

  const bindingId = getJobStorageBindingId();
  if (bindingId) {
    try {
      const resolved = await resolveByBindingId(bindingId);
      if (resolved.kind === 'azure') {
        const container = resolved.service.getContainerClient(resolved.bucket);
        await Promise.all(unique.map((k) => container.getBlobClient(k).deleteIfExists()));
      } else {
        for (let i = 0; i < unique.length; i += 1000) {
          const chunk = unique.slice(i, i + 1000);
          await resolved.client.send(
            new DeleteObjectsCommand({
              Bucket: resolved.bucket,
              Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
            })
          );
        }
      }
    } catch (err) {
      logger.warn({ err, bindingId }, 'Failed to delete objects from storage');
    }
    return;
  }

  const groups = new Map<string | null, string[]>();
  for (const key of unique) {
    const orgId = getJobOrganizationId() ?? organizationIdFromKey(key);
    const list = groups.get(orgId) ?? [];
    list.push(key);
    groups.set(orgId, list);
  }

  for (const [orgId, groupKeys] of groups) {
    try {
      const resolved = await resolveClient(orgId);
      if (resolved.kind === 'azure') {
        const container = resolved.service.getContainerClient(resolved.bucket);
        await Promise.all(groupKeys.map((k) => container.getBlobClient(k).deleteIfExists()));
      } else {
        for (let i = 0; i < groupKeys.length; i += 1000) {
          const chunk = groupKeys.slice(i, i + 1000);
          await resolved.client.send(
            new DeleteObjectsCommand({
              Bucket: resolved.bucket,
              Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
            })
          );
        }
      }
    } catch (err) {
      logger.warn({ err, orgId }, 'Failed to delete objects from storage');
    }
  }
}

function organizationIdFromKey(key: string): string | null {
  const m = key.match(/^org-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
  return m?.[1] ?? null;
}

export function cleanupLocalFile(filePath: string): void {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.debug({ filePath }, 'Cleaned up local temp file');
    }
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to delete local temp file');
  }
}

export { env };

// Touch unused import in case HeadBucket is needed later for health
void HeadBucketCommand;
