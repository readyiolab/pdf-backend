import { Request, Response, NextFunction } from 'express';
import { getPool } from '../lib/mysql';
import { verifyToken, isTokenRevoked } from '../lib/jwt';
import { getCachedUser, setCachedUser } from '../lib/userCache';
import { AppError } from './errorHandler.middleware';

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

    // Reject tokens that have been explicitly revoked (e.g. via logout)
    if (decoded.jti && (await isTokenRevoked(decoded.jti))) {
      throw new AppError('This session has been logged out', 401);
    }

    // Resolve the user, preferring a short-TTL cache to keep MySQL off the hot
    // path. A cache miss falls back to the DB and repopulates the cache.
    let cached = await getCachedUser(decoded.userId);
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
      await setCachedUser(cached);
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
