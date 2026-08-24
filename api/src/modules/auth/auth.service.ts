import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { env } from '../../config/env';
import { signToken } from '../../lib/jwt';
import { AppError } from '../../middleware/errorHandler.middleware';
import { RegisterInput, LoginInput, AuthResponse } from './auth.types';
import { isMailerConfigured, sendMail } from '../../lib/mailer';
import { logger } from '../../lib/logger';
import { invalidateUser } from '../../lib/userCache';
import { isGoogleAuthConfigured, verifyGoogleIdToken } from '../../lib/googleAuth';
import { stitchUserAttribution } from '../../lib/customerTracking';
import type { AttributionPayload } from '../../lib/customerTracking';

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashVerifyToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function mintVerifyToken(): { raw: string; hash: string; expiresAt: Date } {
  const raw = crypto.randomBytes(32).toString('hex');
  return {
    raw,
    hash: hashVerifyToken(raw),
    expiresAt: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
  };
}

async function sendVerificationEmail(email: string, name: string | null, rawToken: string): Promise<void> {
  if (!isMailerConfigured()) {
    logger.warn({ email }, 'SMTP not configured — skipping verification email (dev)');
    // In development without SMTP, log the link so local testing still works.
    if (env.NODE_ENV === 'development') {
      logger.info({ link: `${env.APP_URL}/verify-email?token=${rawToken}` }, 'Dev verification link');
    }
    return;
  }

  const link = `${env.APP_URL}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const text = `${greeting}\n\nPlease verify your email for PDFToolkit by opening this link:\n${link}\n\nThis link expires in 24 hours.\n\nIf you did not create an account, you can ignore this email.`;
  const html = `
    <p>${greeting}</p>
    <p>Please verify your email for <strong>PDFToolkit</strong>.</p>
    <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Verify my email</a></p>
    <p style="color:#64748b;font-size:13px">Or paste this link into your browser:<br/>${link}</p>
    <p style="color:#64748b;font-size:13px">This link expires in 24 hours. If you did not create an account, ignore this email.</p>
  `;

  await sendMail({
    to: email,
    subject: 'Verify your PDFToolkit email',
    text,
    html,
  });
}

function toAuthUser(row: {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  emailVerified?: number | boolean | string;
  isGuest?: boolean;
}): AuthResponse['user'] {
  const verified =
    row.emailVerified === true ||
    row.emailVerified === 1 ||
    row.emailVerified === '1';
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    plan: (row.plan as 'FREE' | 'PRO') || 'FREE',
    emailVerified: verified,
    ...(row.isGuest ? { isGuest: true } : {}),
  };
}

export const authService = {
  async register(input: RegisterInput): Promise<AuthResponse> {
    const { email, password, name, attribution } = input;
    const normalizedEmail = email.toLowerCase();

    const existing = await db.select('tbl_user', 'id', 'email = ?', [normalizedEmail]);
    if (existing) {
      throw new AppError('Email is already registered', 409);
    }

    const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
    const userId = crypto.randomUUID();
    const verify = mintVerifyToken();

    await db.insert('tbl_user', {
      id: userId,
      email: normalizedEmail,
      passwordHash,
      name: name || null,
      plan: 'FREE',
      emailVerified: 0,
      emailVerifyToken: verify.hash,
      emailVerifyExpiresAt: verify.expiresAt,
      authProvider: 'password',
    });

    void stitchUserAttribution({
      userId,
      email: normalizedEmail,
      name: name || null,
      attribution: attribution as AttributionPayload | undefined,
      eventType: 'signup',
    });

    // Do not block the API response on SMTP — Gmail can take several seconds.
    void sendVerificationEmail(normalizedEmail, name || null, verify.raw).catch((err) => {
      logger.error({ err, email: normalizedEmail }, 'Failed to send verification email');
    });

    const token = signToken({ userId, email: normalizedEmail, plan: 'FREE' });

    return {
      token,
      user: {
        id: userId,
        email: normalizedEmail,
        name: name || null,
        plan: 'FREE',
        emailVerified: false,
      },
    };
  },

  async login(input: LoginInput): Promise<AuthResponse> {
    const { email, password, attribution } = input;

    const user: any = await db.select(
      'tbl_user',
      'id, email, passwordHash, name, plan, emailVerified, authProvider',
      'email = ?',
      [email.toLowerCase()]
    );

    if (!user) {
      throw new AppError('Invalid email or password', 401);
    }

    // Guest / Google accounts are not password-loginable (no expensive bcrypt).
    if (
      !user.passwordHash ||
      !String(user.passwordHash).startsWith('$2') ||
      user.authProvider === 'guest' ||
      user.authProvider === 'google'
    ) {
      throw new AppError('Invalid email or password', 401);
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password', 401);
    }

    void stitchUserAttribution({
      userId: user.id,
      email: user.email,
      name: user.name,
      attribution: attribution as AttributionPayload | undefined,
      eventType: 'login',
    });

    const token = signToken({ userId: user.id, email: user.email, plan: user.plan });

    return {
      token,
      user: toAuthUser(user),
    };
  },

  /**
   * Creates a real, short-lived anonymous session. Guest rows use the
   * @guest.local domain for later cleanup and are treated as verified so
   * workspace tools work; signing/AI still require requireFullAccount.
   */
  async guest(attribution?: AttributionPayload): Promise<AuthResponse> {
    const userId = crypto.randomUUID();
    const email = `guest-${userId}@guest.local`;

    await db.insert('tbl_user', {
      id: userId,
      email,
      // Unusable marker — guests never sign in with a password (avoids bcrypt cost).
      passwordHash: '!guest',
      name: 'Guest',
      plan: 'FREE',
      emailVerified: 1,
      authProvider: 'guest',
    });

    void stitchUserAttribution({
      userId,
      email,
      name: 'Guest',
      attribution,
      eventType: 'signup',
    });

    const token = signToken({ userId, email, plan: 'FREE', isGuest: true });

    return {
      token,
      user: {
        id: userId,
        email,
        name: 'Guest',
        plan: 'FREE',
        emailVerified: true,
        isGuest: true,
      },
    };
  },

  /**
   * Authenticates or registers a user via a verified Google ID token.
   *
   * The browser GIS button sends `credential` (a JWT). We verify signature,
   * audience, issuer, and email_verified with google-auth-library — never trust
   * a client-supplied email body.
   */
  async googleAuth(input: {
    credential?: string;
    attribution?: AttributionPayload;
  }): Promise<AuthResponse> {
    if (!isGoogleAuthConfigured()) {
      throw new AppError('Google sign-in is not configured on this server', 503);
    }
    if (!input.credential) {
      throw new AppError('Google authentication failed: credential is required', 400);
    }

    const identity = await verifyGoogleIdToken(input.credential);
    const normalizedEmail = identity.email;
    const userName = identity.name || normalizedEmail.split('@')[0];

    let user: any = await db.select(
      'tbl_user',
      'id, email, name, plan, emailVerified, authProvider',
      'email = ?',
      [normalizedEmail]
    );

    let isNew = false;
    if (!user) {
      isNew = true;
      const userId = crypto.randomUUID();
      await db.insert('tbl_user', {
        id: userId,
        email: normalizedEmail,
        // Unusable — Google accounts sign in via ID token, not password.
        passwordHash: '!google',
        name: userName,
        plan: 'FREE',
        emailVerified: 1,
        authProvider: 'google',
      });

      user = {
        id: userId,
        email: normalizedEmail,
        name: userName,
        plan: 'FREE',
        emailVerified: 1,
        authProvider: 'google',
      };
      logger.info({ userId, email: normalizedEmail }, 'Created user via Google sign-in');
    } else {
      // Existing account (password or google): trust Google's verified email.
      const updates: Record<string, unknown> = {
        emailVerified: 1,
        emailVerifyToken: null,
        emailVerifyExpiresAt: null,
      };
      // Prefer a real display name from Google if we only had a placeholder.
      if (identity.name && (!user.name || user.name === normalizedEmail.split('@')[0])) {
        updates.name = identity.name;
        user.name = identity.name;
      }
      // Keep 'password' if they registered with email first; otherwise mark google.
      if (user.authProvider !== 'password') {
        updates.authProvider = 'google';
      }
      await db.update('tbl_user', updates, 'id = ?', [user.id]);
      await invalidateUser(user.id).catch(() => undefined);
      user.emailVerified = 1;
      logger.info({ userId: user.id, email: normalizedEmail }, 'Signed in via Google');
    }

    void stitchUserAttribution({
      userId: user.id,
      email: user.email,
      name: user.name,
      attribution: input.attribution,
      eventType: isNew ? 'signup' : 'login',
    });

    const token = signToken({ userId: user.id, email: user.email, plan: user.plan });

    return {
      token,
      user: toAuthUser({ ...user, emailVerified: 1 }),
    };
  },

  async verifyEmail(rawToken: string): Promise<AuthResponse> {
    const hash = hashVerifyToken(rawToken);

    const user: any = await db.select(
      'tbl_user',
      'id, email, name, plan, emailVerified, emailVerifyExpiresAt',
      'emailVerifyToken = ?',
      [hash]
    );
    if (!user) {
      throw new AppError('This verification link is invalid or has already been used', 400);
    }
    if (user.emailVerified) {
      const token = signToken({ userId: user.id, email: user.email, plan: user.plan });
      return { token, user: toAuthUser({ ...user, emailVerified: 1 }) };
    }
    if (user.emailVerifyExpiresAt && new Date(user.emailVerifyExpiresAt) < new Date()) {
      throw new AppError('This verification link has expired. Please request a new one.', 400);
    }

    await db.update(
      'tbl_user',
      { emailVerified: 1, emailVerifyToken: null, emailVerifyExpiresAt: null },
      'id = ?',
      [user.id]
    );
    // Drop stale auth cache so the next request sees emailVerified=true immediately.
    await invalidateUser(user.id).catch(() => undefined);

    const token = signToken({ userId: user.id, email: user.email, plan: user.plan });
    return { token, user: toAuthUser({ ...user, emailVerified: 1 }) };
  },

  async resendVerification(userId: string): Promise<{ sent: boolean }> {
    const user = await db.select(
      'tbl_user',
      'id, email, name, emailVerified, authProvider',
      'id = ?',
      [userId]
    );
    if (!user) throw new AppError('User not found', 404);
    if (user.emailVerified) {
      throw new AppError('Your email is already verified', 400);
    }
    if (user.authProvider === 'guest') {
      throw new AppError('Guest accounts do not need email verification', 400);
    }

    const verify = mintVerifyToken();
    await db.update(
      'tbl_user',
      { emailVerifyToken: verify.hash, emailVerifyExpiresAt: verify.expiresAt },
      'id = ?',
      [user.id]
    );

    // Return immediately — SMTP latency must not block the client (15s browser timeout).
    void sendVerificationEmail(user.email, user.name, verify.raw).catch((err) => {
      logger.error({ err, email: user.email }, 'Failed to resend verification email');
    });
    return { sent: true };
  },
};
