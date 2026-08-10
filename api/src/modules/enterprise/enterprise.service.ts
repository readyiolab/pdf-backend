import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import { encryptJson, isSecretBoxConfigured, decryptJson } from '../../lib/secretBox';
import {
  activateNewBinding,
  getOrganizationIdForUser,
  runStorageTest,
} from '../../lib/storage';
import type { ProviderCredentials, StorageProviderKind } from '../../lib/storage/types';
import { getRequestContext } from '../../lib/requestContext';
import type { Request } from 'express';

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return base || 'org';
}

async function uniqueSlug(name: string): Promise<string> {
  let slug = slugify(name);
  let n = 0;
  while (true) {
    const candidate = n === 0 ? slug : `${slug}-${n}`;
    const existing = await db.select('tbl_organization', 'id', 'slug = ?', [candidate]);
    if (!existing) return candidate;
    n += 1;
  }
}

async function writeAudit(
  organizationId: string,
  actorId: string | null,
  action: string,
  detail: string | null,
  req?: Request
): Promise<void> {
  const ctx = req ? getRequestContext(req) : { ipAddress: null };
  await db.insert('tbl_org_infra_audit', {
    id: crypto.randomUUID(),
    organizationId,
    actorId,
    action,
    detail,
    ipAddress: ctx.ipAddress,
  });
}

function publicStorageRow(cfg: any) {
  if (!cfg) {
    return {
      provider: 'PLATFORM' as const,
      bucket: null,
      region: null,
      endpoint: null,
      status: 'UNCONFIGURED' as const,
      lastTestedAt: null,
      lastHealthyAt: null,
      lastError: null,
      consecutiveFailures: 0,
      corsVerifiedAt: null,
      activeBindingId: null,
      hasSecret: false,
    };
  }
  return {
    provider: cfg.provider,
    bucket: cfg.bucket,
    region: cfg.region,
    endpoint: cfg.endpoint,
    status: cfg.status,
    lastTestedAt: cfg.lastTestedAt,
    lastHealthyAt: cfg.lastHealthyAt ?? null,
    lastError: cfg.lastError,
    consecutiveFailures: Number(cfg.consecutiveFailures ?? 0),
    corsVerifiedAt: cfg.corsVerifiedAt ?? null,
    activeBindingId: cfg.activeBindingId ?? null,
    hasSecret: Boolean(cfg.encryptedCredentials || cfg.activeBindingId),
  };
}

async function resolveCredentials(
  organizationId: string,
  input: {
    credentials?: ProviderCredentials;
    useSavedSecrets?: boolean;
  }
): Promise<ProviderCredentials | undefined> {
  let credentials = input.credentials;
  const missing =
    !credentials ||
    (!(credentials as any).accessKeyId &&
      !(credentials as any).connectionString &&
      !(credentials as any).accountKey);

  if (missing && input.useSavedSecrets) {
    const cfg = await db.select(
      'tbl_org_storage_config',
      'encryptedCredentials, activeBindingId',
      'organizationId = ?',
      [organizationId]
    );
    let enc = cfg?.encryptedCredentials as string | undefined;
    if (!enc && cfg?.activeBindingId) {
      const binding = await db.select(
        'tbl_org_storage_binding',
        'encryptedCredentials',
        'id = ?',
        [cfg.activeBindingId]
      );
      enc = binding?.encryptedCredentials;
    }
    if (enc) credentials = decryptJson(enc);
  }
  return credentials;
}

