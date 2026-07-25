import { db } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { AppError } from '../../middleware/errorHandler.middleware';
import { generateSigningToken } from '../../lib/signingSession';
import { isMailerConfigured, sendMail } from '../../lib/mailer';
import { invitationEmail } from './email.templates';
import { SIGNING_LIMITS } from '../../../../shared/signing';
import { PLAN_LIMITS } from '../../../../shared/constants';

/** Rolling window (ms) over which the monthly signing quota is counted. */
const SIGN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
    const doc = await db.select('tbl_sign_document', '*', 'id = ?', [documentId]);
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

    // The owner's plan drives the monthly signing quota reserved below.
    const user = await db.select('tbl_user', 'plan', 'id = ?', [userId]);
    const plan = (user?.plan as 'FREE' | 'PRO') ?? 'FREE';
    const signLimit = PLAN_LIMITS[plan].maxMonthlySigns;

    const recipients = await db.selectAll(
      'tbl_sign_recipient',
      '*',
      'documentId = ?',
      [documentId],
      'ORDER BY signingOrder ASC, createdAt ASC'
    );
    if (recipients.length === 0) {
      throw new AppError('Add at least one recipient before sending.', 400);
    }

    const fields = await db.selectAll(
      'tbl_sign_field',
      'id, recipientId, label, type',
      'documentId = ?',
      [documentId]
    );

    // A SIGNER with no fields is asked to sign nothing — they would open the
    // document, find no action, and be stuck. APPROVERs may complete with zero
    // fields (approve-only). Catch empty SIGNERS here, not in support.
    const signers = recipients.filter((r: any) => ACTIONABLE_ROLES.has(r.role));
    if (signers.length === 0) {
      throw new AppError('Add at least one signer or approver — viewers alone cannot complete a document.', 400);
    }
    const fieldsBySigner = new Set(fields.map((f: any) => f.recipientId).filter(Boolean));
    const emptySigners = signers.filter(
      (r: any) => r.role === 'SIGNER' && !fieldsBySigner.has(r.id)
    );
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
    const conn = await db.beginTransaction();
    try {
      // Reserve one monthly signing credit atomically, as the FIRST step of the
      // transaction. Mirrors the daily-ops reservation in jobs.service: a single
      // guarded UPDATE avoids the read-modify-write race where two concurrent
      // sends both pass a separate check. If the 30-day window has elapsed the
      // counter resets to 1 and the window rolls; otherwise it increments only
      // while still under the plan limit. Because it lives inside this
      // transaction, a later failure (token minting, status flip) rolls the
      // credit back automatically — no compensating refund needed.
      const now = new Date();
      const windowCutoff = new Date(now.getTime() - SIGN_WINDOW_MS);
      const [reserve]: any = await conn.query(
        `UPDATE tbl_user
            SET monthlySignsUsed    = IF(monthlySignsResetAt < ?, 1, monthlySignsUsed + 1),
                monthlySignsResetAt = IF(monthlySignsResetAt < ?, ?, monthlySignsResetAt)
          WHERE id = ?
            AND (monthlySignsResetAt < ? OR monthlySignsUsed < ?)`,
        [windowCutoff, windowCutoff, now, userId, windowCutoff, signLimit]
      );
      if (reserve.affectedRows === 0) {
        await db.rollback(conn);
        throw new AppError(
          plan === 'PRO'
            ? `You've reached your monthly limit of ${signLimit} sent documents. It resets on a rolling 30-day basis.`
            : `You've reached your free plan's limit of ${signLimit} documents sent for signature this month. Upgrade to PRO to send more.`,
          403
        );
      }

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
      await db.commit(conn);
    } catch (err) {
      // rollback may have already run on quota failure; ignore double-rollback
      try {
        await db.rollback(conn);
      } catch {
        /* already released */
      }
      throw err;
    }

    // In a sequential flow only the first signer is notified; the rest are
    // emailed as each one completes. In a parallel flow everyone goes at once.
    // VIEWER/CC are notified immediately in both cases — they aren't in the
    // signing chain, so there is nothing for them to wait for.
    // Coerce signingOrder: mysql2 usually returns INT as number, but drivers /
    // serializers can yield strings — strict === would skip every signer and
    // send zero invitation emails.
    const firstOrder = Math.min(...signers.map((r: any) => Number(r.signingOrder)));
    const toNotify =
      doc.flowType === 'SEQUENTIAL'
        ? recipients.filter(
            (r: any) => !ACTIONABLE_ROLES.has(r.role) || Number(r.signingOrder) === firstOrder
          )
        : recipients;

    const notified = await deliverInvitations(toNotify, tokens, doc, senderName, expiresAt);

    // Document + tokens are already committed. If every invite bounced, undo the
    // send so the owner can fix SMTP / the address and try again — otherwise the
    // UI says "Sent" while nobody can open a link from their inbox.
    const actionableNotified = notified.filter((n) =>
      toNotify.some((r: any) => r.id === n.recipientId && ACTIONABLE_ROLES.has(r.role))
    );
    if (
      actionableNotified.length > 0 &&
      actionableNotified.every((n) => !n.delivered)
    ) {
      await revertFailedSend(documentId, userId);
      const reason = actionableNotified[0]?.error || 'SMTP delivery failed';
      throw new AppError(
        `Couldn't deliver the signing invitation email (${reason}). Check your email settings and try again.`,
        503
      );
    }

    return { documentId, status: 'SENT', notified };
  },

  /**
   * Self-sign path: same validations as send, but the only actionable recipient
   * must be the owner, no invitation email is sent, and the signing token is
   * returned so the owner can open `/s/:token` in-app.
   */
  async sendSelf(
    documentId: string,
    userId: string
  ): Promise<{ documentId: string; status: string; token: string }> {
    const doc = await db.select('tbl_sign_document', '*', 'id = ?', [documentId]);
    if (!doc || doc.ownerId !== userId) {
      throw new AppError('Document not found', 404);
    }
    if (doc.status !== 'DRAFT') {
      throw new AppError('This document has already been sent.', 409);
    }

    const user = await db.select('tbl_user', 'plan, email', 'id = ?', [userId]);
    const plan = (user?.plan as 'FREE' | 'PRO') ?? 'FREE';
    const signLimit = PLAN_LIMITS[plan].maxMonthlySigns;
    const resolvedOwnerEmail = String(user?.email || '')
      .toLowerCase()
      .trim();
    if (!resolvedOwnerEmail) {
      throw new AppError('Your account email is required for self-sign.', 400);
    }

    const recipients = await db.selectAll(
      'tbl_sign_recipient',
      '*',
      'documentId = ?',
      [documentId],
      'ORDER BY signingOrder ASC, createdAt ASC'
    );
    if (recipients.length === 0) {
      throw new AppError('Add yourself as a signer before signing.', 400);
    }

    const signers = recipients.filter((r: any) => ACTIONABLE_ROLES.has(r.role));
    if (signers.length !== 1) {
      throw new AppError(
        'Self-sign is only available when you are the sole signer or approver on the document.',
        400
      );
    }
    const self = signers[0];
    if (String(self.email).toLowerCase() !== resolvedOwnerEmail) {
      throw new AppError('Self-sign requires you to be listed as the signer with your account email.', 400);
    }

    const fields = await db.selectAll(
      'tbl_sign_field',
      'id, recipientId, label, type',
      'documentId = ?',
      [documentId]
    );
    const fieldsBySigner = new Set(fields.map((f: any) => f.recipientId).filter(Boolean));
    if (self.role === 'SIGNER' && !fieldsBySigner.has(self.id)) {
      throw new AppError('Place at least one field for yourself before signing.', 400);
    }
    const orphaned = fields.filter((f: any) => !f.recipientId);
    if (orphaned.length > 0) {
      throw new AppError(
        `${orphaned.length} field${orphaned.length === 1 ? ' is' : 's are'} not assigned to anyone. Assign or remove ${orphaned.length === 1 ? 'it' : 'them'} before signing.`,
        400
      );
    }

    const expiresAt = doc.expiresAt
      ? new Date(doc.expiresAt)
      : new Date(Date.now() + SIGNING_LIMITS.defaultExpiryDays * 86400_000);

    const token = generateSigningToken();
    const conn = await db.beginTransaction();
    try {
      const now = new Date();
      const windowCutoff = new Date(now.getTime() - SIGN_WINDOW_MS);
      const [reserve]: any = await conn.query(
        `UPDATE tbl_user
            SET monthlySignsUsed    = IF(monthlySignsResetAt < ?, 1, monthlySignsUsed + 1),
                monthlySignsResetAt = IF(monthlySignsResetAt < ?, ?, monthlySignsResetAt)
          WHERE id = ?
            AND (monthlySignsResetAt < ? OR monthlySignsUsed < ?)`,
        [windowCutoff, windowCutoff, now, userId, windowCutoff, signLimit]
      );
      if (reserve.affectedRows === 0) {
        await db.rollback(conn);
        throw new AppError(
          plan === 'PRO'
            ? `You've reached your monthly limit of ${signLimit} sent documents. It resets on a rolling 30-day basis.`
            : `You've reached your free plan's limit of ${signLimit} documents sent for signature this month. Upgrade to PRO to send more.`,
          403
        );
      }

      for (const r of recipients) {
        const rToken = r.id === self.id ? token : generateSigningToken();
        await conn.query(
          'UPDATE tbl_sign_recipient SET signingToken = ?, tokenExpiresAt = ?, status = ? WHERE id = ?',
          [rToken, expiresAt, r.id === self.id ? 'SENT' : 'PENDING', r.id]
        );
      }
      await conn.query(
        "UPDATE tbl_sign_document SET status = 'SENT', sentAt = ?, expiresAt = ? WHERE id = ?",
        [new Date(), expiresAt, documentId]
      );
      await db.commit(conn);
    } catch (err) {
      try {
        await db.rollback(conn);
      } catch {
        /* already released */
      }
      throw err;
    }

    logger.info({ documentId, userId }, 'Document sent for self-sign (no invitation email)');
    return { documentId, status: 'SENT', token };
  },

  /** Re-sends the invitation for one recipient. Used by reminders and by hand. */
  async resend(documentId: string, recipientId: string, userId: string, senderName: string) {
    const doc = await db.select('tbl_sign_document', '*', 'id = ?', [documentId]);
    if (!doc || doc.ownerId !== userId) throw new AppError('Document not found', 404);
    if (doc.status !== 'SENT') throw new AppError('This document is not awaiting signature.', 409);

    const recipient = await db.select(
      'tbl_sign_recipient',
      '*',
      'id = ? AND documentId = ?',
      [recipientId, documentId]
    );
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
 * Per-recipient delivery failures are collected (not thrown mid-loop) so a
 * parallel send can still reach some inboxes. The caller decides whether a
 * total failure should roll the document back to DRAFT.
 */
async function deliverInvitations(
  recipients: any[],
  tokens: Map<string, string>,
  doc: any,
  senderName: string,
  expiresAt: Date | null
): Promise<SendResult['notified']> {
  const results = await Promise.all(
    recipients.map(async (r) => {
      const token = tokens.get(r.id);
      if (!token) return null;

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
        const info = await sendMail({ ...mail, to: r.email });
        await db.update('tbl_sign_recipient', { status: 'SENT' }, 'id = ?', [r.id]);
        logger.info(
          {
            recipientId: r.id,
            documentId: doc.id,
            to: r.email,
            messageId: info.messageId,
            accepted: info.accepted,
            rejected: info.rejected,
          },
          'Signing invitation sent'
        );
        if (info.rejected.length > 0 && info.accepted.length === 0) {
          return {
            recipientId: r.id,
            email: r.email,
            delivered: false,
            error: `Rejected by mail server: ${info.rejected.join(', ')}`,
          };
        }
        return { recipientId: r.id, email: r.email, delivered: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Delivery failed';
        logger.error(
          { err, recipientId: r.id, documentId: doc.id, to: r.email },
          'Failed to send signing invitation'
        );
        return { recipientId: r.id, email: r.email, delivered: false, error: message };
      }
    })
  );

  return results.filter((res): res is NonNullable<typeof res> => res !== null);
}

/**
 * Rolls back a send when every actionable invitation failed to leave the
 * server. Refunds the monthly signing credit reserved in the send transaction.
 */
async function revertFailedSend(documentId: string, userId: string): Promise<void> {
  const conn = await db.beginTransaction();
  try {
    await conn.query(
      `UPDATE tbl_sign_document
          SET status = 'DRAFT', sentAt = NULL, expiresAt = NULL
        WHERE id = ? AND status = 'SENT'`,
      [documentId]
    );
    await conn.query(
      `UPDATE tbl_sign_recipient
          SET signingToken = NULL, tokenExpiresAt = NULL, status = 'PENDING'
        WHERE documentId = ?`,
      [documentId]
    );
    await conn.query(
      `UPDATE tbl_user
          SET monthlySignsUsed = GREATEST(0, monthlySignsUsed - 1)
        WHERE id = ?`,
      [userId]
    );
    await db.commit(conn);
    logger.warn({ documentId, userId }, 'Reverted send after all invitation emails failed');
  } catch (err) {
    try {
      await db.rollback(conn);
    } catch {
      /* already released */
    }
    logger.error({ err, documentId }, 'Failed to revert send after email delivery failure');
  }
}
