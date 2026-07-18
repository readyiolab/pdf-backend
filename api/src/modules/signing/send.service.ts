import { getPool } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { AppError } from '../../middleware/errorHandler.middleware';
import { generateSigningToken } from '../../lib/signingSession';
import { isMailerConfigured, sendMail } from '../../lib/mailer';
import { invitationEmail } from './email.templates';
import { SIGNING_LIMITS } from '../../../../shared/signing';

/** Roles that are actually asked to do something. VIEWER/CC just receive a copy. */
const ACTIONABLE_ROLES = new Set(['SIGNER', 'APPROVER']);

export interface SendResult {
  documentId: string;
  status: string;
  notified: { recipientId: string; email: string; delivered: boolean; error?: string }[];
}

export const sendService = {
  /**
   * Puts a document out for signature.
   *
   * Everything below the validation block is irreversible from the recipient's
   * point of view — once a link is emailed it exists in someone's inbox forever
   * — so the preconditions are checked hard and up front.
   */
  async send(documentId: string, userId: string, senderName: string): Promise<SendResult> {
    const pool = getPool();

    const [docs]: any = await pool.query('SELECT * FROM tbl_sign_document WHERE id = ?', [documentId]);
    const doc = docs[0];
    if (!doc || doc.ownerId !== userId) {
      throw new AppError('Document not found', 404);
    }
    if (doc.status !== 'DRAFT') {
      // Not an error worth dressing up: re-sending would mint new tokens and
      // invalidate links people may already be acting on.
      throw new AppError('This document has already been sent.', 409);
    }
    if (!isMailerConfigured()) {
      throw new AppError('Email is not configured, so invitations cannot be delivered.', 503);
    }

    const [recipients]: any = await pool.query(
      'SELECT * FROM tbl_sign_recipient WHERE documentId = ? ORDER BY signingOrder ASC, createdAt ASC',
      [documentId]
    );
    if (recipients.length === 0) {
      throw new AppError('Add at least one recipient before sending.', 400);
    }

    const [fields]: any = await pool.query(
      'SELECT id, recipientId, label, type FROM tbl_sign_field WHERE documentId = ?',
      [documentId]
    );

    // A signer with no fields is asked to sign nothing — they would open the
    // document, find no action, and be stuck. Catch it here, not in support.
    const signers = recipients.filter((r: any) => ACTIONABLE_ROLES.has(r.role));
    if (signers.length === 0) {
      throw new AppError('Add at least one signer or approver — viewers alone cannot complete a document.', 400);
    }
    const fieldsBySigner = new Set(fields.map((f: any) => f.recipientId).filter(Boolean));
    const emptySigners = signers.filter((r: any) => !fieldsBySigner.has(r.id));
    if (emptySigners.length > 0) {
      throw new AppError(
        `${emptySigners.map((r: any) => r.name).join(', ')} ${emptySigners.length === 1 ? 'has' : 'have'} no fields to fill. Place at least one field for each signer.`,
        400
      );
    }

    // Unassigned fields would silently never be filled, and the document could
    // never reach COMPLETED if any of them were required.
    const orphaned = fields.filter((f: any) => !f.recipientId);
    if (orphaned.length > 0) {
      throw new AppError(
        `${orphaned.length} field${orphaned.length === 1 ? ' is' : 's are'} not assigned to anyone. Assign or remove ${orphaned.length === 1 ? 'it' : 'them'} before sending.`,
        400
      );
    }

    // SMS_OTP is accepted at the recipient level but can't be delivered yet.
    // Better to refuse the send than to email a link the signer can never open.
    const undeliverable = recipients.filter((r: any) => r.authMethod === 'SMS_OTP');
    if (undeliverable.length > 0) {
      throw new AppError(
        `SMS verification isn't available yet. Switch ${undeliverable.map((r: any) => r.name).join(', ')} to email verification or no verification.`,
        400
      );
    }

    const expiresAt = doc.expiresAt
      ? new Date(doc.expiresAt)
      : new Date(Date.now() + SIGNING_LIMITS.defaultExpiryDays * 86400_000);

    // Mint one token per recipient. Tokens are generated for EVERYONE now, even
    // in a sequential flow — later signers simply aren't emailed yet. Minting
    // on demand would mean a partially-tokenised document if the process died
    // between signatures.
    const tokens = new Map<string, string>();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const r of recipients) {
        const token = generateSigningToken();
        tokens.set(r.id, token);
        await conn.query(
          'UPDATE tbl_sign_recipient SET signingToken = ?, tokenExpiresAt = ?, status = ? WHERE id = ?',
          [token, expiresAt, 'PENDING', r.id]
        );
      }
      await conn.query(
        "UPDATE tbl_sign_document SET status = 'SENT', sentAt = ?, expiresAt = ? WHERE id = ?",
        [new Date(), expiresAt, documentId]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // In a sequential flow only the first signer is notified; the rest are
    // emailed as each one completes. In a parallel flow everyone goes at once.
    // VIEWER/CC are notified immediately in both cases — they aren't in the
    // signing chain, so there is nothing for them to wait for.
    const firstOrder = Math.min(...signers.map((r: any) => r.signingOrder));
    const toNotify =
      doc.flowType === 'SEQUENTIAL'
        ? recipients.filter((r: any) => !ACTIONABLE_ROLES.has(r.role) || r.signingOrder === firstOrder)
        : recipients;

    const notified = await deliverInvitations(toNotify, tokens, doc, senderName, expiresAt);

    return { documentId, status: 'SENT', notified };
  },

  /** Re-sends the invitation for one recipient. Used by reminders and by hand. */
  async resend(documentId: string, recipientId: string, userId: string, senderName: string) {
    const pool = getPool();
    const [docs]: any = await pool.query('SELECT * FROM tbl_sign_document WHERE id = ?', [documentId]);
    const doc = docs[0];
    if (!doc || doc.ownerId !== userId) throw new AppError('Document not found', 404);
    if (doc.status !== 'SENT') throw new AppError('This document is not awaiting signature.', 409);

    const [rows]: any = await pool.query(
      'SELECT * FROM tbl_sign_recipient WHERE id = ? AND documentId = ?',
      [recipientId, documentId]
    );
    const recipient = rows[0];
    if (!recipient) throw new AppError('Recipient not found', 404);
    if (recipient.status === 'COMPLETED') throw new AppError('This recipient has already signed.', 409);
    if (!recipient.signingToken) throw new AppError('This recipient has not been sent a link yet.', 409);

    const tokens = new Map([[recipient.id, recipient.signingToken]]);
    const notified = await deliverInvitations(
      [recipient],
      tokens,
      doc,
      senderName,
      recipient.tokenExpiresAt ? new Date(recipient.tokenExpiresAt) : null
    );
    return { documentId, notified };
  },
};

