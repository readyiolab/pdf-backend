import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  s3,
  getSignedDownloadUrl,
  getSignedViewUrl,
  hashObject,
  headObjectSize,
  readObjectHead,
  deleteObject,
  deleteObjects,
} from '../../lib/s3';
import { getPool } from '../../lib/mysql';
import { env } from '../../config/env';
import { AppError } from '../../middleware/errorHandler.middleware';
import { detectFileCategory } from '../../../../shared/fileType';
import {
  RECIPIENT_COLORS,
  SIGNING_LIMITS,
  type SignDocumentDTO,
  type SignFieldDTO,
  type SignRecipientDTO,
} from '../../../../shared/signing';
import type {
  AddRecipientInput,
  CreateDocumentInput,
  ListDocumentsInput,
  PresignDocumentInput,
  SaveFieldsInput,
  UpdateDocumentInput,
  UpdateRecipientInput,
} from './signing.types';

/**
 * Signing objects live under their own prefix, distinct from
 * `pdf-saas-uploads/` and `pdf-saas-results/`. This is not cosmetic: the
 * cleanup sweep only ever deletes keys recorded on `tbl_job` rows, so nothing
 * under this prefix can be caught by it. Signed agreements are deleted only by
 * an explicit owner action.
 */
const SIGNING_PREFIX = 'pdf-saas-signing';

