import type { Request } from 'express';
import { getPool } from '../../lib/mysql';
import { logger } from '../../lib/logger';
import { getSignedViewUrl } from '../../lib/s3';
import { AppError } from '../../middleware/errorHandler.middleware';
import { getRequestContext } from '../../lib/userAgent';
import { signSigningSession } from '../../lib/signingSession';
import { isMailerConfigured, sendMail } from '../../lib/mailer';
import { invitationEmail } from './email.templates';
import { env } from '../../config/env';
import { auditService } from './audit.service';
import { otpService } from './otp.service';
import { finalizeService } from './finalize.service';
import { AUTO_FILLED_FIELD_TYPES, type SignFieldType } from '../../../../shared/signing';

const ACTIONABLE_ROLES = new Set(['SIGNER', 'APPROVER']);

/** Field types that carry a drawn/uploaded image rather than text. */
const IMAGE_FIELDS = new Set<SignFieldType>(['SIGNATURE', 'INITIALS', 'STAMP', 'IMAGE']);

/**
 * A signature PNG is a data URL, not a caption. 2MB of base64 is a generous
 * signature and a firm ceiling — without one, this endpoint accepts arbitrary
 * megabytes into a TEXT column from an unauthenticated caller.
 */
const MAX_IMAGE_VALUE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_VALUE_LENGTH = 5000;

interface ResolvedToken {
  recipient: any;
  document: any;
}

/**
 * Resolves a signing token to its recipient and document.
 *
 * Every public route funnels through this. Failures are deliberately uniform
 * and vague: this endpoint is unauthenticated and internet-facing, so
 * distinguishing "no such token" from "expired token" from "already signed"
 * would turn it into an oracle for probing which tokens exist.
 */
async function resolveToken(token: string): Promise<ResolvedToken> {
  const pool = getPool();

  // Looked up by unique index rather than compared in JS — the database does a
  // single indexed match, so there is no per-byte timing signal to exploit.
  const [rows]: any = await pool.query('SELECT * FROM tbl_sign_recipient WHERE signingToken = ?', [token]);
  const recipient = rows[0];
  if (!recipient) {
    throw new AppError('This signing link is invalid or has expired.', 404);
  }

  const [docs]: any = await pool.query('SELECT * FROM tbl_sign_document WHERE id = ?', [recipient.documentId]);
  const document = docs[0];
  if (!document) {
    throw new AppError('This signing link is invalid or has expired.', 404);
  }

  if (recipient.tokenExpiresAt && new Date(recipient.tokenExpiresAt).getTime() < Date.now()) {
    throw new AppError('This signing link has expired. Ask the sender for a new one.', 410);
  }
  if (document.status === 'VOIDED') {
    throw new AppError('This document has been cancelled by the sender.', 410);
  }
  if (document.status === 'EXPIRED') {
    throw new AppError('This document has expired.', 410);
  }

  return { recipient, document };
}

/**
 * In a sequential flow, a signer may only act once everyone ahead of them is
 * done. Without this the ordering would be a suggestion — anyone holding a link
 * could sign out of turn, which defeats the point of asking for an order.
 */
async function assertTurn(document: any, recipient: any): Promise<void> {
  if (document.flowType !== 'SEQUENTIAL') return;
  if (!ACTIONABLE_ROLES.has(recipient.role)) return;

  const [rows]: any = await getPool().query(
    `SELECT COUNT(1) AS ahead
       FROM tbl_sign_recipient
      WHERE documentId = ?
        AND role IN ('SIGNER', 'APPROVER')
        AND signingOrder < ?
        AND status <> 'COMPLETED'`,
    [document.id, recipient.signingOrder]
  );
  if (rows[0].ahead > 0) {
    throw new AppError(
      'It is not your turn to sign yet. You will be emailed as soon as the people ahead of you have signed.',
      409
    );
  }
}

