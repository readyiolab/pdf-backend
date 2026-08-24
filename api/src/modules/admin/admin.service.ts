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

  async listCustomers(filters: {
    repeat?: 'first' | 'repeat' | 'all';
    channel?: string;
    campaign?: string;
    from?: string;
    to?: string;
    q?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 50));
    const offset = (page - 1) * limit;
    const where: string[] = ["COALESCE(u.authProvider, 'password') <> 'guest'"];
    const params: unknown[] = [];

    if (filters.channel && filters.channel !== 'all') {
      where.push('COALESCE(a.acquisitionChannel, ?) = ?');
      params.push('unknown', filters.channel);
    }
    if (filters.campaign) {
      where.push('(a.firstUtmCampaign = ? OR a.lastUtmCampaign = ?)');
      params.push(filters.campaign, filters.campaign);
    }
    if (filters.from) {
      where.push('u.createdAt >= ?');
      params.push(new Date(filters.from));
    }
    if (filters.to) {
      where.push('u.createdAt <= ?');
      params.push(new Date(filters.to));
    }
    if (filters.q) {
      where.push('(u.email LIKE ? OR u.name LIKE ?)');
      const like = `%${filters.q.trim()}%`;
      params.push(like, like);
    }
    if (filters.repeat === 'repeat') {
      where.push(`(
        (SELECT COUNT(*) FROM tbl_customer_event e WHERE e.userId = u.id AND e.type = 'login') >= 2
        OR (SELECT COUNT(*) FROM tbl_customer_event e WHERE e.userId = u.id AND e.type = 'subscription_active') >= 1
        OR (SELECT COUNT(DISTINCT DATE(e.createdAt)) FROM tbl_customer_event e
              WHERE e.userId = u.id AND e.type IN ('job_completed','letter_sent','esign_completed')) >= 2
      )`);
    } else if (filters.repeat === 'first') {
      where.push(`(
        (SELECT COUNT(*) FROM tbl_customer_event e WHERE e.userId = u.id AND e.type = 'login') < 2
        AND (SELECT COUNT(*) FROM tbl_customer_event e WHERE e.userId = u.id AND e.type = 'subscription_active') = 0
        AND (SELECT COUNT(DISTINCT DATE(e.createdAt)) FROM tbl_customer_event e
              WHERE e.userId = u.id AND e.type IN ('job_completed','letter_sent','esign_completed')) < 2
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await db.queryAll<any>(
      `SELECT u.id, u.email, u.name, u.plan, u.createdAt,
              a.acquisitionChannel, a.visitorId,
              a.firstUtmSource, a.firstUtmMedium, a.firstUtmCampaign,
              a.lastUtmSource, a.lastUtmMedium, a.lastUtmCampaign,
              a.firstVisitAt, a.signupAt, a.lastSeenAt, a.lastLoginAt,
              p.phone, p.company, p.addressLine1, p.addressLine2, p.city, p.state, p.postalCode, p.country,
              (SELECT COUNT(*) FROM tbl_customer_event e WHERE e.userId = u.id) AS eventCount,
              (SELECT COUNT(*) FROM tbl_customer_event e WHERE e.userId = u.id AND e.type = 'login') AS loginCount,
              (SELECT COUNT(*) FROM tbl_customer_event e WHERE e.userId = u.id AND e.type = 'subscription_active') AS paidCount,
              (SELECT COUNT(DISTINCT DATE(e.createdAt)) FROM tbl_customer_event e
                WHERE e.userId = u.id AND e.type IN ('job_completed','letter_sent','esign_completed')) AS activityDays
         FROM tbl_user u
         LEFT JOIN tbl_user_attribution a ON a.userId = u.id
         LEFT JOIN tbl_user_profile p ON p.userId = u.id
         ${whereSql}
         ORDER BY COALESCE(a.lastSeenAt, u.createdAt) DESC
         LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const countRows = await db.queryAll<any>(
      `SELECT COUNT(*) AS cnt
         FROM tbl_user u
         LEFT JOIN tbl_user_attribution a ON a.userId = u.id
         ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.cnt || 0);

    let customers = rows.map((r) => {
      const loginCount = Number(r.loginCount || 0);
      const paidCount = Number(r.paidCount || 0);
      const activityDays = Number(r.activityDays || 0);
      const isRepeat = loginCount >= 2 || paidCount >= 1 || activityDays >= 2;
      return {
        id: r.id,
        email: r.email,
        name: r.name,
        plan: r.plan,
        createdAt: r.createdAt,
        channel: r.acquisitionChannel || 'unknown',
        firstTouch: {
          source: r.firstUtmSource,
          medium: r.firstUtmMedium,
          campaign: r.firstUtmCampaign,
        },
        lastTouch: {
          source: r.lastUtmSource,
          medium: r.lastUtmMedium,
          campaign: r.lastUtmCampaign,
        },
        firstSeenAt: r.firstVisitAt || r.createdAt,
        lastSeenAt: r.lastSeenAt || r.createdAt,
        signupAt: r.signupAt || r.createdAt,
        address:
          r.addressLine1 || r.city
            ? {
                line1: r.addressLine1,
                line2: r.addressLine2,
                city: r.city,
                state: r.state,
                postalCode: r.postalCode,
                country: r.country,
              }
            : null,
        phone: r.phone || null,
        company: r.company || null,
        eventCount: Number(r.eventCount || 0),
        isRepeat,
        customerType: isRepeat ? 'repeat' : 'first',
      };
    });

    return { customers, page, limit, total };
  },

  async getCustomer(userId: string) {
    const user = await db.select(
      'tbl_user',
      'id, email, name, plan, createdAt, organizationId',
      "id = ? AND COALESCE(authProvider, 'password') <> 'guest'",
      [userId]
    );
    if (!user) throw new AppError('Customer not found', 404);

    const attribution = await db.select('tbl_user_attribution', '*', 'userId = ?', [userId]);
    const profile = await db.select('tbl_user_profile', '*', 'userId = ?', [userId]);
    const events = await db.queryAll<any>(
      `SELECT id, type, contactId, visitorId, metaJson, createdAt
         FROM tbl_customer_event
        WHERE userId = ?
        ORDER BY createdAt DESC
        LIMIT 200`,
      [userId]
    );
    const contacts = await db.queryAll<any>(
      `SELECT id, email, name, isRepeat, source, firstSeenAt, lastSeenAt
         FROM tbl_contact
        WHERE userId = ?
        ORDER BY lastSeenAt DESC
        LIMIT 50`,
      [userId]
    );

    const loginCount = events.filter((e) => e.type === 'login').length;
    const paidCount = events.filter((e) => e.type === 'subscription_active').length;
    const activityDays = new Set(
      events
        .filter((e) =>
          ['job_completed', 'letter_sent', 'esign_completed'].includes(e.type)
        )
        .map((e) => String(e.createdAt).slice(0, 10))
    ).size;
    const isRepeat = loginCount >= 2 || paidCount >= 1 || activityDays >= 2;

    const timeline = events.map((e) => ({
      id: e.id,
      type: e.type,
      contactId: e.contactId,
      visitorId: e.visitorId,
      meta:
        typeof e.metaJson === 'string'
          ? (() => {
              try {
                return JSON.parse(e.metaJson);
              } catch {
                return null;
              }
            })()
          : e.metaJson,
      createdAt: e.createdAt,
    }));

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        createdAt: user.createdAt,
        organizationId: user.organizationId,
      },
      attribution: attribution || null,
      profile: profile || null,
      isRepeat,
      customerType: isRepeat ? 'repeat' : 'first',
      contacts,
      timeline,
    };
  },
};