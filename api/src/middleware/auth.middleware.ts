import { Request, Response, NextFunction } from 'express';
import { getPool } from '../lib/mysql';
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
      };
      // The raw token claims, used by logout to revoke this exact token.
      tokenJti?: string;
      tokenExp?: number;
    }
  }
}

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

    // Verify token signature/expiry
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      throw new AppError('Invalid or expired authentication token', 401);
    }

    // Reject tokens that have been explicitly revoked (e.g. via logout).
    // Redis errors here are non-fatal: revocation is a defense-in-depth check
    // on top of JWT signature/expiry verification, not the primary boundary,
    // so we fail open rather than taking down all authenticated traffic on a
    // Redis outage/quota error.
    let revoked = false;
    try {
      revoked = decoded.jti ? await isTokenRevoked(decoded.jti) : false;
    } catch (err) {
      logger.warn({ err }, 'Redis unavailable, skipping token revocation check');
    }
    if (revoked) {
      throw new AppError('This session has been logged out', 401);
    }

    // Resolve the user, preferring a short-TTL cache to keep MySQL off the hot
    // path. A cache miss (or a Redis error reading it) falls back to the DB;
    // a Redis error writing it back is a non-fatal cache-population failure.
    let cached: CachedUser | null = null;
    try {
      cached = await getCachedUser(decoded.userId);
    } catch (err) {
      logger.warn({ err }, 'Redis unavailable, skipping user cache read');
    }
    if (!cached) {
      const pool = getPool();
      const [users]: any = await pool.query('SELECT id, plan FROM tbl_user WHERE id = ?', [
        decoded.userId,
      ]);
      const user = users[0];
      if (!user) {
        throw new AppError('The user belonging to this token no longer exists', 401);
      }
      cached = { id: user.id, plan: user.plan as 'FREE' | 'PRO' };
      try {
        await setCachedUser(cached);
      } catch (err) {
        logger.warn({ err }, 'Redis unavailable, skipping user cache write');
      }
    }

    // Attach user to request
    req.user = {
      id: cached.id,
      plan: cached.plan,
      isGuest: Boolean(decoded.isGuest),
    };
    req.tokenJti = decoded.jti;
    req.tokenExp = decoded.exp;

    next();
  } catch (err) {
    next(err);
  }
};
