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
  emailVerified?: number | boolean;
  isGuest?: boolean;
}): AuthResponse['user'] {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    plan: (row.plan as 'FREE' | 'PRO') || 'FREE',
    emailVerified: Boolean(row.emailVerified),
    ...(row.isGuest ? { isGuest: true } : {}),
  };
}

export const authService = {
  async register(input: RegisterInput): Promise<AuthResponse> {
    const { email, password, name } = input;
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

    try {
      await sendVerificationEmail(normalizedEmail, name || null, verify.raw);
    } catch (err) {
      logger.error({ err, email: normalizedEmail }, 'Failed to send verification email');
    }

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
    const { email, password } = input;

    const user: any = await db.select(
      'tbl_user',
      'id, email, passwordHash, name, plan, emailVerified',
      'email = ?',
      [email.toLowerCase()]
    );

    if (!user) {
      throw new AppError('Invalid email or password', 401);
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AppError('Invalid email or password', 401);
    }

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
  async guest(): Promise<AuthResponse> {
    const userId = crypto.randomUUID();
    const email = `guest-${userId}@guest.local`;
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), env.BCRYPT_ROUNDS);

    await db.insert('tbl_user', {
      id: userId,
      email,
      passwordHash,
      name: 'Guest',
      plan: 'FREE',
      emailVerified: 1,
      authProvider: 'guest',
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
   * Unsigned JWT decode and client-supplied email bodies are deliberately rejected.
   */
  async googleAuth(input: { credential?: string }): Promise<AuthResponse> {
    if (!input.credential) {
      throw new AppError('Google authentication failed: credential is required', 400);
    }
    if (!env.GOOGLE_CLIENT_ID) {
      throw new AppError('Google sign-in is not configured on this server', 503);
    }

    let email: string | undefined;
    let name: string | undefined;

    try {
      const verifyRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(input.credential)}`
      );
      if (!verifyRes.ok) {
        throw new AppError('Google authentication failed: invalid credential', 401);
      }
      const payload: any = await verifyRes.json();

      // Audience must match our client ID — otherwise any Google token would work.
      if (payload.aud !== env.GOOGLE_CLIENT_ID) {
        throw new AppError('Google authentication failed: audience mismatch', 401);
      }
      const verified =
        payload.email_verified === true ||
        payload.email_verified === 'true';
      if (!payload.email || !verified) {
        throw new AppError('Google authentication failed: email is not verified by Google', 401);
      }

      email = String(payload.email);
      name = payload.name || payload.given_name || undefined;
    } catch (err) {
      if (err instanceof AppError) throw err;
      logger.warn({ err }, 'Google tokeninfo request failed');
      throw new AppError('Google authentication failed: could not verify identity', 401);
    }

    const normalizedEmail = email!.toLowerCase();

    let user: any = await db.select(
      'tbl_user',
      'id, email, name, plan, emailVerified',
      'email = ?',
      [normalizedEmail]
    );

    if (!user) {
      const userId = crypto.randomUUID();
      const randomPasswordHash = await bcrypt.hash(
        crypto.randomBytes(32).toString('hex'),
        env.BCRYPT_ROUNDS
      );
      const userName = name || normalizedEmail.split('@')[0];

      await db.insert('tbl_user', {
        id: userId,
        email: normalizedEmail,
        passwordHash: randomPasswordHash,
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
      };
    } else if (!user.emailVerified) {
      // Existing password account signing in with Google — trust Google's verification.
      await db.execute(
        `UPDATE tbl_user
            SET emailVerified = 1,
                emailVerifyToken = NULL,
                emailVerifyExpiresAt = NULL,
                authProvider = IF(authProvider = 'password', 'password', 'google')
          WHERE id = ?`,
        [user.id]
      );
      await invalidateUser(user.id).catch(() => undefined);
      user.emailVerified = 1;
    }

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

    await sendVerificationEmail(user.email, user.name, verify.raw);
    return { sent: true };
  },
};
