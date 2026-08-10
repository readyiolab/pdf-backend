import { Request, Response, NextFunction } from 'express';
import { db } from '../lib/mysql';
import { AppError } from './errorHandler.middleware';

export type OrgRole = 'OWNER' | 'ADMIN' | 'HR_MANAGER' | 'VIEWER';

export const ORG_ROLE_RANK: Record<OrgRole, number> = {
  VIEWER: 1,
  HR_MANAGER: 2,
  ADMIN: 3,
  OWNER: 4,
};

export interface OrgContext {
  organizationId: string;
  role: OrgRole;
  membershipId: string;
  orgName: string;
}

declare global {
  namespace Express {
    interface Request {
      orgContext?: OrgContext;
    }
  }
}

/**
 * Resolves the caller's active org membership.
 * Organization id comes from (in order):
 *   1. X-Organization-Id header
 *   2. :organizationId / :orgId route param
 *   3. body.organizationId
 *   4. query.organizationId
 * If none is provided, the user's first ACTIVE membership is used.
 */
export async function resolveOrgContext(req: Request): Promise<OrgContext> {
  if (!req.user?.id) {
    throw new AppError('Authentication required', 401);
  }

  const headerOrg = (req.headers['x-organization-id'] as string | undefined)?.trim();
  const paramOrg =
    (req.params.organizationId as string | undefined) ||
    (req.params.orgId as string | undefined);
  const bodyOrg = typeof req.body?.organizationId === 'string' ? req.body.organizationId : undefined;
  const queryOrg =
    typeof req.query?.organizationId === 'string' ? req.query.organizationId : undefined;

  const requestedOrgId = headerOrg || paramOrg || bodyOrg || queryOrg || null;

  let membership: any;
  if (requestedOrgId) {
    membership = await db.select(
      'tbl_org_user',
      '*',
      'organizationId = ? AND userId = ? AND status = ?',
      [requestedOrgId, req.user.id, 'ACTIVE']
    );
    if (!membership) {
      throw new AppError('You are not a member of this organization', 403);
    }
  } else {
    membership = await db.select(
      'tbl_org_user',
      '*',
      'userId = ? AND status = ?',
      [req.user.id, 'ACTIVE']
    );
    if (!membership) {
      throw new AppError('No organization membership found. Create or join an organization first.', 404);
    }
  }

  const org = await db.select('tbl_organization', 'id, name, status', 'id = ?', [
    membership.organizationId,
  ]);
  if (!org || org.status !== 'ACTIVE') {
    throw new AppError('Organization is not active', 403);
  }

  return {
    organizationId: membership.organizationId,
    role: membership.role as OrgRole,
    membershipId: membership.id,
    orgName: org.name,
  };
}

/**
 * Middleware factory: requires the caller to hold one of the allowed roles
 * (or a higher-ranked role) in the resolved organization.
 *
 * Usage: `requireOrgRole(['OWNER', 'ADMIN'])`
 */
export function requireOrgRole(allowed: OrgRole[]) {
  const minRank = Math.min(...allowed.map((r) => ORG_ROLE_RANK[r]));

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = await resolveOrgContext(req);
      if (ORG_ROLE_RANK[ctx.role] < minRank) {
        throw new AppError(
          `This action requires one of: ${allowed.join(', ')}. Your role is ${ctx.role}.`,
          403
        );
      }
      req.orgContext = ctx;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Attaches org context without enforcing a minimum role (any active member). */
export async function attachOrgContext(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    req.orgContext = await resolveOrgContext(req);
    next();
  } catch (err) {
    next(err);
  }
}