export const publicSigningService = {
  /**
   * Opens a document for a signer.
   *
   * Returns only what this signer needs: their own fields to fill, plus other
   * signers' already-filled values so the page renders as it truly stands. It
   * deliberately does NOT return other recipients' email addresses — the signer
   * has no need for them, and a signing link would otherwise leak the full
   * distribution list of an agreement to anyone it was forwarded to.
   */
  async getSigningView(token: string, req: Request) {
    const { recipient, document } = await resolveToken(token);

    const pool = getPool();
    const [fields]: any = await pool.query(
      'SELECT * FROM tbl_sign_field WHERE documentId = ? ORDER BY page ASC, y ASC, x ASC',
      [document.id]
    );
    const [allRecipients]: any = await pool.query(
      'SELECT id, name, role, color, signingOrder, status FROM tbl_sign_recipient WHERE documentId = ? ORDER BY signingOrder ASC',
      [document.id]
    );

    // First open flips PENDING/SENT → VIEWED and stamps viewedAt. Guarded so a
    // refresh doesn't overwrite the original timestamp — "when did they first
    // see it" is exactly the question the audit trail exists to answer.
    if (!recipient.viewedAt) {
      const ctx = getRequestContext(req);
      await pool.query(
        "UPDATE tbl_sign_recipient SET status = 'VIEWED', viewedAt = ? WHERE id = ? AND viewedAt IS NULL",
        [new Date(), recipient.id]
      );
      await auditService.record(req, {
        documentId: document.id,
        recipientId: recipient.id,
        actorEmail: recipient.email,
        actorName: recipient.name,
        action: 'DOCUMENT_OPENED',
        detail: `${recipient.name} opened the document`,
        metadata: { browser: ctx.browser, os: ctx.os },
      });
    }

    const requiresOtp = recipient.authMethod === 'EMAIL_OTP' || recipient.authMethod === 'SMS_OTP';
    const isVerified = !requiresOtp || Boolean(recipient.otpVerifiedAt);

    // The file URL is withheld until the challenge is passed. Handing it over
    // first would make the OTP decorative — the document would already be
    // readable by anyone holding the link.
    const fileUrl = isVerified ? await getSignedViewUrl(document.fileKey, 3600) : null;

    return {
      document: {
        id: document.id,
        title: document.title,
        message: document.message,
        status: document.status,
        pageCount: document.pageCount,
        flowType: document.flowType,
        expiresAt: document.expiresAt,
      },
      recipient: {
        id: recipient.id,
        name: recipient.name,
        email: recipient.email, // their own address — used to show "signing as …"
        role: recipient.role,
        color: recipient.color,
        status: recipient.status,
        authMethod: recipient.authMethod,
        completedAt: recipient.completedAt,
      },
      // Names only. No emails, no tokens.
      participants: allRecipients.map((r: any) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        color: r.color,
        signingOrder: r.signingOrder,
        status: r.status,
      })),
      fields: fields.map((f: any) => ({
        id: f.id,
        recipientId: f.recipientId,
        type: f.type,
        label: f.label,
        page: f.page,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        required: Boolean(f.required),
        config: typeof f.config === 'string' ? JSON.parse(f.config || '{}') : (f.config ?? {}),
        // Values are visible so a signer can see what previous parties entered,
        // but only their own fields are editable (enforced on submit, not here).
        value: f.value,
        isMine: f.recipientId === recipient.id,
      })),
      requiresOtp,
      isVerified,
      fileUrl,
    };
  },

  /** Issues an identity-verification code. */
  async requestOtp(token: string, req: Request) {
    const { recipient, document } = await resolveToken(token);

    if (recipient.status === 'COMPLETED') {
      throw new AppError('You have already signed this document.', 409);
    }
    if (recipient.authMethod === 'NONE') {
      throw new AppError('This document does not require a verification code.', 400);
    }

    const result = await otpService.issue(recipient, document.title);

    await auditService.record(req, {
      documentId: document.id,
      recipientId: recipient.id,
      actorEmail: recipient.email,
      actorName: recipient.name,
      action: 'AUTH_CHALLENGED',
      detail: `Verification code sent to ${result.sentTo}`,
    });

    return result;
  },

  /** Verifies a code and returns a short-lived signing session. */
  async verifyOtp(token: string, code: string, req: Request) {
    const { recipient, document } = await resolveToken(token);

    try {
      await otpService.verify(recipient.id, code);
    } catch (err) {
      await auditService.record(req, {
        documentId: document.id,
        recipientId: recipient.id,
        actorEmail: recipient.email,
        actorName: recipient.name,
        action: 'AUTH_FAILED',
        detail: err instanceof AppError ? err.message : 'Verification failed',
      });
      throw err;
    }

    await auditService.record(req, {
      documentId: document.id,
      recipientId: recipient.id,
      actorEmail: recipient.email,
      actorName: recipient.name,
      action: 'AUTH_PASSED',
      detail: `${recipient.name} passed identity verification`,
    });

    return {
      sessionToken: signSigningSession({ recipientId: recipient.id, documentId: document.id }),
      fileUrl: await getSignedViewUrl(document.fileKey, 3600),
    };
  },

  /**
   * Submits a signer's field values and completes their part.
   *
   * `session` is the decoded signing session, or null when the recipient's
   * authMethod is NONE. Where verification IS required the session must match
   * this recipient — otherwise passing OTP on one link would authorise
   * submitting on another.
   */
  async complete(
    token: string,
    values: Record<string, string>,
    session: { recipientId: string } | null,
    req: Request
  ) {
    const { recipient, document } = await resolveToken(token);

    if (recipient.status === 'COMPLETED') {
      throw new AppError('You have already signed this document.', 409);
    }
    if (recipient.status === 'DECLINED') {
      throw new AppError('You have declined this document.', 409);
    }
    if (!ACTIONABLE_ROLES.has(recipient.role)) {
      throw new AppError('You were sent this document for information only.', 403);
    }
    if (document.status !== 'SENT') {
      throw new AppError('This document is no longer accepting signatures.', 409);
    }

    const requiresOtp = recipient.authMethod === 'EMAIL_OTP' || recipient.authMethod === 'SMS_OTP';
    if (requiresOtp) {
      if (!session || session.recipientId !== recipient.id) {
        throw new AppError('Please verify your identity before signing.', 401);
      }
      if (!recipient.otpVerifiedAt) {
        throw new AppError('Please verify your identity before signing.', 401);
      }
    }

    await assertTurn(document, recipient);

    const pool = getPool();
    const [fields]: any = await pool.query(
      'SELECT * FROM tbl_sign_field WHERE documentId = ? AND recipientId = ?',
      [document.id, recipient.id]
    );

    // Only this recipient's own fields are writable. The payload is a map keyed
    // by field id from an unauthenticated caller, so anything not in this set is
    // ignored outright — otherwise a signer could overwrite another party's
    // signature, or fill fields on a document they were merely CC'd on.
    const ownFieldIds = new Set(fields.map((f: any) => f.id));
    const foreign = Object.keys(values).filter((id) => !ownFieldIds.has(id));
    if (foreign.length > 0) {
      throw new AppError('That submission contains fields that are not yours to fill.', 403);
    }

    const now = new Date();
    const ctx = getRequestContext(req);
    const resolved: { id: string; value: string | null }[] = [];

    for (const field of fields) {
      const config = typeof field.config === 'string' ? JSON.parse(field.config || '{}') : (field.config ?? {});
      let value = values[field.id];

      // Recipient-derived fields are filled from the record we already hold
      // rather than trusted from the payload — a signer must not be able to
      // stamp someone else's name or a false date onto a legal document.
      if (AUTO_FILLED_FIELD_TYPES.includes(field.type)) {
        if (field.type === 'NAME') value = recipient.name;
        else if (field.type === 'EMAIL') value = recipient.email;
        else if (field.type === 'DATE') value = formatDate(now, config.dateFormat);
        // COMPANY has no authoritative source, so it stays signer-supplied.
      }

      if (value === undefined || value === null || value === '') {
        if (field.required) {
          throw new AppError(`"${field.label || field.type}" is required.`, 400);
        }
        resolved.push({ id: field.id, value: null });
        continue;
      }

      validateValue(field, config, value);
      resolved.push({ id: field.id, value });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const { id, value } of resolved) {
        await conn.query('UPDATE tbl_sign_field SET value = ?, filledAt = ? WHERE id = ?', [
          value,
          value === null ? null : now,
          id,
        ]);
      }

      await conn.query(
        `UPDATE tbl_sign_recipient
            SET status = 'COMPLETED', completedAt = ?, ipAddress = ?, deviceInfo = ?
          WHERE id = ?`,
        [now, ctx.ipAddress, [ctx.browser, ctx.os, ctx.device].filter(Boolean).join(' · ') || null, recipient.id]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    await auditService.record(req, {
      documentId: document.id,
      recipientId: recipient.id,
      actorEmail: recipient.email,
      actorName: recipient.name,
      action: 'RECIPIENT_COMPLETED',
      detail: `${recipient.name} signed the document`,
      metadata: { fieldsFilled: resolved.filter((r) => r.value !== null).length },
    });

    // Burn the token. The signer is done, and leaving a live bearer credential
    // to a signed agreement in an inbox serves no one.
    await pool.query(
      'UPDATE tbl_sign_recipient SET signingToken = NULL, tokenExpiresAt = NULL WHERE id = ?',
      [recipient.id]
    );

    const allDone = await finalizeService.allSignersComplete(document.id);
    if (allDone) {
      // A finalization failure must not tell the signer their signature didn't
      // land — it did, and it's committed. The document simply stays SENT and
      // can be re-finalized.
      try {
        await finalizeService.finalize(document.id);
      } catch (err) {
        logger.error({ err, documentId: document.id }, 'Finalization failed after last signature');
      }
    } else if (document.flowType === 'SEQUENTIAL') {
      await notifyNextSigner(document, req).catch((err) =>
        logger.error({ err, documentId: document.id }, 'Failed to notify the next signer')
      );
    }

    return { status: 'COMPLETED', documentCompleted: allDone };
  },

  /** Records a refusal to sign. Terminal for the whole document. */
  async decline(token: string, reason: string | undefined, req: Request) {
    const { recipient, document } = await resolveToken(token);

    if (recipient.status === 'COMPLETED') {
      throw new AppError('You have already signed this document.', 409);
    }
    if (document.status !== 'SENT') {
      throw new AppError('This document is no longer active.', 409);
    }

    const pool = getPool();
    await pool.query(
      "UPDATE tbl_sign_recipient SET status = 'DECLINED', declineReason = ?, signingToken = NULL WHERE id = ?",
      [reason ?? null, recipient.id]
    );
    // One refusal ends the agreement — there is no partial contract to pursue,
    // and the remaining signers should not be asked to sign something already dead.
    await pool.query("UPDATE tbl_sign_document SET status = 'DECLINED' WHERE id = ?", [document.id]);

    await auditService.record(req, {
      documentId: document.id,
      recipientId: recipient.id,
      actorEmail: recipient.email,
      actorName: recipient.name,
      action: 'RECIPIENT_DECLINED',
      detail: reason ? `${recipient.name} declined: ${reason}` : `${recipient.name} declined to sign`,
    });

    return { status: 'DECLINED' };
  },
};

