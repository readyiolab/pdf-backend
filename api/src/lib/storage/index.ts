import crypto from 'crypto';
import { env } from '../../config/env';
import { db } from '../mysql';
import { decryptJson, reencryptIfNeeded } from '../secretBox';
import { AppError } from '../../middleware/errorHandler.middleware';
import { logger } from '../logger';
import { redis } from '../redis';
import type { Plan } from '../../../../shared/types';
import {
  createS3Client,
  S3CompatibleStorageProvider,
  requiredS3CorsConfig,
} from './s3Compatible';
import { AzureBlobStorageProvider, requiredAzureCorsConfig } from './azureBlob';
import { assertSafeStorageEndpoint } from './endpointGuard';
import {
  isStorageCircuitOpen,
  resetStorageCircuit,
  tripStorageCircuit,
} from './circuitBreaker';
import { publishByocHealthAlert } from './healthAlert';
import { invalidateUser, getCachedUser } from '../userCache';
import type {
  AzureCredentials,
  CorsCheckResult,
  GcsCredentials,
  ProviderCredentials,
  S3CompatibleCredentials,
  StorageProvider,
  StorageProviderKind,
} from './types';

const cache = new Map<string, { provider: StorageProvider; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
export const STORAGE_CACHE_CHANNEL = 'byoc:storage-cache-invalidate';
const CACHE_CHANNEL = STORAGE_CACHE_CHANNEL;
let cacheSubStarted = false;

export type StorageAccessMode = 'readwrite' | 'recipient_read';

function platformProvider(): StorageProvider {
  const client = createS3Client({
    region: env.DO_SPACES_REGION,
    endpoint: env.DO_SPACES_ENDPOINT,
    accessKeyId: env.DO_SPACES_KEY,
    secretAccessKey: env.DO_SPACES_SECRET,
    forcePathStyle: false,
  });
  return new S3CompatibleStorageProvider('PLATFORM', env.DO_SPACES_BUCKET, client);
}

export async function buildStorageProvider(opts: {
  provider: StorageProviderKind;
  bucket?: string | null;
  region?: string | null;
  endpoint?: string | null;
  credentials?: ProviderCredentials | null;
  /** Skip SSRF check when reconstructing from a trusted saved binding. */
  skipEndpointGuard?: boolean;
}): Promise<StorageProvider> {
  if (opts.provider === 'PLATFORM' || !opts.provider) {
    return platformProvider();
  }

  if (!opts.skipEndpointGuard) {
    await assertSafeStorageEndpoint(opts.provider, opts.endpoint);
    // Azure account endpoints are built internally; still guard connectionString host if present
    if (opts.provider === 'AZURE_BLOB') {
      const creds = opts.credentials as AzureCredentials | null;
      if (creds?.connectionString) {
        const match = /BlobEndpoint=([^;]+)/i.exec(creds.connectionString);
        if (match?.[1]) {
          await assertSafeStorageEndpoint('AZURE_BLOB', match[1]);
        }
      }
    }
  }

  const bucket = opts.bucket?.trim();
  if (!bucket) {
    throw new AppError('Bucket / container name is required for BYOC storage', 400);
  }

  if (opts.provider === 'AZURE_BLOB') {
    const creds = opts.credentials as AzureCredentials | null;
    return new AzureBlobStorageProvider({
      bucket,
      connectionString: creds?.connectionString,
      accountName: creds?.accountName,
      accountKey: creds?.accountKey,
    });
  }

  if (opts.provider === 'GCS') {
    const creds = opts.credentials as (S3CompatibleCredentials & Partial<GcsCredentials>) | null;
    if (!creds?.accessKeyId || !creds?.secretAccessKey) {
      throw new AppError(
        'Google Cloud Storage BYOC requires HMAC accessKeyId and secretAccessKey (S3 interoperable keys).',
        400
      );
    }
    const client = createS3Client({
      region: opts.region || 'auto',
      endpoint: opts.endpoint || 'https://storage.googleapis.com',
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      forcePathStyle: true,
    });
    return new S3CompatibleStorageProvider('GCS', bucket, client);
  }

  const creds = opts.credentials as S3CompatibleCredentials | null;
  if (!creds?.accessKeyId || !creds?.secretAccessKey) {
    throw new AppError('Access key and secret key are required', 400);
  }

  let endpoint = opts.endpoint || undefined;
  let region = opts.region || 'us-east-1';
  let forcePathStyle = false;

  if (opts.provider === 'R2') {
    if (!endpoint) {
      throw new AppError(
        'Cloudflare R2 requires an endpoint (https://<accountid>.r2.cloudflarestorage.com)',
        400
      );
    }
    region = opts.region || 'auto';
    forcePathStyle = true;
  } else if (opts.provider === 'MINIO') {
    if (!endpoint) {
      throw new AppError('MinIO requires an endpoint URL', 400);
    }
    forcePathStyle = true;
  } else if (opts.provider === 'AWS_S3') {
    endpoint = opts.endpoint || undefined;
    forcePathStyle = Boolean(opts.endpoint);
  }

  const client = createS3Client({
    region,
    endpoint,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    forcePathStyle,
  });
  return new S3CompatibleStorageProvider(opts.provider, bucket, client);
}

export function invalidateStorageCache(organizationId?: string, bindingId?: string): void {
  if (!organizationId && !bindingId) {
    cache.clear();
  } else {
    if (organizationId) {
      cache.delete(`org:${organizationId}`);
      cache.delete(`org:${organizationId}:recipient`);
    }
    if (bindingId) cache.delete(`binding:${bindingId}`);
  }
  // Best-effort cross-process invalidation
  void redis
    .publish(CACHE_CHANNEL, JSON.stringify({ organizationId, bindingId }))
    .catch(() => undefined);
}

/** Call once at API boot so all replicas drop stale providers. */
export function startStorageCacheInvalidationSubscriber(): void {
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
        if (!organizationId && !bindingId) {
          cache.clear();
          return;
        }
        if (organizationId) {
          cache.delete(`org:${organizationId}`);
          cache.delete(`org:${organizationId}:recipient`);
        }
        if (bindingId) cache.delete(`binding:${bindingId}`);
      } catch {
        /* ignore */
      }
    });
  } catch (err) {
    logger.warn({ err }, 'BYOC storage cache pub/sub unavailable');
  }
}

