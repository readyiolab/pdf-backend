import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * SMTP transport for signing invitations and OTPs.
 *
 * Created lazily and reused: nodemailer pools connections, and building a
 * transport per message would re-handshake TLS every time.
 */
let transporter: Transporter | null = null;

export function isMailerConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

function getTransporter(): Transporter {
  if (transporter) return transporter;

  if (!isMailerConfigured()) {
    // Callers must check isMailerConfigured() first. Throwing here rather than
    // silently no-op'ing is deliberate: a signing invitation that is quietly
    // dropped looks identical to one that was sent, and the sender only finds
    // out when the deal doesn't close.
    throw new Error('SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)');
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    pool: true,
    // Gmail throttles aggressively and will start deferring on burst sends.
    // Keeping concurrency low is cheaper than getting the account rate-limited
    // mid-send and having half a document's recipients never receive a link.
    maxConnections: 3,
    maxMessages: 50,
  });

  return transporter;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Absent text hurts deliverability and spam scoring. */
  text: string;
}

export interface MailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

/**
 * Sends one message. Throws on failure — the caller decides whether that is
 * fatal (an invitation) or tolerable (a reminder).
 */
export async function sendMail(message: MailMessage): Promise<MailResult> {
  const info = await getTransporter().sendMail({
    // Gmail rewrites From to the authenticated user unless SMTP_FROM is a
    // verified "send as" alias, so this is a request, not a guarantee.
    from: env.SMTP_FROM || env.SMTP_USER,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  // A 250 from the server means "queued", not "delivered". Anything in
  // `rejected` was refused outright and will never arrive.
  return {
    messageId: info.messageId,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}

/** Checks the credentials against the server. Used by the health endpoint. */
export async function verifyMailer(): Promise<boolean> {
  if (!isMailerConfigured()) return false;
  try {
    await getTransporter().verify();
    return true;
  } catch (err) {
    logger.error({ err }, 'SMTP verification failed');
    return false;
  }
}
