import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { redis } from './redis';
import { env } from '../config/env';

export const ADMIN_JWT_AUDIENCE = 'platform-admin';
export const CUSTOMER_JWT_AUDIENCE = 'customer';
export const REFRESH_JWT_AUDIENCE = 'customer-refresh';

export interface TokenClaims {
  userId: string;
  email: string;
  plan: 'FREE' | 'PRO' | 'ENTERPRISE';
  isGuest?: boolean;
}

interface DecodedToken extends TokenClaims {
  jti: string;
  iat: number;
  exp: number;
  aud?: string | string[];
}

const DENYLIST_PREFIX = 'jwt:denylist:';

export function signToken(
  claims: TokenClaims,
  opts?: { audience?: string; expiresIn?: string }
): string {
  const expiresIn =
    opts?.expiresIn ||
    (claims.isGuest ? env.GUEST_JWT_EXPIRES_IN : env.JWT_EXPIRES_IN);
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: expiresIn as any,
    jwtid: crypto.randomUUID(),
    audience: opts?.audience || CUSTOMER_JWT_AUDIENCE,
    algorithm: 'HS256',
  });
}

/** Long-lived refresh token for silent session renewal via httpOnly cookie. */
export function signRefreshToken(claims: TokenClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.REFRESH_JWT_EXPIRES_IN as any,
    jwtid: crypto.randomUUID(),
    audience: REFRESH_JWT_AUDIENCE,
    algorithm: 'HS256',
  });
}

export function verifyToken(
  token: string,
  opts?: { audience?: string | string[] }
): DecodedToken {
  const verified = jwt.verify(token, env.JWT_SECRET, {
    audience: opts?.audience as jwt.VerifyOptions['audience'],
    algorithms: ['HS256'],
  });
  return verified as unknown as DecodedToken;
}

/** Revokes a token until its natural expiry (used by logout). */
export async function revokeToken(jti: string, exp: number): Promise<void> {
  const ttl = exp - Math.floor(Date.now() / 1000);
  if (ttl > 0) {
    await redis.set(`${DENYLIST_PREFIX}${jti}`, '1', 'EX', ttl);
  }
}

export async function isTokenRevoked(jti: string): Promise<boolean> {
  const hit = await redis.get(`${DENYLIST_PREFIX}${jti}`);
  return hit !== null;
}