export async function getOrganizationIdForUser(userId: string): Promise<string | null> {
  // Prefer short-TTL CachedUser when present (auth middleware warms it).
  try {
    const cached = await getCachedUser(userId);
    if (cached && cached.organizationId !== undefined) {
      return cached.organizationId;
    }
  } catch {
    /* redis optional */
  }

  const user = await db.select('tbl_user', 'organizationId, plan', 'id = ?', [userId]);
  if (user?.organizationId) return user.organizationId as string;

  const org = await db.select('tbl_organization', 'id, status', 'ownerUserId = ?', [userId]);
  if (org?.id) {
    await db.update('tbl_user', { organizationId: org.id }, 'id = ?', [userId]).catch(() => undefined);
    await invalidateUser(userId).catch(() => undefined);
    return org.id as string;
  }
  return null;
}

export async function getActiveStorageBindingId(
  organizationId: string | null | undefined
): Promise<string | null> {
  if (!organizationId) return null;
  const cfg = await db.select(
    'tbl_org_storage_config',
    'activeBindingId, provider, status',
    'organizationId = ?',
    [organizationId]
  );
  if (!cfg || cfg.provider === 'PLATFORM' || !cfg.activeBindingId) return null;
  return cfg.activeBindingId as string;
}

/**
 * Resolve org + active binding for a user, using CachedUser when warm.
 */
export async function resolveUserStorageContext(userId: string): Promise<{
  organizationId: string | null;
  storageBindingId: string | null;
}> {
  try {
    const cached = await getCachedUser(userId);
    if (
      cached &&
      cached.organizationId !== undefined &&
      cached.storageBindingId !== undefined
    ) {
      return {
        organizationId: cached.organizationId,
        storageBindingId: cached.storageBindingId,
      };
    }
  } catch {
    /* redis optional */
  }

  const organizationId = await getOrganizationIdForUser(userId);
  const storageBindingId = await getActiveStorageBindingId(organizationId);
  return { organizationId, storageBindingId };
}

