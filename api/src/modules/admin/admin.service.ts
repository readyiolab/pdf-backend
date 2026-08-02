import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import { asPlan } from '../../lib/storage';
import { invalidateUser } from '../../lib/userCache';
import { isPlatformAdminUser } from '../../middleware/platformAdmin.middleware';
import { ADMIN_JWT_AUDIENCE, signToken } from '../../lib/jwt';
import { env } from '../../config/env';

function publicOrgRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    status: row.status,
    licenseKey: row.licenseKey,
    ownerUserId: row.ownerUserId,
    ownerEmail: row.ownerEmail ?? null,
    ownerName: row.ownerName ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    storage: {
      provider: row.storageProvider ?? 'PLATFORM',
      bucket: row.storageBucket ?? null,
      region: row.storageRegion ?? null,
      endpoint: row.storageEndpoint ?? null,
      status: row.storageStatus ?? 'UNCONFIGURED',
      lastTestedAt: row.storageLastTestedAt ?? null,
      lastHealthyAt: row.storageLastHealthyAt ?? null,
      lastError: row.storageLastError ?? null,
      corsVerifiedAt: row.storageCorsVerifiedAt ?? null,
      consecutiveFailures: Number(row.storageConsecutiveFailures ?? 0),
      hasSecret: Boolean(row.storageHasSecret),
    },
  };
}

function assertNoSecrets(payload: unknown): void {
  const json = JSON.stringify(payload);
  if (/encryptedCredentials|secretAccessKey|accountKey|connectionString/i.test(json)) {
    throw new AppError('Internal error: secret field leaked in admin response', 500);
  }
}

async function writeAdminAudit(
  organizationId: string,
  actorId: string | null,
  action: string,
  detail: string | null,
  ipAddress: string | null
): Promise<void> {
  await db.insert('tbl_org_infra_audit', {
    id: crypto.randomUUID(),
    organizationId,
    actorId,
    action,
    detail,
    ipAddress,
  });
}

