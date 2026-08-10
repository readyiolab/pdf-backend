import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import { isMailerConfigured, sendMail } from '../../lib/mailer';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { newId, type OrgRoleName } from './orgs.types';

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

async function writeLetterAudit(
  organizationId: string,
  userId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
  aiAssisted = false
): Promise<void> {
  await db.insert('tbl_letter_audit', {
    id: newId(),
    organizationId,
    userId,
    action,
    entityType,
    entityId,
    metadataJson: JSON.stringify(metadata),
    aiAssisted: aiAssisted ? 1 : 0,
  });
}

export const orgsService = {
  async listMyOrgs(userId: string) {
    const rows = await db.queryAll<any>(
      `SELECT o.id, o.name, o.slug, o.plan, o.status, o.letterRetentionDays, o.createdAt,
              m.role, m.id AS membershipId
         FROM tbl_org_user m
         JOIN tbl_organization o ON o.id = m.organizationId
        WHERE m.userId = ? AND m.status = 'ACTIVE'
        ORDER BY o.name ASC`,
      [userId]
    );
    return rows;
  },

  /**
   * Creates a new org owned by the user, or returns their existing owned org
   * when name is omitted (auto-create personal org for Letter Studio).
   */
  async createOrg(userId: string, name?: string) {
    const user = await db.select('tbl_user', 'id, email, name, plan, organizationId', 'id = ?', [userId]);
    if (!user) throw new AppError('User not found', 404);

    // Prefer existing membership if caller just wants "ensure I have an org"
    if (!name) {
      const membership = await db.select(
        'tbl_org_user',
        '*',
        'userId = ? AND status = ?',
        [userId, 'ACTIVE']
      );
      if (membership) {
        const org = await db.select('tbl_organization', '*', 'id = ?', [
          membership.organizationId,
        ]);
        if (org) {
          return {
            organization: publicOrg(org),
            role: membership.role as OrgRoleName,
            membershipId: membership.id,
          };
        }
      }
    }

    // One owned org per user (uq_org_owner)
    const owned = await db.select('tbl_organization', '*', 'ownerUserId = ?', [userId]);
    if (owned) {
      // Ensure OWNER membership exists
      let membership = await db.select(
        'tbl_org_user',
        '*',
        'organizationId = ? AND userId = ?',
        [owned.id, userId]
      );
      if (!membership) {
        const membershipId = newId();
        await db.insert('tbl_org_user', {
          id: membershipId,
          organizationId: owned.id,
          userId,
          role: 'OWNER',
          invitedBy: userId,
          status: 'ACTIVE',
        });
        membership = await db.select('tbl_org_user', '*', 'id = ?', [membershipId]);
      }
      if (name && name.trim() && name.trim() !== owned.name) {
        await db.update('tbl_organization', { name: name.trim().slice(0, 200) }, 'id = ?', [
          owned.id,
        ]);
        owned.name = name.trim().slice(0, 200);
      }
      return {
        organization: publicOrg(owned),
        role: 'OWNER' as const,
        membershipId: membership!.id,
      };
    }

    const orgName = (name || user.name || user.email || 'My Organization')
      .toString()
      .trim()
      .slice(0, 200);
    const id = newId();
    const slug = await uniqueSlug(orgName);
    const plan = user.plan === 'ENTERPRISE' ? 'ENTERPRISE' : user.plan || 'FREE';

    await db.insert('tbl_organization', {
      id,
      name: orgName,
      slug,
      plan,
      status: 'ACTIVE',
      ownerUserId: userId,
      letterRetentionDays: 30,
    });

    // Storage config row so BYOC paths keep working if they upgrade later
    const existingStorage = await db.select(
      'tbl_org_storage_config',
      'id',
      'organizationId = ?',
      [id]
    );
    if (!existingStorage) {
      await db.insert('tbl_org_storage_config', {
        id: newId(),
        organizationId: id,
        provider: 'PLATFORM',
        status: 'UNCONFIGURED',
      });
    }

    const membershipId = newId();
    await db.insert('tbl_org_user', {
      id: membershipId,
      organizationId: id,
      userId,
      role: 'OWNER',
      invitedBy: userId,
      status: 'ACTIVE',
    });

    await db.update('tbl_user', { organizationId: id }, 'id = ?', [userId]);

    await writeLetterAudit(id, userId, 'ORG_CREATED', 'organization', id, { name: orgName });

    const org = await db.select('tbl_organization', '*', 'id = ?', [id]);
    return {
      organization: publicOrg(org),
      role: 'OWNER' as const,
      membershipId,
    };
  },

  async listMembers(organizationId: string) {
    const rows = await db.queryAll<any>(
      `SELECT m.id, m.role, m.status, m.createdAt, m.invitedBy,
              u.id AS userId, u.email, u.name
         FROM tbl_org_user m
         JOIN tbl_user u ON u.id = m.userId
        WHERE m.organizationId = ?
        ORDER BY
          FIELD(m.role, 'OWNER', 'ADMIN', 'HR_MANAGER', 'VIEWER'),
          u.email ASC`,
      [organizationId]
    );
    return rows.map((r) => ({
      membershipId: r.id,
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: r.role,
      status: r.status,
      invitedBy: r.invitedBy,
      createdAt: r.createdAt,
    }));
  },

  async inviteMember(
    organizationId: string,
    invitedBy: string,
    email: string,
    role: Exclude<OrgRoleName, 'OWNER'>
  ) {
    const normalized = email.trim().toLowerCase();
    const org = await db.select('tbl_organization', '*', 'id = ?', [organizationId]);
    if (!org) throw new AppError('Organization not found', 404);

    const existingUser = await db.select('tbl_user', 'id, email', 'email = ?', [normalized]);
    if (existingUser) {
      const already = await db.select(
        'tbl_org_user',
        'id',
        'organizationId = ? AND userId = ? AND status = ?',
        [organizationId, existingUser.id, 'ACTIVE']
      );
      if (already) {
        throw new AppError('This user is already a member of the organization', 409);
      }
    }

    // Invalidate prior pending invites for same email+org
    await db.update(
      'tbl_org_invite',
      { status: 'REVOKED' },
      `organizationId = ? AND email = ? AND status = 'PENDING'`,
      [organizationId, normalized]
    );

    const token = crypto.randomBytes(24).toString('hex');
    const inviteId = newId();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.insert('tbl_org_invite', {
      id: inviteId,
      organizationId,
      email: normalized,
      role,
      token,
      invitedBy,
      status: 'PENDING',
      expiresAt,
    });

    const acceptUrl = `${env.APP_URL || 'http://localhost:5173'}/orgs/accept-invite?token=${token}`;

    if (isMailerConfigured()) {
      try {
        await sendMail({
          to: normalized,
          subject: `You're invited to join ${org.name} on Letter Studio`,
          text: `You've been invited to join ${org.name} as ${role}. Accept: ${acceptUrl}`,
          html: `<p>You've been invited to join <strong>${escapeHtml(org.name)}</strong> as <strong>${role}</strong>.</p>
                 <p><a href="${acceptUrl}">Accept invitation</a></p>
                 <p>This link expires in 7 days.</p>`,
        });
      } catch (err) {
        logger.error({ err, email: normalized }, 'Failed to send org invite email');
      }
    } else {
      logger.warn({ acceptUrl, email: normalized }, 'SMTP not configured; invite token logged for local testing');
    }

    await writeLetterAudit(organizationId, invitedBy, 'MEMBER_INVITED', 'org_invite', inviteId, {
      email: normalized,
      role,
    });

    return {
      inviteId,
      email: normalized,
      role,
      expiresAt,
      // Returned only so local/dev can accept without SMTP
      acceptToken: env.NODE_ENV === 'production' ? undefined : token,
    };
  },

  async acceptInvite(userId: string, token: string) {
    const invite = await db.select<any>('tbl_org_invite', '*', 'token = ?', [token]);
    if (!invite || invite.status !== 'PENDING') {
      throw new AppError('Invitation is invalid or already used', 404);
    }
    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      await db.update('tbl_org_invite', { status: 'EXPIRED' }, 'id = ?', [invite.id]);
      throw new AppError('Invitation has expired', 410);
    }

    const user = await db.select('tbl_user', 'id, email', 'id = ?', [userId]);
    if (!user) throw new AppError('User not found', 404);
    if (user.email.toLowerCase() !== String(invite.email).toLowerCase()) {
      throw new AppError(
        'This invitation was sent to a different email address. Sign in with that account to accept.',
        403
      );
    }

    const existing = await db.select(
      'tbl_org_user',
      '*',
      'organizationId = ? AND userId = ?',
      [invite.organizationId, userId]
    );

    let membershipId: string;
    if (existing) {
      await db.update(
        'tbl_org_user',
        { role: invite.role, status: 'ACTIVE', invitedBy: invite.invitedBy },
        'id = ?',
        [existing.id]
      );
      membershipId = existing.id;
    } else {
      membershipId = newId();
      await db.insert('tbl_org_user', {
        id: membershipId,
        organizationId: invite.organizationId,
        userId,
        role: invite.role,
        invitedBy: invite.invitedBy,
        status: 'ACTIVE',
      });
    }

    await db.update('tbl_org_invite', { status: 'ACCEPTED' }, 'id = ?', [invite.id]);

    const userRow = await db.select('tbl_user', 'organizationId', 'id = ?', [userId]);
    if (!userRow?.organizationId) {
      await db.update('tbl_user', { organizationId: invite.organizationId }, 'id = ?', [userId]);
    }

    await writeLetterAudit(
      invite.organizationId,
      userId,
      'MEMBER_ACCEPTED',
      'org_user',
      membershipId,
      { role: invite.role }
    );

    const org = await db.select('tbl_organization', '*', 'id = ?', [invite.organizationId]);
    return {
      organization: publicOrg(org),
      role: invite.role as OrgRoleName,
      membershipId,
    };
  },

  async changeRole(
    organizationId: string,
    actorUserId: string,
    membershipId: string,
    newRole: Exclude<OrgRoleName, 'OWNER'>
  ) {
    const membership = await db.select<any>(
      'tbl_org_user',
      '*',
      'id = ? AND organizationId = ?',
      [membershipId, organizationId]
    );
    if (!membership) throw new AppError('Membership not found', 404);
    if (membership.role === 'OWNER') {
      throw new AppError('Cannot change the role of the organization owner', 400);
    }
    if (membership.userId === actorUserId) {
      throw new AppError('You cannot change your own role', 400);
    }

    await db.update('tbl_org_user', { role: newRole }, 'id = ?', [membershipId]);
    await writeLetterAudit(organizationId, actorUserId, 'MEMBER_ROLE_CHANGED', 'org_user', membershipId, {
      from: membership.role,
      to: newRole,
    });

    return { membershipId, role: newRole };
  },

  async setRetentionDays(organizationId: string, days: number, actorUserId: string) {
    if (![30, 60, 90].includes(days)) {
      throw new AppError('Retention must be 30, 60, or 90 days', 400);
    }
    await db.update('tbl_organization', { letterRetentionDays: days }, 'id = ?', [
      organizationId,
    ]);
    await writeLetterAudit(organizationId, actorUserId, 'RETENTION_UPDATED', 'organization', organizationId, {
      days,
    });
    return { letterRetentionDays: days };
  },
};

function publicOrg(org: any) {
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan,
    status: org.status,
    letterRetentionDays: org.letterRetentionDays ?? 30,
    createdAt: org.createdAt,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { writeLetterAudit };
