import type { CookieOptions, Response } from 'express';
import { env } from '../config/env';

export const SESSION_COOKIE = 'saas_session';
export const REFRESH_COOKIE = 'saas_refresh';

function baseCookieOpts(maxAgeMs: number): CookieOptions {
  const opts: CookieOptions = {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
  if (env.COOKIE_DOMAIN) {
    opts.domain = env.COOKIE_DOMAIN;
  }
  return opts;
}

export function sessionCookieOpts(): CookieOptions {
  // Access token cookie — mirrors JWT_EXPIRES_IN default (24h)
  return baseCookieOpts(24 * 60 * 60 * 1000);
}

export function refreshCookieOpts(): CookieOptions {
  // Refresh token cookie — 7 days
  return baseCookieOpts(7 * 24 * 60 * 60 * 1000);
}

export function setSessionCookies(
  res: Response,
  accessToken: string,
  refreshToken: string
): void {
  res.cookie(SESSION_COOKIE, accessToken, sessionCookieOpts());
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOpts());
}

export function clearSessionCookies(res: Response): void {
  const clearOpts: CookieOptions = { path: '/', domain: env.COOKIE_DOMAIN || undefined };
  res.clearCookie(SESSION_COOKIE, clearOpts);
  res.clearCookie(REFRESH_COOKIE, clearOpts);
}

/** Omit token from JSON body — session lives in httpOnly cookies. */
export function authResponseBody(user: {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  emailVerified: boolean;
  isGuest?: boolean;
}) {
  return { user };
}
