import crypto from 'crypto';
import bcrypt from 'bcrypt';
import {
  getSignedDownloadUrl,
  getSignedViewUrl,
  hashObject,
  readObjectHeadWithSize,
  deleteObject,
  deleteObjects,
} from '../../lib/s3';
import { db } from '../../lib/mysql';
import { env } from '../../config/env';
import { AppError } from '../../middleware/errorHandler.middleware';
import { detectFileCategory } from '../../../../shared/fileType';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { getStorageForUser } from '../../lib/storage';
import { enqueueSignConvert } from '../../lib/queue';
import {
  RECIPIENT_COLORS,
  SIGNING_LIMITS,
  isSigningAllowedContentType,
  isSigningOfficeUpload,
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

function documentKey(
  userId: string,
  documentId: string,
  fileName: string,
  organizationId: string | null
): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  if (organizationId) {
    return `org-${organizationId}/signing/doc-${documentId}/original_${sanitized}`;
  }
  return `${SIGNING_PREFIX}/user-${userId}/doc-${documentId}/original_${sanitized}`;
}

function sourceDocumentKey(
  userId: string,
  documentId: string,
  fileName: string,
  organizationId: string | null
): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  if (organizationId) {
    return `org-${organizationId}/signing/doc-${documentId}/source_${sanitized}`;
  }
  return `${SIGNING_PREFIX}/user-${userId}/doc-${documentId}/source_${sanitized}`;
}

function convertedDocumentKey(
  userId: string,
  documentId: string,
  fileName: string,
  organizationId: string | null
): string {
  const baseName = fileName.replace(/\.docx$/i, '.pdf');
  const sanitized = baseName.replace(/[^a-zA-Z0-9.-]/g, '_');
  if (organizationId) {
    return `org-${organizationId}/signing/doc-${documentId}/converted_${sanitized}`;
  }
  return `${SIGNING_PREFIX}/user-${userId}/doc-${documentId}/converted_${sanitized}`;
}

