import { Request, Response, NextFunction } from 'express';
import { db } from '../lib/mysql';
import { verifyToken, isTokenRevoked, CUSTOMER_JWT_AUDIENCE, ADMIN_JWT_AUDIENCE } from '../lib/jwt';
import { getCachedUser, setCachedUser, CachedUser } from '../lib/userCache';
import { AppError } from './errorHandler.middleware';
import { logger } from '../lib/logger';

declare global {
  namespace Express {
    interface Request {
      user: {
        id: string;
        plan: 'FREE' | 'PRO' | 'ENTERPRISE';
        isGuest: boolean;
        emailVerified: boolean;
        /** From auth cache — null = personal / platform storage */
        organizationId: string | null;
        /** Active BYOC binding id when cached */
        storageBindingId: string | null;
      };
      // The raw token claims, used by logout to revoke this exact token.
      tokenJti?: string;
      tokenExp?: number;
    }
  }
}

/**
 * Blocks guest sessions from a route. Must run after authMiddleware.
 *
 * Guest rows are provisioned on demand and are throwaway by design (see
 * authService.guest). That is fine for a one-shot tool run, but a signing
 * document is a durable, identity-bearing legal artifact: it names its owner in
 * the audit trail, outlives the session by months, and would be orphaned the
 * moment guest cleanup removes the user row (ownerId cascades). Requiring a
 * real account keeps agreements attributable to someone who can be contacted.
 */
export const requireFullAccount = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  if (req.user?.isGuest) {
    next(new AppError('Please create a free account to use this feature. Guest sessions are limited to basic PDF tools.', 403));
    return;
  }
  next();
};

/**
 * Blocks unverified email/password accounts from protected features.
 * Guests are already verified=true at provision time; Google users are verified.
 * Must run after authMiddleware.
 */
export const requireVerifiedEmail = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  if (req.user && !req.user.isGuest && !req.user.emailVerified) {
    next(
      new AppError(
        'Please verify your email before using this feature. Check your inbox for a verification link.',
        403
      )
    );
    return;
  }
  next();
};

export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  return runAuth(req, res, next, CUSTOMER_JWT_AUDIENCE);
};

/** Platform admin JWT (aud=platform-admin). Do not use on customer routes. */
export const adminAuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  return runAuth(req, res, next, ADMIN_JWT_AUDIENCE);
};

async function runAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
  audience: string
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Authorization token is missing or malformed', 401);
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = verifyToken(token, { audience });
    } catch {
      throw new AppError('Invalid or expired authentication token', 401);
    }

    let revoked = false;
    try {
      revoked = decoded.jti ? await isTokenRevoked(decoded.jti) : false;
    } catch (err) {
      // Fail closed: if Redis is down we cannot confirm the token was not revoked.
      logger.error({ err }, 'Redis unavailable for token revocation check — rejecting request');
      throw new AppError('Authentication service temporarily unavailable. Please try again.', 503);
    }
    if (revoked) {
      throw new AppError('This session has been logged out', 401);
    }

    let cached: CachedUser | null = null;
    try {
      cached = await getCachedUser(decoded.userId);
    } catch (err) {
      logger.warn({ err }, 'Redis unavailable, skipping user cache read');
    }
    // Old cache payloads without org fields must be refreshed
    if (cached && (cached.organizationId === undefined || cached.storageBindingId === undefined)) {
      cached = null;
    }
    if (!cached) {
      const user = await db.select(
        'tbl_user',
        'id, plan, emailVerified, organizationId',
        'id = ?',
        [decoded.userId]
      );
      if (!user) {
        throw new AppError('The user belonging to this token no longer exists', 401);
      }
      const rawVerified = user.emailVerified as unknown;
      const emailVerified =
        rawVerified === true ||
        rawVerified === 1 ||
        rawVerified === '1' ||
        (typeof Buffer !== 'undefined' &&
          Buffer.isBuffer(rawVerified) &&
          rawVerified.length > 0 &&
          rawVerified[0] !== 0);

      let organizationId = (user.organizationId as string) || null;
      if (!organizationId) {
        const org = await db.select('tbl_organization', 'id', 'ownerUserId = ?', [
          decoded.userId,
        ]);
        if (org?.id) {
          organizationId = org.id as string;
          await db
            .update('tbl_user', { organizationId }, 'id = ?', [decoded.userId])
            .catch(() => undefined);
        }
      }

      let storageBindingId: string | null = null;
      if (organizationId) {
        const cfg = await db.select(
          'tbl_org_storage_config',
          'activeBindingId, provider',
          'organizationId = ?',
          [organizationId]
        );
        if (cfg && cfg.provider !== 'PLATFORM' && cfg.activeBindingId) {
          storageBindingId = cfg.activeBindingId as string;
        }
      }

      cached = {
        id: user.id,
        plan: user.plan as 'FREE' | 'PRO' | 'ENTERPRISE',
        emailVerified,
        organizationId,
        storageBindingId,
      };
      try {
        await setCachedUser(cached);
      } catch (err) {
        logger.warn({ err }, 'Redis unavailable, skipping user cache write');
      }
    }

    req.user = {
      id: cached.id,
      plan: cached.plan,
      isGuest: Boolean(decoded.isGuest),
      emailVerified: cached.emailVerified,
      organizationId: cached.organizationId ?? null,
      storageBindingId: cached.storageBindingId ?? null,
    };
    req.tokenJti = decoded.jti;
    req.tokenExp = decoded.exp;

    next();
  } catch (err) {
    next(err);
  }
}
