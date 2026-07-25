import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { env } from '../config/env';
import { logger } from './logger';
import { AppError } from '../middleware/errorHandler.middleware';

/**
 * Google Identity Services (GIS) ID-token verification.
 *
 * The browser GIS button / One Tap returns a JWT (`credential`). We verify it
 * with Google's public keys via google-auth-library — NOT by trusting a decoded
 * payload or a client-supplied email.
 *
 * GOOGLE_CLIENT_SECRET is unused for this flow (no authorization-code exchange).
 * Keep it in Google Cloud Console if you add Drive/calendar later; ID login only
 * needs the Client ID as the JWT audience.
 */

let client: OAuth2Client | null = null;

export function isGoogleAuthConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim());
}

function getClient(): OAuth2Client {
  if (!env.GOOGLE_CLIENT_ID?.trim()) {
    throw new AppError('Google sign-in is not configured on this server', 503);
  }
  if (!client) {
    client = new OAuth2Client({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    });
    logger.info({ clientIdSuffix: env.GOOGLE_CLIENT_ID.slice(-24) }, 'Google OAuth2 client ready');
  }
  return client;
}

export interface VerifiedGoogleIdentity {
  email: string;
  name: string | null;
  picture: string | null;
  sub: string;
  emailVerified: boolean;
}

/**
 * Verifies a GIS ID token and returns the trusted identity claims.
 */
export async function verifyGoogleIdToken(credential: string): Promise<VerifiedGoogleIdentity> {
  if (!credential?.trim()) {
    throw new AppError('Google authentication failed: credential is required', 400);
  }

  let payload: TokenPayload | undefined;
  try {
    const ticket = await getClient().verifyIdToken({
      idToken: credential,
      audience: env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    logger.warn({ err }, 'Google ID token verification failed');
    throw new AppError('Google authentication failed: invalid or expired credential', 401);
  }

  if (!payload) {
    throw new AppError('Google authentication failed: empty token payload', 401);
  }

  const issOk =
    payload.iss === 'accounts.google.com' || payload.iss === 'https://accounts.google.com';
  if (!issOk) {
    throw new AppError('Google authentication failed: unexpected token issuer', 401);
  }

  if (!payload.email) {
    throw new AppError('Google authentication failed: email missing from token', 401);
  }

  if (payload.email_verified !== true) {
    throw new AppError('Google authentication failed: email is not verified by Google', 401);
  }

  return {
    email: String(payload.email).toLowerCase().trim(),
    name: payload.name || payload.given_name || null,
    picture: payload.picture || null,
    sub: String(payload.sub),
    emailVerified: true,
  };
}