function documentKey(userId: string, documentId: string, fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${SIGNING_PREFIX}/user-${userId}/doc-${documentId}/original_${sanitized}`;
}

/** Strips secrets that must never leave the server, whatever the caller asks for. */
function toRecipientDTO(row: any): SignRecipientDTO {
  return {
    id: row.id,
    documentId: row.documentId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    color: row.color,
    signingOrder: row.signingOrder,
    authMethod: row.authMethod,
    status: row.status,
    otpVerifiedAt: row.otpVerifiedAt,
    ipAddress: row.ipAddress,
    deviceInfo: row.deviceInfo,
    viewedAt: row.viewedAt,
    completedAt: row.completedAt,
    declineReason: row.declineReason,
    // accessCodeHash, otpHash and signingToken are deliberately omitted — the
    // token is the bearer credential for the signing link and must only ever be
    // delivered to the recipient directly, never handed back through the
    // owner's API where it could leak via logs, devtools, or a shared screen.
    // Returning otpHash would likewise hand an attacker an offline target.
  };
}

function toFieldDTO(row: any): SignFieldDTO {
  return {
    id: row.id,
    documentId: row.documentId,
    recipientId: row.recipientId,
    type: row.type,
    label: row.label,
    page: row.page,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    required: Boolean(row.required),
    locked: Boolean(row.locked),
    config: typeof row.config === 'string' ? JSON.parse(row.config || '{}') : (row.config ?? {}),
    value: row.value,
    filledAt: row.filledAt,
  };
}

/**
 * Loads a document and asserts the caller owns it.
 *
 * Every route funnels through this rather than trusting the id in the URL —
 * document ids are UUIDs but they are not secrets, and an authenticated user
 * must not be able to read or mutate someone else's agreement by guessing or
 * replaying one. Returns 404 (not 403) on an ownership miss so the endpoint
 * doesn't confirm that a document with that id exists at all.
 */
async function loadOwnedDocument(documentId: string, userId: string): Promise<any> {
  const [rows]: any = await getPool().query(
    'SELECT * FROM tbl_sign_document WHERE id = ?',
    [documentId]
  );
  const doc = rows[0];
  if (!doc || doc.ownerId !== userId) {
    throw new AppError('Document not found', 404);
  }
  return doc;
}

/**
 * Structural changes (recipients, field placement) are only legal while the
 * document is still a draft. Once it is out for signature, moving a field or
 * swapping a recipient would silently change the agreement under someone who
 * may have already signed it.
 */
function assertDraft(doc: any, action: string): void {
  if (doc.status !== 'DRAFT') {
    throw new AppError(
      `Cannot ${action} once a document has been sent. Void it and create a new version instead.`,
      409
    );
  }
}

export const signingService = {
  /**
   * Issues a presigned PUT for a signing upload. Mirrors uploadService but with
   * the signing prefix and SIGNING_LIMITS.maxFileSize (agreements are bigger and
   * are not bound by the per-plan tool-input limit).
   *
   * fileSize here is client-declared and therefore untrusted — it's an early
   * reject to save a doomed upload. The real enforcement happens in
   * createDocument, which HEADs the stored object.
   */
  async presignUpload(userId: string, input: PresignDocumentInput) {
    const { fileName, contentType, fileSize } = input;

    if (contentType !== 'application/pdf') {
      throw new AppError('Only PDF files can be sent for signature.', 400);
    }
    if (fileSize > SIGNING_LIMITS.maxFileSize) {
      const maxMb = Math.floor(SIGNING_LIMITS.maxFileSize / (1024 * 1024));
      throw new AppError(`File size exceeds the ${maxMb}MB limit for signing documents.`, 400);
    }

    // The document id is minted here so the object lands in its final
    // doc-scoped folder, rather than being moved after the row is created.
    const documentId = crypto.randomUUID();
    const fileKey = documentKey(userId, documentId, fileName);

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: env.DO_SPACES_BUCKET,
        Key: fileKey,
        ContentType: contentType,
      }),
      { expiresIn: env.PRESIGN_TTL_SECONDS }
    );

    return { documentId, uploadUrl, fileKey };
  },

  /**
   * Registers an uploaded PDF as a signing document.
   *
   * Validates the REAL bytes (size + magic number) rather than what the client
   * claimed at presign time — a presigned PUT can't enforce either, so this is
   * the first point where the actual object can be trusted.
   */
  async createDocument(userId: string, input: CreateDocumentInput): Promise<SignDocumentDTO> {
    const { fileKey, fileName, title, pageCount } = input;

    // Confine the caller to their own signing namespace. Without this an
    // authenticated user could pass any key in the bucket — including another
    // tenant's document or a results object — and have us mint a document that
    // hands back signed URLs to it.
    if (!fileKey.startsWith(`${SIGNING_PREFIX}/user-${userId}/`)) {
      throw new AppError('Invalid file key for this account.', 400);
    }

    let size: number;
    try {
      size = await headObjectSize(fileKey);
    } catch {
      throw new AppError('The uploaded file could not be found. Please re-upload.', 400);
    }

    if (size <= 0) {
      await deleteObject(fileKey);
      throw new AppError('The uploaded file is empty.', 400);
    }
    if (size > SIGNING_LIMITS.maxFileSize) {
      await deleteObject(fileKey);
      const maxMb = Math.floor(SIGNING_LIMITS.maxFileSize / (1024 * 1024));
      throw new AppError(`File size exceeds the ${maxMb}MB limit for signing documents.`, 400);
    }

    const head = await readObjectHead(fileKey, 1024);
    if (detectFileCategory(head) !== 'pdf') {
      await deleteObject(fileKey);
      throw new AppError('Only PDF files can be sent for signature.', 400);
    }

    // Hash the original BEFORE it is registered, let alone signed. This is the
    // baseline the completion certificate cites to prove the signed output
    // derives from the document the parties actually saw. Taking it later —
    // after any tool has touched the file — would prove nothing.
    const originalHash = await hashObject(fileKey);

    // Recover the id embedded in the key at presign time so the row and the
    // object folder agree.
    const documentId = fileKey.match(/\/doc-([0-9a-f-]{36})\//)?.[1] ?? crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SIGNING_LIMITS.defaultExpiryDays * 86400_000);
    const docTitle = (title || fileName.replace(/\.pdf$/i, '')).slice(0, SIGNING_LIMITS.maxTitleLength);

    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `INSERT INTO tbl_sign_document
           (id, ownerId, title, status, fileKey, fileName, fileSize, pageCount, currentVersion, originalHash, expiresAt)
         VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, 1, ?, ?)`,
        [documentId, userId, docTitle, fileKey, fileName, size, pageCount ?? 0, originalHash, expiresAt]
      );

      // v1 is the pristine original. Every later finalization appends a row;
      // this one is never mutated, which is what "preserve the original
      // document" means in practice.
      await conn.query(
        `INSERT INTO tbl_sign_document_version (id, documentId, version, fileKey, fileSize, sha256, label)
         VALUES (?, ?, 1, ?, ?, ?, 'Original')`,
        [crypto.randomUUID(), documentId, fileKey, size, originalHash]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    return this.getDocument(documentId, userId);
  },

  async listDocuments(userId: string, query: ListDocumentsInput) {
    const { status, search, page, limit } = query;
    const pool = getPool();
    const offset = (page - 1) * limit;

    const where: string[] = ['ownerId = ?'];
    const params: any[] = [userId];

    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (search) {
      where.push('(title LIKE ? OR fileName LIKE ?)');
      // Escape LIKE wildcards so a literal % or _ in the search box doesn't
      // silently match everything.
      const term = `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      params.push(term, term);
    }
    const whereSql = where.join(' AND ');

    const [rows]: any = await pool.query(
      `SELECT d.*,
              (SELECT COUNT(1) FROM tbl_sign_recipient r WHERE r.documentId = d.id) AS recipientCount,
              (SELECT COUNT(1) FROM tbl_sign_recipient r WHERE r.documentId = d.id AND r.status = 'COMPLETED') AS completedCount
         FROM tbl_sign_document d
        WHERE ${whereSql}
        ORDER BY d.updatedAt DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]]: any = await pool.query(
      `SELECT COUNT(1) AS total FROM tbl_sign_document WHERE ${whereSql}`,
      params
    );

    return {
      documents: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },

  /** Status tallies for the dashboard, in one round trip rather than six. */
  async getStats(userId: string) {
    const [rows]: any = await getPool().query(
      `SELECT status, COUNT(1) AS count
         FROM tbl_sign_document
        WHERE ownerId = ?
        GROUP BY status`,
      [userId]
    );

    const byStatus: Record<string, number> = {
      DRAFT: 0, SENT: 0, COMPLETED: 0, DECLINED: 0, EXPIRED: 0, VOIDED: 0,
    };
    for (const r of rows) byStatus[r.status] = Number(r.count);

    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    // Only documents that actually went out can complete; counting drafts in
    // the denominator would make the rate drop every time someone starts one.
    const finished = byStatus.SENT + byStatus.COMPLETED + byStatus.DECLINED + byStatus.EXPIRED;

    return {
      byStatus,
      total,
      completionRate: finished > 0 ? Math.round((byStatus.COMPLETED / finished) * 100) : 0,
    };
  },

  async getDocument(documentId: string, userId: string): Promise<SignDocumentDTO> {
    const doc = await loadOwnedDocument(documentId, userId);
    const pool = getPool();

    const [recipients]: any = await pool.query(
      'SELECT * FROM tbl_sign_recipient WHERE documentId = ? ORDER BY signingOrder ASC, createdAt ASC',
      [documentId]
    );
    const [fields]: any = await pool.query(
      'SELECT * FROM tbl_sign_field WHERE documentId = ? ORDER BY page ASC, y ASC, x ASC',
      [documentId]
    );

    return {
      ...doc,
      recipients: recipients.map(toRecipientDTO),
      fields: fields.map(toFieldDTO),
    };
  },

  /** Short-lived signed URL the viewer uses to fetch the PDF bytes. */
  async getViewUrl(documentId: string, userId: string, version?: number) {
    const doc = await loadOwnedDocument(documentId, userId);

    let key = doc.fileKey;
    if (version) {
      const [rows]: any = await getPool().query(
        'SELECT fileKey FROM tbl_sign_document_version WHERE documentId = ? AND version = ?',
        [documentId, version]
      );
      if (!rows[0]) throw new AppError('Document version not found', 404);
      key = rows[0].fileKey;
    }

    // Longer than DOWNLOAD_URL_TTL: a viewer session outlives a click-to-save,
    // and pdf.js re-requests byte ranges for the life of the open document.
    return { url: await getSignedViewUrl(key, 3600) };
  },

  async updateDocument(documentId: string, userId: string, input: UpdateDocumentInput) {
    const doc = await loadOwnedDocument(documentId, userId);

    // Title/message are cosmetic and safe to edit while in flight; flow type
    // and expiry change the agreement's mechanics and are draft-only.
    if ((input.flowType || input.expiresAt !== undefined) && doc.status !== 'DRAFT') {
      throw new AppError('Flow type and expiry can only be changed while the document is a draft.', 409);
    }

    const sets: string[] = [];
    const params: any[] = [];
    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title); }
    if (input.message !== undefined) { sets.push('message = ?'); params.push(input.message); }
    if (input.flowType !== undefined) { sets.push('flowType = ?'); params.push(input.flowType); }
    if (input.expiresAt !== undefined) {
      sets.push('expiresAt = ?');
      params.push(input.expiresAt ? new Date(input.expiresAt) : null);
    }

    await getPool().query(
      `UPDATE tbl_sign_document SET ${sets.join(', ')} WHERE id = ?`,
      [...params, documentId]
    );

    return this.getDocument(documentId, userId);
  },

  /**
   * Permanently removes a document, its rows (via ON DELETE CASCADE) and every
   * stored version from S3.
   *
   * Refuses on COMPLETED documents: a fully executed agreement is a record the
   * parties are entitled to, and a one-click delete of it is a footgun, not a
   * feature. Void it first if it genuinely needs to go.
   */
  async deleteDocument(documentId: string, userId: string) {
    const doc = await loadOwnedDocument(documentId, userId);
    if (doc.status === 'COMPLETED') {
      throw new AppError('A completed agreement cannot be deleted.', 409);
    }

    const pool = getPool();
    const [versions]: any = await pool.query(
      'SELECT fileKey FROM tbl_sign_document_version WHERE documentId = ?',
      [documentId]
    );

    // Delete the DB rows first. If S3 deletion fails afterwards we leak
    // objects (recoverable, and reported by monitoring); if we deleted S3
    // first and the DB delete failed, the document would still be listed but
    // its bytes would be gone — a far worse state to be in.
    await pool.query('DELETE FROM tbl_sign_document WHERE id = ?', [documentId]);
    await deleteObjects([doc.fileKey, ...versions.map((v: any) => v.fileKey)]);

    return { id: documentId, deleted: true };
  },

  async addRecipient(documentId: string, userId: string, input: AddRecipientInput): Promise<SignRecipientDTO> {
    const doc = await loadOwnedDocument(documentId, userId);
    assertDraft(doc, 'add recipients');

    const pool = getPool();
    const [existing]: any = await pool.query(
      'SELECT id, email, signingOrder FROM tbl_sign_recipient WHERE documentId = ?',
      [documentId]
    );

    if (existing.length >= SIGNING_LIMITS.maxRecipientsPerDocument) {
      throw new AppError(
        `A document cannot have more than ${SIGNING_LIMITS.maxRecipientsPerDocument} recipients.`,
        400
      );
    }

    const email = input.email.toLowerCase().trim();
    if (existing.some((r: any) => r.email === email)) {
      throw new AppError('This recipient has already been added to the document.', 409);
    }

    const recipientId = crypto.randomUUID();
    // Round-robin the palette so each recipient is visually distinct in the
    // designer without the owner having to pick a colour.
    const color = input.color ?? RECIPIENT_COLORS[existing.length % RECIPIENT_COLORS.length];
    const signingOrder =
      input.signingOrder ?? Math.max(0, ...existing.map((r: any) => r.signingOrder)) + 1;
    const accessCodeHash = input.accessCode
      ? await bcrypt.hash(input.accessCode, env.BCRYPT_ROUNDS)
      : null;

    await pool.query(
      `INSERT INTO tbl_sign_recipient
         (id, documentId, name, email, phone, role, color, signingOrder, authMethod, accessCodeHash, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        recipientId,
        documentId,
        input.name.trim(),
        email,
        input.phone ?? null,
        input.role,
        color,
        signingOrder,
        input.authMethod,
        accessCodeHash,
      ]
    );

    const [rows]: any = await pool.query('SELECT * FROM tbl_sign_recipient WHERE id = ?', [recipientId]);
    return toRecipientDTO(rows[0]);
  },

  async updateRecipient(
    documentId: string,
    recipientId: string,
    userId: string,
    input: UpdateRecipientInput
  ): Promise<SignRecipientDTO> {
    const doc = await loadOwnedDocument(documentId, userId);
    assertDraft(doc, 'edit recipients');

    const pool = getPool();
    const [rows]: any = await pool.query(
      'SELECT id, phone, authMethod FROM tbl_sign_recipient WHERE id = ? AND documentId = ?',
      [recipientId, documentId]
    );
    const existing = rows[0];
    if (!existing) throw new AppError('Recipient not found', 404);

    // Zod validates the PATCH body in isolation and can't see the stored row, so
    // "switch this signer to SMS_OTP" (with the number already on file) and
    // "clear the phone" (while SMS_OTP is already set) both slip past it. Both
    // produce a signer who can never authenticate.
    const nextAuthMethod = input.authMethod ?? existing.authMethod;
    const nextPhone = input.phone !== undefined ? input.phone : existing.phone;
    if (nextAuthMethod === 'SMS_OTP' && !nextPhone) {
      throw new AppError('A phone number is required when authMethod is SMS_OTP', 400);
    }

    const sets: string[] = [];
    const params: any[] = [];
    if (input.name !== undefined) { sets.push('name = ?'); params.push(input.name.trim()); }
    if (input.email !== undefined) {
      const email = input.email.toLowerCase().trim();
      const [dupes]: any = await pool.query(
        'SELECT id FROM tbl_sign_recipient WHERE documentId = ? AND email = ? AND id <> ?',
        [documentId, email, recipientId]
      );
      if (dupes.length) throw new AppError('Another recipient already uses this email.', 409);
      sets.push('email = ?');
      params.push(email);
    }
    if (input.phone !== undefined) { sets.push('phone = ?'); params.push(input.phone || null); }
    if (input.role !== undefined) { sets.push('role = ?'); params.push(input.role); }
    if (input.color !== undefined) { sets.push('color = ?'); params.push(input.color); }
    if (input.signingOrder !== undefined) { sets.push('signingOrder = ?'); params.push(input.signingOrder); }
    if (input.authMethod !== undefined) {
      sets.push('authMethod = ?');
      params.push(input.authMethod);
      // Dropping ACCESS_CODE auth must also drop the stored hash, or a later
      // re-enable would silently resurrect a code the owner thinks is gone.
      if (input.authMethod !== 'ACCESS_CODE' && input.accessCode === undefined) {
        sets.push('accessCodeHash = NULL');
      }
    }
    if (input.accessCode !== undefined) {
      sets.push('accessCodeHash = ?');
      params.push(await bcrypt.hash(input.accessCode, env.BCRYPT_ROUNDS));
    }

    await pool.query(
      `UPDATE tbl_sign_recipient SET ${sets.join(', ')} WHERE id = ?`,
      [...params, recipientId]
    );

    const [updated]: any = await pool.query('SELECT * FROM tbl_sign_recipient WHERE id = ?', [recipientId]);
    return toRecipientDTO(updated[0]);
  },

  async removeRecipient(documentId: string, recipientId: string, userId: string) {
    const doc = await loadOwnedDocument(documentId, userId);
    assertDraft(doc, 'remove recipients');

    const [result]: any = await getPool().query(
      'DELETE FROM tbl_sign_recipient WHERE id = ? AND documentId = ?',
      [recipientId, documentId]
    );
    if (result.affectedRows === 0) throw new AppError('Recipient not found', 404);

    // Their fields survive with recipientId = NULL (FK is ON DELETE SET NULL)
    // so the owner sees them orphaned in the designer and can reassign them,
    // rather than losing placement work to a mis-click.
    return { id: recipientId, deleted: true };
  },

  /**
   * Replaces the document's entire field set in one transaction.
   *
   * The designer is the source of truth for placement, so a wholesale replace
   * keeps deletes and reassignments consistent without per-field diffing. It is
   * idempotent: saving the same payload twice is a no-op.
   */
  async saveFields(documentId: string, userId: string, input: SaveFieldsInput): Promise<SignFieldDTO[]> {
    const doc = await loadOwnedDocument(documentId, userId);
    assertDraft(doc, 'change field placement');

    const pool = getPool();
    const [recipients]: any = await pool.query(
      'SELECT id FROM tbl_sign_recipient WHERE documentId = ?',
      [documentId]
    );
    const validRecipientIds = new Set(recipients.map((r: any) => r.id));

    for (const f of input.fields) {
      // A field assigned to a recipient of a DIFFERENT document would let the
      // designer wire an agreement to an unrelated signer.
      if (f.recipientId && !validRecipientIds.has(f.recipientId)) {
        throw new AppError(`Field "${f.label || f.type}" is assigned to a recipient who is not on this document.`, 400);
      }
      if (doc.pageCount > 0 && f.page > doc.pageCount) {
        throw new AppError(`Field "${f.label || f.type}" is placed on page ${f.page}, beyond the document's ${doc.pageCount} pages.`, 400);
      }
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query('DELETE FROM tbl_sign_field WHERE documentId = ?', [documentId]);

      if (input.fields.length > 0) {
        // One multi-row INSERT rather than N round trips — a 500-field save
        // would otherwise be 500 sequential queries inside the transaction.
        await conn.query(
          `INSERT INTO tbl_sign_field
             (id, documentId, recipientId, type, label, page, x, y, width, height, required, locked, config)
           VALUES ?`,
          [
            input.fields.map((f) => [
              f.id,
              documentId,
              f.recipientId ?? null,
              f.type,
              f.label ?? '',
              f.page,
              f.x,
              f.y,
              f.width,
              f.height,
              f.required ? 1 : 0,
              f.locked ? 1 : 0,
              JSON.stringify(f.config ?? {}),
            ]),
          ]
        );
      }

      // Touch the parent so the dashboard's "recently updated" ordering
      // reflects design work, not just document-level edits.
      await conn.query('UPDATE tbl_sign_document SET updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ?', [documentId]);

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const [rows]: any = await pool.query(
      'SELECT * FROM tbl_sign_field WHERE documentId = ? ORDER BY page ASC, y ASC, x ASC',
      [documentId]
    );
    return rows.map(toFieldDTO);
  },

  /**
   * Per-signer progress for the sender's tracker.
   *
   * Goes through the DTO mapper like everything else, so signing tokens can't
   * leak here either — this is the endpoint most likely to be polled from a
   * dashboard and logged along the way.
   */
  async getStatus(documentId: string, userId: string) {
    const doc = await loadOwnedDocument(documentId, userId);
    const pool = getPool();

    const [recipients]: any = await pool.query(
      'SELECT * FROM tbl_sign_recipient WHERE documentId = ? ORDER BY signingOrder ASC, createdAt ASC',
      [documentId]
    );
    const [[fieldStats]]: any = await pool.query(
      `SELECT COUNT(1) AS total, SUM(value IS NOT NULL) AS filled
         FROM tbl_sign_field WHERE documentId = ?`,
      [documentId]
    );
    const [versions]: any = await pool.query(
      `SELECT version, sha256, label, fileSize, digitallySigned, selfSignedCert, tsaTimestamp, createdAt
         FROM tbl_sign_document_version WHERE documentId = ? ORDER BY version ASC`,
      [documentId]
    );

    const actionable = recipients.filter((r: any) => r.role === 'SIGNER' || r.role === 'APPROVER');
    const completed = actionable.filter((r: any) => r.status === 'COMPLETED');

    return {
      id: doc.id,
      title: doc.title,
      status: doc.status,
      flowType: doc.flowType,
      sentAt: doc.sentAt,
      completedAt: doc.completedAt,
      expiresAt: doc.expiresAt,
      originalHash: doc.originalHash,
      currentVersion: doc.currentVersion,
      progress: {
        signed: completed.length,
        total: actionable.length,
        fieldsFilled: Number(fieldStats.filled ?? 0),
        fieldsTotal: Number(fieldStats.total ?? 0),
      },
      recipients: recipients.map(toRecipientDTO),
      versions: versions.map((v: any) => ({
        ...v,
        digitallySigned: Boolean(v.digitallySigned),
        selfSignedCert: Boolean(v.selfSignedCert),
      })),
    };
  },

  /**
   * Signed download URL for the completed document (latest version by default).
   *
   * Distinct from getViewUrl: this forces a download with a sensible filename,
   * whereas the viewer needs inline bytes.
   */
  async getDownloadUrl(documentId: string, userId: string, version?: number) {
    const doc = await loadOwnedDocument(documentId, userId);
    const [rows]: any = await getPool().query(
      'SELECT fileKey, version FROM tbl_sign_document_version WHERE documentId = ? AND version = ?',
      [documentId, version ?? doc.currentVersion]
    );
    if (!rows[0]) throw new AppError('That version does not exist.', 404);

    const suffix = rows[0].version === 1 ? 'original' : 'signed';
    const name = `${doc.title.replace(/[^a-zA-Z0-9 _-]/g, '')} (${suffix}).pdf`;
    return { url: await getSignedDownloadUrl(rows[0].fileKey, name) };
  },

  /**
   * Signed download URL for the standalone certificate of completion.
   *
   * Only exists once the document is finalized — there is nothing truthful to
   * certify about an agreement that is still being signed.
   */
  async getCertificateUrl(documentId: string, userId: string) {
    const doc = await loadOwnedDocument(documentId, userId);
    if (doc.status !== 'COMPLETED') {
      throw new AppError('A certificate is only available once every recipient has signed.', 409);
    }

    const [rows]: any = await getPool().query(
      `SELECT certificateKey FROM tbl_sign_document_version
        WHERE documentId = ? AND certificateKey IS NOT NULL
        ORDER BY version DESC LIMIT 1`,
      [documentId]
    );
    if (!rows[0]?.certificateKey) {
      throw new AppError('No certificate has been generated for this document.', 404);
    }

    const name = `${doc.title.replace(/[^a-zA-Z0-9 _-]/g, '')} (certificate).pdf`;
    return { url: await getSignedDownloadUrl(rows[0].certificateKey, name) };
  },

  /** Ownership gate for the audit endpoint. */
  async assertOwnership(documentId: string, userId: string): Promise<void> {
    await loadOwnedDocument(documentId, userId);
  },
};