export const enterpriseService = {
  async getOrCreateOrganization(userId: string, name?: string) {
    const user = await db.select('tbl_user', 'id, email, name, plan, organizationId', 'id = ?', [
      userId,
    ]);
    if (!user) throw new AppError('User not found', 404);
    if (user.plan !== 'ENTERPRISE') {
      throw new AppError('Cloud storage BYOC requires an Enterprise plan.', 403);
    }

    let org = await db.select('tbl_organization', '*', 'ownerUserId = ?', [userId]);
    if (!org) {
      const id = crypto.randomUUID();
      const orgName = (name || user.name || user.email || 'Enterprise').toString().slice(0, 200);
      const slug = await uniqueSlug(orgName);
      await db.insert('tbl_organization', {
        id,
        name: orgName,
        slug,
        plan: 'ENTERPRISE',
        status: 'ACTIVE',
        ownerUserId: userId,
      });
      await db.update('tbl_user', { organizationId: id }, 'id = ?', [userId]);
      await db.insert('tbl_org_storage_config', {
        id: crypto.randomUUID(),
        organizationId: id,
        provider: 'PLATFORM',
        status: 'UNCONFIGURED',
      });
      // Membership row so Letter Studio / multi-user RBAC sees this owner
      const existingMembership = await db.select(
        'tbl_org_user',
        'id',
        'organizationId = ? AND userId = ?',
        [id, userId]
      );
      if (!existingMembership) {
        await db.insert('tbl_org_user', {
          id: crypto.randomUUID(),
          organizationId: id,
          userId,
          role: 'OWNER',
          invitedBy: userId,
          status: 'ACTIVE',
        });
      }
      org = await db.select('tbl_organization', '*', 'id = ?', [id]);
    }

    if (!org) throw new AppError('Organization could not be loaded', 500);

    const storage = await db.select(
      'tbl_org_storage_config',
      '*',
      'organizationId = ?',
      [org.id]
    );

    return {
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        status: org.status,
        licenseKey: org.licenseKey,
        createdAt: org.createdAt,
      },
      storage: publicStorageRow(storage),
      role: 'OWNER' as const,
    };
  },

  async getStorage(userId: string) {
    const data = await this.getOrCreateOrganization(userId);
    return data.storage;
  },

  async testStorage(
    userId: string,
    input: {
      provider: StorageProviderKind;
      bucket?: string;
      region?: string;
      endpoint?: string;
      credentials?: ProviderCredentials;
      useSavedSecrets?: boolean;
    }
  ) {
    if (!(await getOrganizationIdForUser(userId))) {
      await this.getOrCreateOrganization(userId);
    }
    const organizationId = (await getOrganizationIdForUser(userId))!;

    const credentials = await resolveCredentials(organizationId, input);

    return runStorageTest({
      provider: input.provider,
      bucket: input.bucket,
      region: input.region,
      endpoint: input.endpoint,
      credentials: credentials ?? null,
    });
  },

  async saveStorage(
    userId: string,
    input: {
      provider: StorageProviderKind;
      bucket?: string;
      region?: string;
      endpoint?: string;
      credentials?: ProviderCredentials;
    },
    req?: Request
  ) {
    if (input.provider !== 'PLATFORM' && !isSecretBoxConfigured()) {
      throw new AppError(
        'Server is not configured to store infrastructure secrets (INFRA_CREDENTIALS_KEY).',
        503
      );
    }

    const { organization } = await this.getOrCreateOrganization(userId);

    let corsOk = true;
    if (input.provider !== 'PLATFORM') {
      const test = await this.testStorage(userId, {
        ...input,
        useSavedSecrets: !input.credentials,
      });
      if (!test.reachable || !test.canWrite) {
        throw new AppError(test.message || 'Storage connection test failed', 400);
      }
      if (!test.corsOk) {
        throw new AppError(
          test.message ||
            'Bucket CORS is not configured for browser uploads. Apply the CORS config shown in Settings, then Test again.',
          400
        );
      }
      corsOk = test.corsOk;
    }

    let encryptedCredentials: string | null = null;
    if (input.provider !== 'PLATFORM') {
      if (input.credentials) {
        encryptedCredentials = encryptJson(input.credentials);
      } else {
        const credentials = await resolveCredentials(organization.id, {
          useSavedSecrets: true,
        });
        if (!credentials) {
          throw new AppError('Credentials are required when connecting a cloud provider.', 400);
        }
        encryptedCredentials = encryptJson(credentials);
      }
    }

    const existing = await db.select(
      'tbl_org_storage_config',
      'id',
      'organizationId = ?',
      [organization.id]
    );
    if (!existing) {
      await db.insert('tbl_org_storage_config', {
        id: crypto.randomUUID(),
        organizationId: organization.id,
        provider: 'PLATFORM',
        status: 'UNCONFIGURED',
      });
    }

    await activateNewBinding(organization.id, {
      provider: input.provider,
      bucket: input.bucket,
      region: input.region,
      endpoint: input.endpoint,
      encryptedCredentials,
      corsOk,
    });

    await writeAudit(
      organization.id,
      userId,
      input.provider === 'PLATFORM' ? 'STORAGE_RESET_PLATFORM' : 'STORAGE_SAVED',
      `Provider set to ${input.provider}`,
      req
    );

    return this.getStorage(userId);
  },

  async resetStorage(userId: string, req?: Request) {
    return this.saveStorage(userId, { provider: 'PLATFORM' }, req);
  },

  async listAudit(userId: string, limit = 50) {
    const orgId = await getOrganizationIdForUser(userId);
    if (!orgId) return { entries: [] };
    const entries = await db.queryAll(
      `SELECT id, action, detail, ipAddress, createdAt, actorId
         FROM tbl_org_infra_audit
        WHERE organizationId = ?
        ORDER BY createdAt DESC
        LIMIT ?`,
      [orgId, Math.min(100, Math.max(1, limit))]
    );
    return { entries };
  },
};