/** Emails the next signer in a sequential flow. */
async function notifyNextSigner(document: any, req: Request): Promise<void> {
  if (!isMailerConfigured()) return;

  const pool = getPool();
  const [rows]: any = await pool.query(
    `SELECT * FROM tbl_sign_recipient
      WHERE documentId = ? AND role IN ('SIGNER','APPROVER') AND status NOT IN ('COMPLETED','DECLINED')
      ORDER BY signingOrder ASC LIMIT 1`,
    [document.id]
  );
  const next = rows[0];
  if (!next?.signingToken) return;

  const [owners]: any = await pool.query('SELECT name FROM tbl_user WHERE id = ?', [document.ownerId]);
  const senderName = owners[0]?.name || 'A sender';

  const mail = invitationEmail({
    signerName: next.name,
    senderName,
    documentTitle: document.title,
    // `/s/` — see the note in send.service.ts. Must stay in step with it.
    signUrl: `${env.APP_URL.replace(/\/$/, '')}/s/${next.signingToken}`,
    message: document.message,
    expiresAt: next.tokenExpiresAt ? new Date(next.tokenExpiresAt) : null,
  });

  await sendMail({ ...mail, to: next.email });
  await pool.query("UPDATE tbl_sign_recipient SET status = 'SENT' WHERE id = ?", [next.id]);

  await auditService.record(req, {
    documentId: document.id,
    recipientId: next.id,
    actorEmail: next.email,
    actorName: next.name,
    action: 'EMAIL_SENT',
    detail: `Signing invitation sent to ${next.name} (next in order)`,
  });
}

