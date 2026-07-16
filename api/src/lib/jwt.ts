import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { redis } from './redis';
import { env } from '../config/env';

export interface TokenClaims {
  userId: string;
  email: string;
  plan: 'FREE' | 'PRO';
  isGuest?: boolean;
}

interface DecodedToken extends TokenClaims {
  jti: string;
  iat: number;
  exp: number;
}

const DENYLIST_PREFIX = 'jwt:denylist:';

/** Signs a token with a unique jti so it can later be individually revoked. */
export function signToken(claims: TokenClaims): string {
  const expiresIn = claims.isGuest ? env.GUEST_JWT_EXPIRES_IN : env.JWT_EXPIRES_IN;
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: expiresIn as any,
    jwtid: crypto.randomUUID(),
  });
}

export function verifyToken(token: string): DecodedToken {
  return jwt.verify(token, env.JWT_SECRET) as DecodedToken;
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
