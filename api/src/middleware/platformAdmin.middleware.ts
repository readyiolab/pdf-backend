import { Request, Response, NextFunction } from 'express';
import { db } from '../lib/mysql';
import { env } from '../config/env';
import { AppError } from './errorHandler.middleware';
import { ADMIN_JWT_AUDIENCE, verifyToken } from '../lib/jwt';

function adminEmailAllowlist(): Set<string> {
  const raw = env.PLATFORM_ADMIN_EMAILS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

function ipAllowlist(): string[] {
  const raw = env.PLATFORM_ADMIN_IP_ALLOWLIST?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function ipAllowed(ip: string | null | undefined): boolean {
  const list = ipAllowlist();
  if (!list.length) return true;
  if (!ip) return false;
  // Exact match (CIDR support can be added later)
  return list.some((entry) => entry === ip || entry === '*');
}

export async function isPlatformAdminUser(userId: string): Promise<boolean> {
  const user = await db.select('tbl_user', 'email, isPlatformAdmin', 'id = ?', [userId]);
  if (!user) return false;
  if (user.isPlatformAdmin === 1 || user.isPlatformAdmin === true) return true;
  const email = String(user.email || '').toLowerCase();
  return email.length > 0 && adminEmailAllowlist().has(email);
}

/** Must run after authMiddleware. Requires admin JWT audience + platform-admin role. */
export const requirePlatformAdmin = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user?.id || req.user.isGuest) {
      throw new AppError('Platform admin access required', 403);
    }

    if (!ipAllowed(req.ip)) {
      throw new AppError('Platform admin access denied from this network', 403);
    }

    // Prefer the admin-audience token issued by POST /api/admin/login
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const decoded = verifyToken(authHeader.slice(7));
        const aud = decoded.aud;
        const audOk =
          aud === ADMIN_JWT_AUDIENCE ||
          (Array.isArray(aud) && aud.includes(ADMIN_JWT_AUDIENCE));
        if (!audOk) {
          throw new AppError(
            'Use the Admin app sign-in (platform-admin session required).',
            403
          );
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError('Invalid admin session', 401);
      }
    }

    const ok = await isPlatformAdminUser(req.user.id);
    if (!ok) throw new AppError('Platform admin access required', 403);
    next();
  } catch (err) {
    next(err);
  }
};