/**
 * Re-validates a submitted value server-side.
 *
 * The designer's rules are enforced in the signing UI too, but that UI is
 * reachable by anyone with a link and its checks are advisory. This is the
 * boundary.
 */
function validateValue(field: any, config: any, value: string): void {
  const label = field.label || field.type;

  if (IMAGE_FIELDS.has(field.type as SignFieldType)) {
    if (!/^data:image\/(png|jpeg);base64,/.test(value)) {
      throw new AppError(`"${label}" must be an image.`, 400);
    }
    // base64 encodes 3 bytes per 4 chars.
    if ((value.length * 3) / 4 > MAX_IMAGE_VALUE_BYTES) {
      throw new AppError(`"${label}" is too large.`, 400);
    }
    return;
  }

  if (value.length > MAX_TEXT_VALUE_LENGTH) {
    throw new AppError(`"${label}" is too long.`, 400);
  }

  if (field.type === 'CHECKBOX' || field.type === 'RADIO') {
    if (value !== 'true' && value !== 'false') {
      throw new AppError(`"${label}" has an invalid value.`, 400);
    }
    return;
  }

  if (field.type === 'NUMBER') {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new AppError(`"${label}" must be a number.`, 400);
    if (config.validation?.min !== undefined && num < config.validation.min) {
      throw new AppError(`"${label}" must be at least ${config.validation.min}.`, 400);
    }
    if (config.validation?.max !== undefined && num > config.validation.max) {
      throw new AppError(`"${label}" must be at most ${config.validation.max}.`, 400);
    }
    return;
  }

  if (field.type === 'DROPDOWN' && Array.isArray(config.options) && config.options.length > 0) {
    if (!config.options.includes(value)) {
      throw new AppError(`"${label}" must be one of the available options.`, 400);
    }
    return;
  }

  const v = config.validation ?? {};
  if (v.minLength !== undefined && value.length < v.minLength) {
    throw new AppError(`"${label}" must be at least ${v.minLength} characters.`, 400);
  }
  if (v.maxLength !== undefined && value.length > v.maxLength) {
    throw new AppError(`"${label}" must be at most ${v.maxLength} characters.`, 400);
  }
  if (v.pattern) {
    const preset: Record<string, RegExp> = {
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      phone: /^\+?[\d\s-]{7,20}$/,
    };
    // A raw pattern comes from the document owner, not the signer, so this is
    // not user-controlled regex from the attacker's side. Still guarded: a
    // malformed pattern must not 500 the signing request.
    let re = preset[v.pattern];
    if (!re) {
      try {
        re = new RegExp(v.pattern);
      } catch {
        return;
      }
    }
    if (!re.test(value)) {
      throw new AppError(`"${label}" is not in the expected format.`, 400);
    }
  }
}

