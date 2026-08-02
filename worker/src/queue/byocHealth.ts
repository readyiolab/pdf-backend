/**
 * Periodic BYOC health probe — runs inside the worker maintenance loop.
 * Marks CONNECTED / ERROR on tbl_org_storage_config and writes audit on
 * healthy → ERROR transitions.
 */
import crypto from 'crypto';
import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
} from '@aws-sdk/client-s3';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { db } from '../lib/mysql';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { redis } from '../lib/redis';

function decodeKeyMaterial(raw: string): Buffer {
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('bad key');
  return key;
}

function decryptJson(payload: string): any {
  const current = env.INFRA_CREDENTIALS_KEY?.trim();
  if (!current) throw new Error('INFRA_CREDENTIALS_KEY missing');
  const stripped = payload.startsWith('v1:') ? payload.slice(3) : payload;
  const keys = [decodeKeyMaterial(current)];
  const prev = env.INFRA_CREDENTIALS_KEY_PREVIOUS?.trim();
  if (prev) keys.push(decodeKeyMaterial(prev));
  for (const key of keys) {
    try {
      const buf = Buffer.from(stripped, 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const data = buf.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
      );
    } catch {
      /* try next */
    }
  }
  throw new Error('decrypt failed');
}

function isTerminal(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '').toLowerCase();
  const code = String((err as any)?.name || (err as any)?.Code || '');
  return [
    'InvalidAccessKeyId',
    'SignatureDoesNotMatch',
    'AccessDenied',
    'NoSuchBucket',
    'AuthenticationFailed',
    'AuthorizationFailure',
  ].some((c) => code.includes(c) || msg.includes(c.toLowerCase()));
}

async function probeBinding(binding: any): Promise<{ ok: boolean; corsOk: boolean; error?: string }> {
  const creds = binding.encryptedCredentials ? decryptJson(binding.encryptedCredentials) : {};
  const bucket = String(binding.bucket || '');
  if (!bucket) return { ok: false, corsOk: false, error: 'missing bucket' };

  try {
    if (binding.provider === 'AZURE_BLOB') {
      let service: BlobServiceClient;
      if (creds.connectionString) {
        service = BlobServiceClient.fromConnectionString(creds.connectionString);
      } else {
        service = new BlobServiceClient(
          `https://${creds.accountName}.blob.core.windows.net`,
          new StorageSharedKeyCredential(creds.accountName, creds.accountKey)
        );
      }
      const container = service.getContainerClient(bucket);
      if (!(await container.exists())) {
        return { ok: false, corsOk: false, error: 'container missing' };
      }
      const probe = `.pdftoolkit-health/${Date.now()}.txt`;
      await container.getBlockBlobClient(probe).uploadData(Buffer.from('ok'));
      await container.getBlobClient(probe).deleteIfExists();
      let corsOk = false;
      try {
        const props = await service.getProperties();
        corsOk = (props.cors ?? []).length > 0;
      } catch {
        corsOk = false;
      }
      return { ok: true, corsOk };
    }

    const forcePathStyle =
      binding.provider === 'R2' || binding.provider === 'MINIO' || binding.provider === 'GCS';
    const client = new S3Client({
      region: binding.region || 'us-east-1',
      endpoint:
        binding.endpoint ||
        (binding.provider === 'GCS' ? 'https://storage.googleapis.com' : undefined),
      forcePathStyle,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
    });
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    }
    const probeKey = `.pdftoolkit-health/${Date.now()}.txt`;
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: probeKey, Body: Buffer.from('ok') })
    );
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: probeKey }));

    let corsOk = false;
    try {
      const cors = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
      corsOk = (cors.CORSRules ?? []).length > 0;
    } catch {
      corsOk = false;
    }
    return { ok: true, corsOk };
  } catch (err: any) {
    return { ok: false, corsOk: false, error: err?.message || String(err) };
  }
}

export async function runByocHealthSweep(): Promise<void> {
  if (!env.INFRA_CREDENTIALS_KEY) return;

  const configs = await db.queryAll(
    `SELECT c.*, b.id AS bindingId, b.provider AS bProvider, b.bucket AS bBucket,
            b.region AS bRegion, b.endpoint AS bEndpoint, b.encryptedCredentials AS bCreds,
            u.email AS ownerEmail, o.name AS orgName
       FROM tbl_org_storage_config c
       LEFT JOIN tbl_org_storage_binding b ON b.id = c.activeBindingId
       LEFT JOIN tbl_organization o ON o.id = c.organizationId
       LEFT JOIN tbl_user u ON u.id = o.ownerUserId
      WHERE c.provider <> 'PLATFORM'
        AND c.activeBindingId IS NOT NULL
        AND c.status IN ('CONNECTED', 'ERROR')
      LIMIT 200`
  );

  for (const cfg of configs as any[]) {
    const binding = {
      id: cfg.bindingId,
      provider: cfg.bProvider || cfg.provider,
      bucket: cfg.bBucket || cfg.bucket,
      region: cfg.bRegion || cfg.region,
      endpoint: cfg.bEndpoint || cfg.endpoint,
      encryptedCredentials: cfg.bCreds || cfg.encryptedCredentials,
    };

    const prevStatus = cfg.status;
    const result = await probeBinding(binding);
    const now = new Date();

    if (result.ok) {
      await db.execute(
        `UPDATE tbl_org_storage_config
            SET status = 'CONNECTED', lastTestedAt = ?, lastHealthyAt = ?,
                lastError = NULL, consecutiveFailures = 0,
                corsVerifiedAt = IF(?, ?, corsVerifiedAt)
          WHERE organizationId = ?`,
        [now, now, result.corsOk ? 1 : 0, result.corsOk ? now : null, cfg.organizationId]
      );
    } else {
      const failures = Number(cfg.consecutiveFailures || 0) + 1;
      const shouldError = isTerminal(result.error) || failures >= 3;
      await db.execute(
        `UPDATE tbl_org_storage_config
            SET status = ?, lastTestedAt = ?, lastError = ?, consecutiveFailures = ?
          WHERE organizationId = ?`,
        [
          shouldError ? 'ERROR' : cfg.status,
          now,
          (result.error || 'unknown').slice(0, 2000),
          failures,
          cfg.organizationId,
        ]
      );

      if (shouldError && prevStatus === 'CONNECTED') {
        logger.warn(
          {
            organizationId: cfg.organizationId,
            orgName: cfg.orgName,
            ownerEmail: cfg.ownerEmail,
            error: result.error,
          },
          'BYOC storage transitioned CONNECTED → ERROR — owner should fix Settings → Cloud storage'
        );
        await db
          .insert('tbl_org_infra_audit', {
            id: crypto.randomUUID(),
            organizationId: cfg.organizationId,
            actorId: null,
            action: 'STORAGE_HEALTH_ERROR',
            detail: result.error || 'health check failed',
            ipAddress: null,
          })
          .catch(() => undefined);

        // API process emails the owner (has SMTP); invalidate caches on both sides
        await redis
          .publish(
            'byoc:storage-health-alert',
            JSON.stringify({
              organizationId: cfg.organizationId,
              error: result.error,
              orgName: cfg.orgName,
              ownerEmail: cfg.ownerEmail,
            })
          )
          .catch(() => undefined);
        await redis
          .publish(
            'byoc:storage-cache-invalidate',
            JSON.stringify({
              organizationId: cfg.organizationId,
              bindingId: cfg.bindingId,
            })
          )
          .catch(() => undefined);
      }
    }
  }

  logger.info({ checked: configs.length }, 'BYOC health sweep complete');
}