export const adminService = {
  async login(email: string, password: string) {
    const normalized = email.trim().toLowerCase();
    const user = await db.select('tbl_user', '*', 'email = ?', [normalized]);
    if (!user || user.isGuest) throw new AppError('Invalid email or password', 401);
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new AppError('Invalid email or password', 401);
    if (!(await isPlatformAdminUser(user.id))) {
      throw new AppError('Platform admin access required', 403);
    }
    const token = signToken(
      {
        userId: user.id,
        email: user.email,
        plan: user.plan,
      },
      { audience: ADMIN_JWT_AUDIENCE, expiresIn: env.ADMIN_JWT_EXPIRES_IN }
    );
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
      },
    };
  },

  async dashboard() {
    const [orgs, connected, errors, suspended] = await Promise.all([
      db.queryAll('SELECT COUNT(*) AS c FROM tbl_organization'),
      db.queryAll(
        `SELECT COUNT(*) AS c FROM tbl_org_storage_config WHERE status = 'CONNECTED' AND provider <> 'PLATFORM'`
      ),
      db.queryAll(`SELECT COUNT(*) AS c FROM tbl_org_storage_config WHERE status = 'ERROR'`),
      db.queryAll(`SELECT COUNT(*) AS c FROM tbl_organization WHERE status = 'SUSPENDED'`),
    ]);
    return {
      organizations: Number((orgs[0] as any)?.c ?? 0),
      byocConnected: Number((connected[0] as any)?.c ?? 0),
      byocErrors: Number((errors[0] as any)?.c ?? 0),
      suspended: Number((suspended[0] as any)?.c ?? 0),
    };
  },

  async listOrganizations() {
    const rows = await db.queryAll(
      `SELECT o.*,
              u.email AS ownerEmail,
              u.name AS ownerName,
              s.provider AS storageProvider,
              s.bucket AS storageBucket,
              s.region AS storageRegion,
              s.endpoint AS storageEndpoint,
              s.status AS storageStatus,
              s.lastTestedAt AS storageLastTestedAt,
              s.lastHealthyAt AS storageLastHealthyAt,
              s.lastError AS storageLastError,
              s.corsVerifiedAt AS storageCorsVerifiedAt,
              s.consecutiveFailures AS storageConsecutiveFailures,
              (
                (b.encryptedCredentials IS NOT NULL AND b.encryptedCredentials <> '')
                OR (s.encryptedCredentials IS NOT NULL AND s.encryptedCredentials <> '')
              ) AS storageHasSecret
         FROM tbl_organization o
         LEFT JOIN tbl_user u ON u.id = o.ownerUserId
         LEFT JOIN tbl_org_storage_config s ON s.organizationId = o.id
         LEFT JOIN tbl_org_storage_binding b ON b.id = s.activeBindingId
         ORDER BY o.createdAt DESC`
    );
    const data = { organizations: rows.map(publicOrgRow) };
    assertNoSecrets(data);
    return data;
  },

  async getOrganization(id: string, actorId?: string | null, ipAddress?: string | null) {
    const rows = await db.queryAll(
      `SELECT o.*,
              u.email AS ownerEmail,
              u.name AS ownerName,
              s.provider AS storageProvider,
              s.bucket AS storageBucket,
              s.region AS storageRegion,
              s.endpoint AS storageEndpoint,
              s.status AS storageStatus,
              s.lastTestedAt AS storageLastTestedAt,
              s.lastHealthyAt AS storageLastHealthyAt,
              s.lastError AS storageLastError,
              s.corsVerifiedAt AS storageCorsVerifiedAt,
              s.consecutiveFailures AS storageConsecutiveFailures,
              (
                (b.encryptedCredentials IS NOT NULL AND b.encryptedCredentials <> '')
                OR (s.encryptedCredentials IS NOT NULL AND s.encryptedCredentials <> '')
              ) AS storageHasSecret
         FROM tbl_organization o
         LEFT JOIN tbl_user u ON u.id = o.ownerUserId
         LEFT JOIN tbl_org_storage_config s ON s.organizationId = o.id
         LEFT JOIN tbl_org_storage_binding b ON b.id = s.activeBindingId
         WHERE o.id = ?
         LIMIT 1`,
      [id]
    );
    if (!rows[0]) throw new AppError('Organization not found', 404);
    const data = publicOrgRow(rows[0]);
    assertNoSecrets(data);
    if (actorId) {
      await writeAdminAudit(id, actorId, 'ADMIN_READ_ORG', null, ipAddress ?? null);
    }
    return data;
  },

  async getAudit(
    organizationId: string,
    limit = 50,
    actorId?: string | null,
    ipAddress?: string | null
  ) {
    await this.getOrganization(organizationId);
    const entries = await db.queryAll(
      `SELECT id, action, detail, ipAddress, createdAt, actorId
         FROM tbl_org_infra_audit
        WHERE organizationId = ?
        ORDER BY createdAt DESC
        LIMIT ?`,
      [organizationId, Math.min(100, Math.max(1, limit))]
    );
    if (actorId) {
      await writeAdminAudit(
        organizationId,
        actorId,
        'ADMIN_READ_AUDIT',
        `limit=${limit}`,
        ipAddress ?? null
      );
    }
    return { entries };
  },

  async patchOrganization(
    id: string,
    input: { status?: string; plan?: string; licenseKey?: string | null; name?: string },
    actorId?: string | null,
    ipAddress?: string | null
  ) {
    const org = await db.select('tbl_organization', '*', 'id = ?', [id]);
    if (!org) throw new AppError('Organization not found', 404);

    const patch: Record<string, unknown> = {};
    if (input.status) {
      if (!['ACTIVE', 'SUSPENDED'].includes(input.status)) {
        throw new AppError('status must be ACTIVE or SUSPENDED', 400);
      }
      patch.status = input.status;
    }
    if (input.plan) {
      patch.plan = asPlan(input.plan) === 'ENTERPRISE' ? 'ENTERPRISE' : asPlan(input.plan);
    }
    if (input.licenseKey !== undefined) patch.licenseKey = input.licenseKey;
    if (input.name) patch.name = input.name.slice(0, 200);

    if (Object.keys(patch).length === 0) {
      throw new AppError('No fields to update', 400);
    }

    await db.update('tbl_organization', patch, 'id = ?', [id]);

    if (patch.plan) {
      await db.update('tbl_user', { plan: patch.plan }, 'id = ?', [org.ownerUserId]);
      await invalidateUser(org.ownerUserId).catch(() => undefined);
    }

    await writeAdminAudit(id, actorId ?? null, 'ADMIN_PATCH', JSON.stringify(patch), ipAddress ?? null);

    return this.getOrganization(id);
  },

  async provisionEnterprise(
    input: { ownerEmail: string; name?: string; licenseKey?: string },
    actorId?: string | null,
    ipAddress?: string | null
  ) {
    const email = input.ownerEmail.trim().toLowerCase();
    const user = await db.select('tbl_user', '*', 'email = ?', [email]);
    if (!user) throw new AppError('No user found with that email. They must register first.', 404);

    const existing = await db.select('tbl_organization', 'id', 'ownerUserId = ?', [user.id]);
    if (existing) throw new AppError('This user already owns an organization.', 409);

    const id = crypto.randomUUID();
    const orgName = (input.name || user.name || email).toString().slice(0, 200);
    const baseSlug =
      orgName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'org';
    let slug = baseSlug;
    let n = 0;
    while (await db.select('tbl_organization', 'id', 'slug = ?', [slug])) {
      n += 1;
      slug = `${baseSlug}-${n}`;
    }

    await db.insert('tbl_organization', {
      id,
      name: orgName,
      slug,
      plan: 'ENTERPRISE',
      status: 'ACTIVE',
      ownerUserId: user.id,
      licenseKey: input.licenseKey ?? null,
    });
    await db.insert('tbl_org_storage_config', {
      id: crypto.randomUUID(),
      organizationId: id,
      provider: 'PLATFORM',
      status: 'UNCONFIGURED',
    });
    await db.update(
      'tbl_user',
      { plan: 'ENTERPRISE', organizationId: id },
      'id = ?',
      [user.id]
    );
    await invalidateUser(user.id).catch(() => undefined);

    await writeAdminAudit(
      id,
      actorId ?? null,
      'ADMIN_PROVISION',
      `Provisioned ENTERPRISE for ${email}`,
      ipAddress ?? null
    );

    return this.getOrganization(id);
  },
};