function isOwnedSigningKey(
  fileKey: string,
  userId: string,
  organizationId: string | null
): boolean {
  if (organizationId && fileKey.startsWith(`org-${organizationId}/signing/`)) return true;
  return fileKey.startsWith(`${SIGNING_PREFIX}/user-${userId}/`);
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
  const doc = await db.select('tbl_sign_document', '*', 'id = ? AND ownerId = ?', [
    documentId,
    userId,
  ]);
  if (!doc) {
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

    if (!isSigningAllowedContentType(contentType, fileName)) {
      throw new AppError('Only PDF and Word (.docx) files can be sent for signature.', 400);
    }
    if (isSigningOfficeUpload(contentType, fileName) && !/\.docx$/i.test(fileName)) {
      throw new AppError('Only .docx Word files are supported. Save legacy .doc files as .docx first.', 400);
    }
    if (fileSize > SIGNING_LIMITS.maxFileSize) {
      const maxMb = Math.floor(SIGNING_LIMITS.maxFileSize / (1024 * 1024));
      throw new AppError(`File size exceeds the ${maxMb}MB limit for signing documents.`, 400);
    }

    // The document id is minted here so the object lands in its final
    // doc-scoped folder, rather than being moved after the row is created.
    const documentId = crypto.randomUUID();
    const { storage, organizationId } = await getStorageForUser(userId);
    const fileKey = isSigningOfficeUpload(contentType, fileName)
      ? sourceDocumentKey(userId, documentId, fileName, organizationId)
      : documentKey(userId, documentId, fileName, organizationId);
    const uploadUrl = await storage.presignPut(fileKey, contentType, env.PRESIGN_TTL_SECONDS);

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
    const { organizationId, storageBindingId } = await getStorageForUser(userId);
    if (!isOwnedSigningKey(fileKey, userId, organizationId)) {
      throw new AppError('Invalid file key for this account.', 400);
    }

    let size: number;
    let head: Buffer;
    try {
      const probe = await readObjectHeadWithSize(fileKey, 1024, storageBindingId);
      size = probe.size;
      head = probe.bytes;
    } catch {
      throw new AppError('The uploaded file could not be found. Please re-upload.', 400);
    }

    if (size <= 0) {
      await deleteObject(fileKey, storageBindingId);
      throw new AppError('The uploaded file is empty.', 400);
    }
    if (size > SIGNING_LIMITS.maxFileSize) {
      await deleteObject(fileKey, storageBindingId);
      const maxMb = Math.floor(SIGNING_LIMITS.maxFileSize / (1024 * 1024));
      throw new AppError(`File size exceeds the ${maxMb}MB limit for signing documents.`, 400);
    }

    const category = detectFileCategory(head);
    const documentId = fileKey.match(/\/doc-([0-9a-f-]{36})\//)?.[1] ?? crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SIGNING_LIMITS.defaultExpiryDays * 86400_000);

    if (category === 'office') {
      if (!/\.docx$/i.test(fileName)) {
        await deleteObject(fileKey, storageBindingId);
        throw new AppError('Only .docx Word files are supported for signing.', 400);
      }
      if (!fileKey.includes('/source_')) {
        await deleteObject(fileKey, storageBindingId);
        throw new AppError('Invalid file key for Word upload.', 400);
      }

      const docTitle = (title || fileName.replace(/\.docx$/i, '')).slice(0, SIGNING_LIMITS.maxTitleLength);
      const pdfKey = convertedDocumentKey(userId, documentId, fileName, organizationId);
      const pdfFileName = fileName.replace(/\.docx$/i, '.pdf');

      const conn = await db.beginTransaction();
      try {
        await conn.query(
          `INSERT INTO tbl_sign_document
             (id, ownerId, title, status, fileKey, storageBindingId, fileName, fileSize, pageCount,
              currentVersion, originalHash, sourceFileKey, sourceFileName, expiresAt)
           VALUES (?, ?, ?, 'CONVERTING', ?, ?, ?, ?, 0, 1, NULL, ?, ?, ?)`,
          [
            documentId,
            userId,
            docTitle,
            pdfKey,
            storageBindingId,
            pdfFileName,
            0,
            fileKey,
            fileName,
            expiresAt,
          ]
        );

        await conn.query(
          `INSERT INTO tbl_sign_document_version (id, documentId, version, fileKey, storageBindingId, fileSize, sha256, label)
           VALUES (?, ?, 1, ?, ?, 0, NULL, 'Converting')`,
          [crypto.randomUUID(), documentId, pdfKey, storageBindingId]
        );

        await db.commit(conn);
      } catch (err) {
        await db.rollback(conn);
        throw err;
      }

      await enqueueSignConvert(documentId, fileKey, storageBindingId);
      return this.getDocument(documentId, userId);
    }

    if (category !== 'pdf') {
      await deleteObject(fileKey, storageBindingId);
      throw new AppError('Only PDF and Word (.docx) files can be sent for signature.', 400);
    }

    // Hash the original BEFORE it is registered, let alone signed. This is the
    // baseline the completion certificate cites to prove the signed output
    // derives from the document the parties actually saw. Taking it later —
    // after any tool has touched the file — would prove nothing.
    const originalHash = await hashObject(fileKey, storageBindingId);

    const docTitle = (title || fileName.replace(/\.pdf$/i, '')).slice(0, SIGNING_LIMITS.maxTitleLength);

    const conn = await db.beginTransaction();
    try {
      await conn.query(
        `INSERT INTO tbl_sign_document
           (id, ownerId, title, status, fileKey, storageBindingId, fileName, fileSize, pageCount, currentVersion, originalHash, expiresAt)
         VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          documentId,
          userId,
          docTitle,
          fileKey,
          storageBindingId,
          fileName,
          size,
          pageCount ?? 0,
          originalHash,
          expiresAt,
        ]
      );

      // v1 is the pristine original. Every later finalization appends a row;
      // this one is never mutated, which is what "preserve the original
      // document" means in practice.
      await conn.query(
        `INSERT INTO tbl_sign_document_version (id, documentId, version, fileKey, storageBindingId, fileSize, sha256, label)
         VALUES (?, ?, 1, ?, ?, ?, ?, 'Original')`,
        [crypto.randomUUID(), documentId, fileKey, storageBindingId, size, originalHash]
      );

      await db.commit(conn);
    } catch (err) {
      await db.rollback(conn);
      throw err;
    }

    return this.getDocument(documentId, userId);
  },

  async listDocuments(userId: string, query: ListDocumentsInput) {
    const { status, search, page, limit } = query;
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

    // Execute main document pagination query and total count query in parallel
    const [rows, totalCount] = await Promise.all([
      db.queryAll(
        `SELECT d.*
           FROM tbl_sign_document d
          WHERE ${whereSql}
          ORDER BY d.updatedAt DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      ),
      db.count('tbl_sign_document', whereSql, params),
    ]);

    if (!rows || rows.length === 0) {
      return {
        documents: [],
        pagination: { page, limit, total: totalCount, totalPages: Math.ceil(totalCount / limit) },
      };
    }

    // Batch aggregate recipient counts in a single query for the returned page of documents
    const docIds = rows.map((r: any) => r.id);
    const recipientCounts = await db.queryAll(
      `SELECT documentId,
              COUNT(1) AS recipientCount,
              SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completedCount
         FROM tbl_sign_recipient
        WHERE documentId IN (?)
        GROUP BY documentId`,
      [docIds]
    );

    const recipientMap = new Map<string, { recipientCount: number; completedCount: number }>();
    for (const r of recipientCounts) {
      recipientMap.set(r.documentId, {
        recipientCount: Number(r.recipientCount || 0),
        completedCount: Number(r.completedCount || 0),
      });
    }

    const documentsWithCounts = rows.map((doc: any) => {
      const counts = recipientMap.get(doc.id) || { recipientCount: 0, completedCount: 0 };
      return {
        ...doc,
        recipientCount: counts.recipientCount,
        completedCount: counts.completedCount,
      };
    });

    return {
      documents: documentsWithCounts,
      pagination: { page, limit, total: totalCount, totalPages: Math.ceil(totalCount / limit) },
    };
  },

  /** Status tallies for the dashboard, in one round trip via Promise.all. */
  async getStats(userId: string) {
    // Run status breakdown query and user quota query in parallel
    const [rows, user] = await Promise.all([
      db.queryAll(
        `SELECT status, COUNT(1) AS count
           FROM tbl_sign_document
          WHERE ownerId = ?
          GROUP BY status`,
        [userId]
      ),
      db.select('tbl_user', 'plan, monthlySignsUsed, monthlySignsResetAt', 'id = ?', [userId]),
    ]);

    const byStatus: Record<string, number> = {
      CONVERTING: 0,
      CONVERSION_FAILED: 0,
      DRAFT: 0, SENT: 0, FINALIZING: 0, COMPLETED: 0, DECLINED: 0, EXPIRED: 0, VOIDED: 0,
    };
    for (const r of rows) byStatus[r.status] = Number(r.count);

    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    // Only documents that actually went out can complete; counting drafts in
    // the denominator would make the rate drop every time someone starts one.
    const finished = byStatus.SENT + byStatus.COMPLETED + byStatus.DECLINED + byStatus.EXPIRED;

    // Monthly signing quota, so the dashboard can show "2 of 3 used" and the UI
    // can warn before the send actually fails. Read the same counter the send
    // reservation writes; treat an elapsed window as a fresh (0-used) month.
    const plan = (user?.plan as 'FREE' | 'PRO') ?? 'FREE';
    const limit = PLAN_LIMITS[plan].maxMonthlySigns;
    const windowElapsed =
      !user?.monthlySignsResetAt ||
      new Date(user.monthlySignsResetAt).getTime() < Date.now() - 30 * 24 * 60 * 60 * 1000;
    const used = windowElapsed ? 0 : Number(user?.monthlySignsUsed ?? 0);

    return {
      byStatus,
      total,
      completionRate: finished > 0 ? Math.round((byStatus.COMPLETED / finished) * 100) : 0,
      quota: {
        used,
        limit,
        remaining: Math.max(0, limit - used),
        // When the current window ends (null once it has already elapsed).
        resetsAt: windowElapsed || !user?.monthlySignsResetAt
          ? null
          : new Date(new Date(user.monthlySignsResetAt).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        plan,
      },
    };
  },

  async getDocument(documentId: string, userId: string): Promise<SignDocumentDTO> {
    const doc = await loadOwnedDocument(documentId, userId);

    const [recipients, fields] = await Promise.all([
      db.selectAll(
        'tbl_sign_recipient',
        '*',
        'documentId = ?',
        [documentId],
        'ORDER BY signingOrder ASC, createdAt ASC'
      ),
      db.selectAll(
        'tbl_sign_field',
        '*',
        'documentId = ?',
        [documentId],
        'ORDER BY page ASC, y ASC, x ASC'
      ),
    ]);

    return {
      ...doc,
      recipients: recipients.map(toRecipientDTO),
      fields: fields.map(toFieldDTO),
    };
  },

  /** Short-lived signed URL the viewer uses to fetch the PDF bytes. */
  async getViewUrl(documentId: string, userId: string, version?: number) {
    const doc = await loadOwnedDocument(documentId, userId);

    if (doc.status === 'CONVERTING') {
      throw new AppError('This document is still being converted from Word to PDF. Please wait.', 409);
    }
    if (doc.status === 'CONVERSION_FAILED') {
      throw new AppError('Word conversion failed. Delete this document and try uploading again.', 409);
    }

    let key = doc.fileKey;
    if (version) {
      const row = await db.select(
        'tbl_sign_document_version',
        'fileKey',
        'documentId = ? AND version = ?',
        [documentId, version]
      );
      if (!row) throw new AppError('Document version not found', 404);
      key = row.fileKey;
    }

    // Longer than DOWNLOAD_URL_TTL: a viewer session outlives a click-to-save,
    // and pdf.js re-requests byte ranges for the life of the open document.
    return { url: await getSignedViewUrl(key, 3600, doc.storageBindingId ?? null) };
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

    await db.execute(
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

    const versions = await db.selectAll(
      'tbl_sign_document_version',
      'fileKey',
      'documentId = ?',
      [documentId]
    );

    // Delete the DB rows first. If S3 deletion fails afterwards we leak
    // objects (recoverable, and reported by monitoring); if we deleted S3
    // first and the DB delete failed, the document would still be listed but
    // its bytes would be gone — a far worse state to be in.
    await db.delete('tbl_sign_document', 'id = ?', [documentId]);
    const keysToDelete = [
      doc.fileKey,
      ...versions.map((v: any) => v.fileKey),
      ...(doc.sourceFileKey ? [doc.sourceFileKey] : []),
    ];
    await deleteObjects(keysToDelete, doc.storageBindingId ?? null);

    return { id: documentId, deleted: true };
  },

  async addRecipient(documentId: string, userId: string, input: AddRecipientInput): Promise<SignRecipientDTO> {
    const doc = await loadOwnedDocument(documentId, userId);
    assertDraft(doc, 'add recipients');

    const existing = await db.selectAll(
      'tbl_sign_recipient',
      'id, email, signingOrder',
      'documentId = ?',
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
      ? await bcrypt.hash(input.accessCode, env.BCRYPT_OTP_ROUNDS)
      : null;

    await db.insert('tbl_sign_recipient', {
      id: recipientId,
      documentId,
      name: input.name.trim(),
      email,
      phone: input.phone ?? null,
      role: input.role,
      color,
      signingOrder,
      authMethod: input.authMethod,
      accessCodeHash,
      status: 'PENDING',
    });

    const row = await db.select('tbl_sign_recipient', '*', 'id = ?', [recipientId]);
    return toRecipientDTO(row);
  },

  async updateRecipient(
    documentId: string,
    recipientId: string,
    userId: string,
    input: UpdateRecipientInput
  ): Promise<SignRecipientDTO> {
    const doc = await loadOwnedDocument(documentId, userId);
    assertDraft(doc, 'edit recipients');

    const existing = await db.select(
      'tbl_sign_recipient',
      'id, phone, authMethod',
      'id = ? AND documentId = ?',
      [recipientId, documentId]
    );
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
      const dupe = await db.select(
        'tbl_sign_recipient',
        'id',
        'documentId = ? AND email = ? AND id <> ?',
        [documentId, email, recipientId]
      );
      if (dupe) throw new AppError('Another recipient already uses this email.', 409);
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
      params.push(await bcrypt.hash(input.accessCode, env.BCRYPT_OTP_ROUNDS));
    }

    await db.execute(
      `UPDATE tbl_sign_recipient SET ${sets.join(', ')} WHERE id = ?`,
      [...params, recipientId]
    );

    const updated = await db.select('tbl_sign_recipient', '*', 'id = ?', [recipientId]);
    return toRecipientDTO(updated);
  },

  async removeRecipient(documentId: string, recipientId: string, userId: string) {
    const doc = await loadOwnedDocument(documentId, userId);
    assertDraft(doc, 'remove recipients');

    const result = await db.execute(
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

    const recipients = await db.selectAll(
      'tbl_sign_recipient',
      'id',
      'documentId = ?',
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

    const conn = await db.beginTransaction();
    try {
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

      await db.commit(conn);
    } catch (err) {
      await db.rollback(conn);
      throw err;
    }

    const rows = await db.selectAll(
      'tbl_sign_field',
      '*',
      'documentId = ?',
      [documentId],
      'ORDER BY page ASC, y ASC, x ASC'
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
    const [doc, recipients, fieldStats, versions] = await Promise.all([
      db.select('tbl_sign_document', '*', 'id = ?', [documentId]),
      db.selectAll(
        'tbl_sign_recipient',
        '*',
        'documentId = ?',
        [documentId],
        'ORDER BY signingOrder ASC, createdAt ASC'
      ),
      db.query(
        `SELECT COUNT(1) AS total, SUM(CASE WHEN value IS NOT NULL THEN 1 ELSE 0 END) AS filled
           FROM tbl_sign_field WHERE documentId = ?`,
        [documentId]
      ),
      db.queryAll(
        `SELECT version, sha256, label, fileSize, digitallySigned, selfSignedCert, tsaTimestamp, createdAt
           FROM tbl_sign_document_version WHERE documentId = ? ORDER BY version ASC`,
        [documentId]
      ),
    ]);

    if (!doc || doc.ownerId !== userId) {
      throw new AppError('Document not found', 404);
    }

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
      sourceFileName: doc.sourceFileName ?? null,
      currentVersion: doc.currentVersion,
      progress: {
        signed: completed.length,
        total: actionable.length,
        fieldsFilled: Number(fieldStats?.filled ?? 0),
        fieldsTotal: Number(fieldStats?.total ?? 0),
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
    const row = await db.select(
      'tbl_sign_document_version',
      'fileKey, version',
      'documentId = ? AND version = ?',
      [documentId, version ?? doc.currentVersion]
    );
    if (!row) throw new AppError('That version does not exist.', 404);

    const suffix = row.version === 1 ? 'original' : 'signed';
    const name = `${doc.title.replace(/[^a-zA-Z0-9 _-]/g, '')} (${suffix}).pdf`;
    return { url: await getSignedDownloadUrl(row.fileKey, name, undefined, doc.storageBindingId ?? null) };
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

    const row = await db.query(
      `SELECT certificateKey FROM tbl_sign_document_version
        WHERE documentId = ? AND certificateKey IS NOT NULL
        ORDER BY version DESC LIMIT 1`,
      [documentId]
    );
    if (!row?.certificateKey) {
      throw new AppError('No certificate has been generated for this document.', 404);
    }

    const name = `${doc.title.replace(/[^a-zA-Z0-9 _-]/g, '')} (certificate).pdf`;
    return { url: await getSignedDownloadUrl(row.certificateKey, name, undefined, doc.storageBindingId ?? null) };
  },

  /** Signed download URL for the original Word (.docx) upload, when present. */
  async getSourceDownloadUrl(documentId: string, userId: string) {
    const doc = await loadOwnedDocument(documentId, userId);
    if (!doc.sourceFileKey) {
      throw new AppError('This document has no original Word file.', 404);
    }

    const name = doc.sourceFileName || 'original.docx';
    return {
      url: await getSignedDownloadUrl(doc.sourceFileKey, name, undefined, doc.storageBindingId ?? null),
    };
  },

  /** Ownership gate for the audit endpoint. */
  async assertOwnership(documentId: string, userId: string): Promise<void> {
    await loadOwnedDocument(documentId, userId);
  },

  /**
   * Cancels an in-flight signing request. Recipients who already hold a link
   * will see VOIDED on their next open; completed docs cannot be voided.
   */
  async voidDocument(documentId: string, userId: string): Promise<{ id: string; status: 'VOIDED' }> {
    const doc = await loadOwnedDocument(documentId, userId);
    if (doc.status !== 'SENT' && doc.status !== 'FINALIZING') {
      throw new AppError('Only documents awaiting signature can be cancelled.', 409);
    }

    const result = await db.execute(
      "UPDATE tbl_sign_document SET status = 'VOIDED' WHERE id = ? AND status IN ('SENT', 'FINALIZING')",
      [documentId]
    );
    if (result.affectedRows === 0) {
      throw new AppError('Only documents awaiting signature can be cancelled.', 409);
    }

    return { id: documentId, status: 'VOIDED' };
  },

  /**
   * Flips past-deadline SENT documents to EXPIRED. Called from the public
   * signing path (lazy) and from the maintenance worker (batch).
   * Returns the ids that were expired in this call.
   */
  async expireOverdueDocuments(limit = 200): Promise<string[]> {
    const now = new Date();
    const rows = await db.queryAll(
      `SELECT id FROM tbl_sign_document
        WHERE status = 'SENT' AND expiresAt IS NOT NULL AND expiresAt < ?
        ORDER BY expiresAt ASC
        LIMIT ?`,
      [now, limit]
    );
    if (!rows.length) return [];

    const ids = rows.map((r: any) => r.id as string);
    const upd = await db.execute(
      `UPDATE tbl_sign_document SET status = 'EXPIRED'
        WHERE status = 'SENT' AND id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    if (upd.affectedRows === 0) return [];

    // Re-read in case a concurrent finalize claimed some rows.
    const expired = await db.queryAll(
      `SELECT id FROM tbl_sign_document WHERE status = 'EXPIRED' AND id IN (?)`,
      [ids]
    );
    return expired.map((r: any) => r.id as string);
  },

  /** Expire a single document if its deadline has passed. Returns true if flipped. */
  async expireIfOverdue(documentId: string): Promise<boolean> {
    const result = await db.execute(
      `UPDATE tbl_sign_document SET status = 'EXPIRED'
        WHERE id = ? AND status = 'SENT' AND expiresAt IS NOT NULL AND expiresAt < ?`,
      [documentId, new Date()]
    );
    return result.affectedRows > 0;
  },
};