async function providerFromBindingRow(binding: any): Promise<StorageProvider> {
  let credentials: ProviderCredentials | null = null;
  if (binding.encryptedCredentials) {
    try {
      credentials = decryptJson<ProviderCredentials>(binding.encryptedCredentials);
      const rotated = reencryptIfNeeded(binding.encryptedCredentials);
      if (rotated) {
        await db
          .update(
            'tbl_org_storage_binding',
            { encryptedCredentials: rotated },
            'id = ?',
            [binding.id]
          )
          .catch(() => undefined);
      }
    } catch (err) {
      logger.error({ err, bindingId: binding.id }, 'Failed to decrypt BYOC binding credentials');
      throw new AppError('Could not decrypt storage credentials. Contact support.', 500);
    }
  }

  return buildStorageProvider({
    provider: binding.provider as StorageProviderKind,
    bucket: binding.bucket,
    region: binding.region,
    endpoint: binding.endpoint,
    credentials,
    skipEndpointGuard: true, // already validated at save time
  });
}

/**
 * Resolve storage for a specific binding (the one that wrote the object).
 * Null / missing → platform Spaces.
 */
export async function getStorageForBinding(
  bindingId: string | null | undefined
): Promise<StorageProvider> {
  if (!bindingId) return platformProvider();

  const cacheKey = `binding:${bindingId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.provider;

  const binding = await db.select('tbl_org_storage_binding', '*', 'id = ?', [bindingId]);
  if (!binding || binding.provider === 'PLATFORM') {
    return platformProvider();
  }

  const provider = await providerFromBindingRow(binding);
  cache.set(cacheKey, { provider, expiresAt: Date.now() + CACHE_TTL_MS });
  return provider;
}

/**
 * Resolve the org's *active* storage for new writes.
 * mode:
 *   - readwrite (default): suspended orgs and ERROR configs fail
 *   - recipient_read: allow reads for public signing even when suspended
 */
export async function getStorageForOrg(
  organizationId: string | null | undefined,
  mode: StorageAccessMode = 'readwrite'
): Promise<StorageProvider> {
  if (!organizationId) return platformProvider();

  const cacheKey = mode === 'recipient_read' ? `org:${organizationId}:recipient` : `org:${organizationId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.provider;

  const org = await db.select('tbl_organization', 'id, status', 'id = ?', [organizationId]);
  if (!org) return platformProvider();

  if (org.status !== 'ACTIVE' && mode === 'readwrite') {
    throw new AppError('This organization is suspended. Contact support.', 403);
  }

  if (mode === 'readwrite' && isStorageCircuitOpen(organizationId)) {
    throw new AppError(
      'Your cloud storage connection is temporarily unavailable. Try again shortly or fix it under Settings → Cloud storage.',
      503
    );
  }

  const cfg = await db.select('tbl_org_storage_config', '*', 'organizationId = ?', [organizationId]);
  if (!cfg || cfg.provider === 'PLATFORM' || cfg.status === 'UNCONFIGURED' || !cfg.activeBindingId) {
    const p = platformProvider();
    cache.set(cacheKey, { provider: p, expiresAt: Date.now() + CACHE_TTL_MS });
    return p;
  }

  if (cfg.status === 'ERROR' && mode === 'readwrite') {
    tripStorageCircuit(organizationId);
    throw new AppError(
      'Your cloud storage connection has an error. Fix it under Settings → Cloud storage, or switch back to platform storage.',
      503
    );
  }

  // Recipient reads of objects written under a prior binding should use
  // getStorageForBinding(doc.storageBindingId). Active org storage is for new writes.
  const binding = await db.select('tbl_org_storage_binding', '*', 'id = ?', [cfg.activeBindingId]);
  if (!binding) {
    return platformProvider();
  }

  const provider = await providerFromBindingRow(binding);
  cache.set(cacheKey, { provider, expiresAt: Date.now() + CACHE_TTL_MS });
  return provider;
}

export async function getStorageForUser(userId: string): Promise<{
  storage: StorageProvider;
  organizationId: string | null;
  storageBindingId: string | null;
  keyPrefix: string;
}> {
  const { organizationId, storageBindingId } = await resolveUserStorageContext(userId);
  const storage = await getStorageForOrg(organizationId, 'readwrite');
  const keyPrefix = organizationId
    ? `org-${organizationId}`
    : `pdf-saas-uploads/user-${userId}`;
  return { storage, organizationId, storageBindingId, keyPrefix };
}

/** Mark org storage ERROR after terminal auth/permission failures. */
export async function markOrgStorageError(
  organizationId: string,
  errorMessage: string
): Promise<{ transitionedToError: boolean }> {
  const cfg = await db.select(
    'tbl_org_storage_config',
    'status, consecutiveFailures, provider, activeBindingId',
    'organizationId = ?',
    [organizationId]
  );
  if (!cfg || cfg.provider === 'PLATFORM') return { transitionedToError: false };

  const wasHealthy = cfg.status === 'CONNECTED';
  await db.update(
    'tbl_org_storage_config',
    {
      status: 'ERROR',
      lastError: errorMessage.slice(0, 2000),
      lastTestedAt: new Date(),
      consecutiveFailures: Number(cfg.consecutiveFailures || 0) + 1,
    },
    'organizationId = ?',
    [organizationId]
  );
  tripStorageCircuit(organizationId);
  invalidateStorageCache(organizationId, cfg.activeBindingId ?? undefined);

  if (wasHealthy) {
    void publishByocHealthAlert({
      organizationId,
      error: errorMessage,
    });
  }

  return { transitionedToError: wasHealthy };
}

export async function markOrgStorageHealthy(
  organizationId: string,
  corsOk: boolean
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: 'CONNECTED',
    lastError: null,
    lastTestedAt: new Date(),
    lastHealthyAt: new Date(),
    consecutiveFailures: 0,
  };
  if (corsOk) patch.corsVerifiedAt = new Date();
  await db.update('tbl_org_storage_config', patch, 'organizationId = ?', [organizationId]);
  resetStorageCircuit(organizationId);
  invalidateStorageCache(organizationId);
}