/** Timezone the on-document date/time is expressed in. */
const DISPLAY_TZ = 'Asia/Kolkata';
const TZ_LABEL = 'IST';

/**
 * Formats the signing moment for a DATE field stamped onto the document.
 *
 * ── Timezone is computed explicitly, not read from the server clock ─────────
 * The old implementation used date.getDate()/getHours(), which return values in
 * the SERVER's local timezone. The production box runs in UTC, so a signature
 * applied at 14:46 IST would have stamped "09:16" — an incorrect time on a legal
 * document. Intl with an explicit timeZone gives the true IST wall-clock time
 * regardless of where the server runs.
 */
function formatDate(date: Date, format?: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: DISPLAY_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  ) as Record<string, string>;

  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const monthName = months[Number(p.month) - 1];
  const dNoPad = String(Number(p.day));

  switch (format) {
    case 'MM/DD/YYYY':
      return `${p.month}/${p.day}/${p.year}`;
    case 'YYYY-MM-DD':
      return `${p.year}-${p.month}-${p.day}`;
    case 'D MMMM YYYY':
      return `${dNoPad} ${monthName} ${p.year}`;
    // Date + time in IST — the formats offered when the sender wants the moment,
    // not just the day, stamped on the page.
    case 'DD/MM/YYYY HH:mm':
      return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} ${TZ_LABEL}`;
    case 'D MMMM YYYY, h:mm A':
      return `${dNoPad} ${monthName} ${p.year}, ${to12h(p.hour, p.minute)} ${TZ_LABEL}`;
    default:
      return `${p.day}/${p.month}/${p.year}`;
  }
}

/** 24h "14:46" → "2:46 PM", for the friendly date-time format. */
function to12h(hour: string, minute: string): string {
  const h = Number(hour);
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${minute} ${period}`;
}
