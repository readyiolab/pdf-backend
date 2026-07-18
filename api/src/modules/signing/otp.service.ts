import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { getPool } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { AppError } from '../../middleware/errorHandler.middleware';
import { isMailerConfigured, sendMail } from '../../lib/mailer';
import { otpEmail } from './email.templates';

/** Lifetime of a code. Long enough to switch apps and read it, short enough to matter. */
const OTP_TTL_MS = 10 * 60 * 1000;

/**
 * A 6-digit code has only 10^6 possibilities, so the attempt cap — not the code
 * length — is what actually makes this secure. Five guesses against a 10-minute
 * window is a 1-in-200,000 chance per challenge.
 */
const MAX_ATTEMPTS = 5;

/**
 * Generates a 6-digit code using a CSPRNG.
 *
 * `crypto.randomInt` rather than `Math.random`: this is an authentication
 * factor, and Math.random is a predictable PRNG whose output can be recovered
 * from a few samples. randomInt is also rejection-sampled, so the digits are
 * uniform — `randomBytes % 1000000` would be measurably biased.
 */
function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export const otpService = {
  /**
   * Issues a fresh OTP and delivers it. Any previous code is overwritten and
   * the attempt counter resets — otherwise a signer who exhausted their
   * attempts could never recover, and a stale code would stay valid alongside
   * the new one.
   */
  async issue(recipient: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    authMethod: string;
  }, documentTitle: string): Promise<{ channel: 'email' | 'sms'; sentTo: string }> {
    if (recipient.authMethod === 'SMS_OTP') {
      // WATI isn't wired yet. Fail loudly rather than issuing a code the signer
      // can never receive and leaving them staring at an OTP box forever.
      throw new AppError(
        'SMS verification is not available yet. Ask the sender to switch this recipient to email verification.',
        503
      );
    }

    if (!isMailerConfigured()) {
      throw new AppError('Verification is temporarily unavailable. Please try again later.', 503);
    }

    const code = generateCode();
    const codeHash = await bcrypt.hash(code, env.BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await getPool().query(
      `UPDATE tbl_sign_recipient
          SET otpHash = ?, otpExpiresAt = ?, otpAttempts = 0
        WHERE id = ?`,
      [codeHash, expiresAt, recipient.id]
    );

    const mail = otpEmail({ name: recipient.name, code, documentTitle, ttlMinutes: OTP_TTL_MS / 60000 });
    await sendMail({ to: recipient.email, ...mail });

    logger.info({ recipientId: recipient.id }, 'OTP issued');
    // The code itself is never logged and never returned to the caller — it is
    // only ever transmitted over the delivery channel.
    return { channel: 'email', sentTo: maskEmail(recipient.email) };
  },

  /**
   * Verifies a submitted code.
   *
   * Increments the attempt counter BEFORE comparing, so a crash, a timeout, or
   * a dropped connection mid-verify can't be used to get a free guess.
   */
  async verify(recipientId: string, code: string): Promise<void> {
    const pool = getPool();
    const [rows]: any = await pool.query(
      'SELECT otpHash, otpExpiresAt, otpAttempts FROM tbl_sign_recipient WHERE id = ?',
      [recipientId]
    );
    const row = rows[0];

    if (!row?.otpHash) {
      throw new AppError('Request a verification code first.', 400);
    }
    if (row.otpAttempts >= MAX_ATTEMPTS) {
      throw new AppError('Too many incorrect attempts. Request a new code.', 429);
    }
    if (new Date(row.otpExpiresAt).getTime() < Date.now()) {
      throw new AppError('That code has expired. Request a new one.', 400);
    }

    await pool.query('UPDATE tbl_sign_recipient SET otpAttempts = otpAttempts + 1 WHERE id = ?', [
      recipientId,
    ]);

    // bcrypt.compare is constant-time for a given hash, so a wrong code reveals
    // nothing through timing.
    if (!(await bcrypt.compare(code, row.otpHash))) {
      throw new AppError('That code is incorrect.', 400);
    }

    // Burn the code on success. Without clearing otpHash the same code would
    // stay valid for the rest of its TTL and could be replayed.
    await pool.query(
      `UPDATE tbl_sign_recipient
          SET otpVerifiedAt = ?, otpHash = NULL, otpExpiresAt = NULL, otpAttempts = 0
        WHERE id = ?`,
      [new Date(), recipientId]
    );

    logger.info({ recipientId }, 'OTP verified');
  },
};

/** j***@example.com — enough to confirm the right inbox without echoing it back. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}