/**
 * Call from runtime storage catch blocks. Marks ERROR + trips circuit on
 * terminal auth/permission failures; ignores timeouts/blips.
 */
export async function reportRuntimeStorageFailure(
  organizationId: string | null | undefined,
  err: unknown
): Promise<void> {
  if (!organizationId || !isTerminalStorageError(err)) return;
  const message = String((err as any)?.message || err || 'storage failure').slice(0, 2000);
  await markOrgStorageError(organizationId, message).catch(() => undefined);
}

export function isTerminalStorageError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '').toLowerCase();
  const code = String((err as any)?.name || (err as any)?.Code || (err as any)?.code || '');
  const terminalCodes = [
    'InvalidAccessKeyId',
    'SignatureDoesNotMatch',
    'AccessDenied',
    'NoSuchBucket',
    'InvalidBucketName',
    'AuthorizationFailure',
    'AuthenticationFailed',
    'AccountIsDisabled',
  ];
  if (terminalCodes.some((c) => code.includes(c) || msg.includes(c.toLowerCase()))) return true;
  if (msg.includes('credentials') && msg.includes('invalid')) return true;
  if (msg.includes('access denied') || msg.includes('forbidden')) return true;
  return false;
}

export function requiredCorsConfigFor(
  provider: StorageProviderKind,
  appOrigin: string
): string {
  if (provider === 'AZURE_BLOB') return requiredAzureCorsConfig(appOrigin);
  return requiredS3CorsConfig(appOrigin);
}

export async function runStorageTest(opts: {
  provider: StorageProviderKind;
  bucket?: string;
  region?: string;
  endpoint?: string;
  credentials?: ProviderCredentials | null;
}): Promise<{
  reachable: boolean;
  canWrite: boolean;
  corsOk: boolean;
  requiredCorsConfig: string;
  message: string;
}> {
  const requiredCorsConfig = requiredCorsConfigFor(opts.provider, env.APP_URL);
  if (opts.provider === 'PLATFORM') {
    return {
      reachable: true,
      canWrite: true,
      corsOk: true,
      requiredCorsConfig,
      message: 'Platform storage is ready',
    };
  }

  let provider: StorageProvider;
  try {
    provider = await buildStorageProvider(opts);
  } catch (err: any) {
    return {
      reachable: false,
      canWrite: false,
      corsOk: false,
      requiredCorsConfig,
      message: err?.message || 'Invalid storage configuration',
    };
  }

  let canWrite = false;
  try {
    await provider.ensureAccessible();
    canWrite = true;
  } catch (err: any) {
    return {
      reachable: false,
      canWrite: false,
      corsOk: false,
      requiredCorsConfig,
      message: err?.message || 'Could not reach or write to the bucket',
    };
  }

  let cors: CorsCheckResult;
  try {
    cors = await provider.checkCors(env.APP_URL);
  } catch (err: any) {
    cors = {
      ok: false,
      reason: err?.message || 'CORS check failed',
      requiredConfig: requiredCorsConfig,
    };
  }

  return {
    reachable: true,
    canWrite,
    corsOk: cors.ok,
    requiredCorsConfig: cors.requiredConfig || requiredCorsConfig,
    message: cors.ok
      ? 'Connected successfully — CORS verified'
      : cors.reason || 'Connected, but CORS is incomplete',
  };
}

