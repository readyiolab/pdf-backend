import { Request, Response, NextFunction } from 'express';
import { db } from '../lib/mysql';
import { verifyToken, isTokenRevoked } from '../lib/jwt';
import { getCachedUser, setCachedUser, CachedUser } from '../lib/userCache';
import { AppError } from './errorHandler.middleware';
import { logger } from '../lib/logger';

declare global {
  namespace Express {
    interface Request {
      user: {
        id: string;
        plan: 'FREE' | 'PRO';
        isGuest: boolean;
        emailVerified: boolean;
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
    next(new AppError('Please create an account to use document signing.', 403));
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
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Authorization token is missing or malformed', 401);
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch {
      throw new AppError('Invalid or expired authentication token', 401);
    }

    let revoked = false;
    try {
      revoked = decoded.jti ? await isTokenRevoked(decoded.jti) : false;
    } catch (err) {
      logger.warn({ err }, 'Redis unavailable, skipping token revocation check');
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
    if (!cached) {
      const user = await db.select('tbl_user', 'id, plan, emailVerified', 'id = ?', [decoded.userId]);
      if (!user) {
        throw new AppError('The user belonging to this token no longer exists', 401);
      }
      cached = {
        id: user.id,
        plan: user.plan as 'FREE' | 'PRO',
        emailVerified: Boolean(user.emailVerified),
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
    };
    req.tokenJti = decoded.jti;
    req.tokenExp = decoded.exp;

    next();
  } catch (err) {
    next(err);
  }
};
