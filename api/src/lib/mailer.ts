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

/** Fail fast rather than letting the API / browser hang on a stuck SMTP socket. */
const SMTP_TIMEOUT_MS = 8_000;

export function isMailerConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

function resetTransporter(): void {
  if (transporter) {
    try {
      transporter.close();
    } catch {
      // ignore close errors on a dead connection
    }
  }
  transporter = null;
}

function getTransporter(): Transporter {
  if (transporter) return transporter;

  if (!isMailerConfigured()) {
    throw new Error('SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)');
  }

  // Prefer STARTTLS on 587 from cloud VMs (DigitalOcean often struggles with 465).
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    tls: {
      // Gmail / most providers; keep hostname verification on.
      servername: env.SMTP_HOST,
      minVersion: 'TLSv1.2',
    },
  });

  return transporter;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
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
  try {
    const info = await getTransporter().sendMail({
      from: env.SMTP_FROM || env.SMTP_USER,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  } catch (err) {
    // Drop a poisoned pool connection so the next send opens a fresh one.
    resetTransporter();
    throw err;
  }
}

/** Checks the credentials against the server. Used by the health endpoint. */
export async function verifyMailer(): Promise<boolean> {
  if (!isMailerConfigured()) return false;
  try {
    await getTransporter().verify();
    return true;
  } catch (err) {
    resetTransporter();
    logger.error({ err }, 'SMTP verification failed');
    return false;
  }
}