/**
 * Emails invitations.
 *
 * Delivery failures are collected, NOT thrown. The document is already SENT and
 * the tokens are already committed at this point; throwing would leave the
 * caller thinking nothing happened while some recipients had already been
 * emailed. The per-recipient result tells the sender exactly who to chase.
 */
async function deliverInvitations(
  recipients: any[],
  tokens: Map<string, string>,
  doc: any,
  senderName: string,
  expiresAt: Date | null
): Promise<SendResult['notified']> {
  const results: SendResult['notified'] = [];

  for (const r of recipients) {
    const token = tokens.get(r.id);
    if (!token) continue;

    // `/s/` — NOT `/sign/`, which is the owner's authenticated dashboard and
    // would bounce a recipient to a login page they have no account for.
    const signUrl = `${env.APP_URL.replace(/\/$/, '')}/s/${token}`;
    const mail = invitationEmail({
      signerName: r.name,
      senderName,
      documentTitle: doc.title,
      signUrl,
      message: doc.message,
      expiresAt,
    });

    try {
      await sendMail({ ...mail, to: r.email });
      await getPool().query("UPDATE tbl_sign_recipient SET status = 'SENT' WHERE id = ?", [r.id]);
      results.push({ recipientId: r.id, email: r.email, delivered: true });
      logger.info({ recipientId: r.id, documentId: doc.id }, 'Signing invitation sent');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delivery failed';
      // Never log the URL — it contains the bearer token.
      logger.error({ err, recipientId: r.id, documentId: doc.id }, 'Failed to send signing invitation');
      results.push({ recipientId: r.id, email: r.email, delivered: false, error: message });
    }
  }

  return results;
}