/** Create a new immutable binding and point the org config at it. */
export async function activateNewBinding(
  organizationId: string,
  input: {
    provider: StorageProviderKind;
    bucket?: string | null;
    region?: string | null;
    endpoint?: string | null;
    encryptedCredentials: string | null;
    corsOk: boolean;
  }
): Promise<string | null> {
  // Retire previous active binding
  const prev = await db.select(
    'tbl_org_storage_config',
    'activeBindingId',
    'organizationId = ?',
    [organizationId]
  );
  if (prev?.activeBindingId) {
    await db
      .update(
        'tbl_org_storage_binding',
        { retiredAt: new Date() },
        'id = ? AND retiredAt IS NULL',
        [prev.activeBindingId]
      )
      .catch(() => undefined);
  }

  if (input.provider === 'PLATFORM') {
    await db.update(
      'tbl_org_storage_config',
      {
        provider: 'PLATFORM',
        bucket: null,
        region: null,
        endpoint: null,
        encryptedCredentials: null,
        activeBindingId: null,
        status: 'UNCONFIGURED',
        lastTestedAt: null,
        lastHealthyAt: null,
        lastError: null,
        consecutiveFailures: 0,
        corsVerifiedAt: null,
      },
      'organizationId = ?',
      [organizationId]
    );
    invalidateStorageCache(organizationId, prev?.activeBindingId ?? undefined);
    await invalidateOrgOwnerCaches(organizationId);
    return null;
  }

  const bindingId = crypto.randomUUID();
  await db.insert('tbl_org_storage_binding', {
    id: bindingId,
    organizationId,
    provider: input.provider,
    bucket: input.bucket || null,
    region: input.region || null,
    endpoint: input.endpoint || null,
    encryptedCredentials: input.encryptedCredentials,
  });

  const now = new Date();
  await db.update(
    'tbl_org_storage_config',
    {
      provider: input.provider,
      bucket: input.bucket || null,
      region: input.region || null,
      endpoint: input.endpoint || null,
      // Keep legacy columns populated for admin list / back-compat
      encryptedCredentials: input.encryptedCredentials,
      activeBindingId: bindingId,
      status: 'CONNECTED',
      lastTestedAt: now,
      lastHealthyAt: now,
      lastError: null,
      consecutiveFailures: 0,
      corsVerifiedAt: input.corsOk ? now : null,
    },
    'organizationId = ?',
    [organizationId]
  );

  resetStorageCircuit(organizationId);
  invalidateStorageCache(organizationId, bindingId);
  await invalidateOrgOwnerCaches(organizationId);
  return bindingId;
}

async function invalidateOrgOwnerCaches(organizationId: string): Promise<void> {
  const users = await db
    .queryAll('SELECT id FROM tbl_user WHERE organizationId = ?', [organizationId])
    .catch(() => []);
  for (const u of users as any[]) {
    await invalidateUser(u.id).catch(() => undefined);
  }
  const org = await db
    .select('tbl_organization', 'ownerUserId', 'id = ?', [organizationId])
    .catch(() => null);
  if (org?.ownerUserId) {
    await invalidateUser(org.ownerUserId as string).catch(() => undefined);
  }
}

/** Normalize plan strings safely for PLAN_LIMITS lookups. */
export function asPlan(plan: string | undefined | null): Plan {
  if (plan === 'PRO' || plan === 'ENTERPRISE') return plan;
  return 'FREE';
}

export { startByocHealthAlertSubscriber } from './healthAlert';
export {
  tripStorageCircuit,
  resetStorageCircuit,
  isStorageCircuitOpen,
} from './circuitBreaker';
