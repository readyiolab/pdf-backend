import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import { copyObject, deleteObject, headObjectSize } from '../../lib/s3';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { RECIPIENT_COLORS, SIGNING_LIMITS } from '../../../../shared/signing';
import type { CreateTemplateInput, UseTemplateInput } from './signing.types';
import { signingService } from './signing.service';

const SIGNING_PREFIX = 'pdf-saas-signing';

interface TemplateRecipientRole {
  role: string;
  name: string;
  color: string;
  signingOrder: number;
  authMethod: string;
}

interface TemplateFieldSnapshot {
  type: string;
  label: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  locked: boolean;
  config: Record<string, unknown>;
  recipientIndex: number;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function toTemplateDTO(row: any) {
  const recipients = parseJson<TemplateRecipientRole[]>(row.recipientsJson, []);
  const fields = parseJson<TemplateFieldSnapshot[]>(row.fieldsJson, []);
  return {
    id: row.id,
    name: row.name,
    message: row.message,
    flowType: row.flowType,
    fileName: row.fileName,
    fileSize: Number(row.fileSize),
    pageCount: row.pageCount,
    recipientCount: recipients.length,
    fieldCount: fields.length,
    recipients,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const templateService = {
  async list(userId: string) {
    const rows = await db.selectAll(
      'tbl_sign_template',
      `id, ownerId, name, message, flowType, fileName, fileSize, pageCount,
              recipientsJson, fieldsJson, createdAt, updatedAt`,
      'ownerId = ?',
      [userId],
      'ORDER BY updatedAt DESC'
    );
    return { templates: rows.map(toTemplateDTO) };
  },

  async createFromDocument(userId: string, input: CreateTemplateInput) {
    const user = await db.select('tbl_user', 'plan', 'id = ?', [userId]);
    const plan = (user?.plan as 'FREE' | 'PRO') ?? 'FREE';
    const limit = PLAN_LIMITS[plan].maxSignTemplates;

    const count = await db.count('tbl_sign_template', 'ownerId = ?', [userId]);
    if (count >= limit) {
      throw new AppError(
        plan === 'PRO'
          ? `You've reached the limit of ${limit} templates.`
          : `Free plans can save up to ${limit} templates. Upgrade to PRO for more.`,
        403
      );
    }

    const doc = await signingService.getDocument(input.documentId, userId);
    if (!doc.recipients?.length) {
      throw new AppError('Add recipients before saving a template.', 400);
    }
    if (!doc.fields?.length) {
      throw new AppError('Place fields before saving a template.', 400);
    }

    const recipientIndex = new Map<string, number>();
    const recipients: TemplateRecipientRole[] = doc.recipients.map((r, i) => {
      recipientIndex.set(r.id, i);
      return {
        role: r.role,
        name: r.name,
        color: r.color,
        signingOrder: r.signingOrder,
        authMethod: r.authMethod === 'SMS_OTP' ? 'NONE' : r.authMethod,
      };
    });

    const fields: TemplateFieldSnapshot[] = doc.fields
      .filter((f) => f.recipientId && recipientIndex.has(f.recipientId))
      .map((f) => ({
        type: f.type,
        label: f.label,
        page: f.page,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        required: f.required,
        locked: f.locked,
        config: (f.config ?? {}) as Record<string, unknown>,
        recipientIndex: recipientIndex.get(f.recipientId!)!,
      }));

    if (fields.length === 0) {
      throw new AppError('Assign fields to recipients before saving a template.', 400);
    }

    const templateId = crypto.randomUUID();
    const destKey = `${SIGNING_PREFIX}/user-${userId}/templates/${templateId}/original_${doc.fileName.replace(
      /[^a-zA-Z0-9._-]/g,
      '_'
    )}`;

    try {
      await copyObject(doc.fileKey, destKey);
    } catch {
      throw new AppError('Could not copy the PDF for this template. Try again.', 500);
    }

    let size = 0;
    try {
      size = await headObjectSize(destKey);
    } catch {
      await deleteObject(destKey);
      throw new AppError('Could not verify the template PDF copy.', 500);
    }

    const name = (input.name || doc.title).slice(0, SIGNING_LIMITS.maxTitleLength);

    try {
      await db.insert('tbl_sign_template', {
        id: templateId,
        ownerId: userId,
        name,
        message: doc.message,
        flowType: doc.flowType,
        fileKey: destKey,
        fileName: doc.fileName,
        fileSize: size || doc.fileSize,
        pageCount: doc.pageCount,
        originalHash: doc.originalHash,
        recipientsJson: JSON.stringify(recipients),
        fieldsJson: JSON.stringify(fields),
      });
    } catch (err) {
      await deleteObject(destKey);
      throw err;
    }

    const row = await db.select('tbl_sign_template', '*', 'id = ?', [templateId]);
    return toTemplateDTO(row);
  },

  async remove(templateId: string, userId: string) {
    const row = await db.select(
      'tbl_sign_template',
      'id, fileKey',
      'id = ? AND ownerId = ?',
      [templateId, userId]
    );
    if (!row) throw new AppError('Template not found', 404);

    await db.delete('tbl_sign_template', 'id = ?', [templateId]);
    await deleteObject(row.fileKey);
    return { id: templateId, deleted: true };
  },

  /**
   * Creates a new DRAFT document from a template: clones the PDF, recreates
   * role recipients with the supplied emails, and restores field layout.
   */
  async createDocument(templateId: string, userId: string, input: UseTemplateInput) {
    const tpl = await db.select(
      'tbl_sign_template',
      '*',
      'id = ? AND ownerId = ?',
      [templateId, userId]
    );
    if (!tpl) throw new AppError('Template not found', 404);

    const roles = parseJson<TemplateRecipientRole[]>(tpl.recipientsJson, []);
    const fieldSnaps = parseJson<TemplateFieldSnapshot[]>(tpl.fieldsJson, []);
    if (roles.length === 0) throw new AppError('This template has no recipient roles.', 400);
    if (input.recipients.length !== roles.length) {
      throw new AppError(
        `This template needs ${roles.length} recipient${roles.length === 1 ? '' : 's'} (got ${input.recipients.length}).`,
        400
      );
    }

    const emails = input.recipients.map((r) => r.email.toLowerCase().trim());
    if (new Set(emails).size !== emails.length) {
      throw new AppError('Each recipient must have a unique email address.', 400);
    }

    const documentId = crypto.randomUUID();
    const destKey = `${SIGNING_PREFIX}/user-${userId}/doc-${documentId}/original_${String(tpl.fileName).replace(
      /[^a-zA-Z0-9._-]/g,
      '_'
    )}`;

    try {
      await copyObject(tpl.fileKey, destKey);
    } catch {
      throw new AppError('Could not copy the template PDF. Try again.', 500);
    }

    const expiresAt = new Date(Date.now() + SIGNING_LIMITS.defaultExpiryDays * 86400_000);
    const conn = await db.beginTransaction();
    try {
      await conn.query(
        `INSERT INTO tbl_sign_document
           (id, ownerId, title, message, status, flowType, fileKey, fileName, fileSize, pageCount,
            currentVersion, originalHash, expiresAt)
         VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          documentId,
          userId,
          tpl.name,
          tpl.message,
          tpl.flowType,
          destKey,
          tpl.fileName,
          tpl.fileSize,
          tpl.pageCount,
          tpl.originalHash,
          expiresAt,
        ]
      );

      await conn.query(
        `INSERT INTO tbl_sign_document_version (id, documentId, version, fileKey, fileSize, sha256, label)
         VALUES (?, ?, 1, ?, ?, ?, 'Original')`,
        [crypto.randomUUID(), documentId, destKey, tpl.fileSize, tpl.originalHash]
      );

      const recipientIds: string[] = [];
      for (let i = 0; i < roles.length; i++) {
        const role = roles[i];
        const provided = input.recipients[i];
        const recipientId = crypto.randomUUID();
        recipientIds.push(recipientId);
        await conn.query(
          `INSERT INTO tbl_sign_recipient
             (id, documentId, name, email, role, color, signingOrder, authMethod, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
          [
            recipientId,
            documentId,
            (provided.name || role.name).trim(),
            emails[i],
            role.role,
            role.color || RECIPIENT_COLORS[i % RECIPIENT_COLORS.length],
            role.signingOrder || i + 1,
            role.authMethod === 'ACCESS_CODE' ? 'NONE' : role.authMethod || 'NONE',
          ]
        );
      }

      for (const f of fieldSnaps) {
        const recipientId = recipientIds[f.recipientIndex];
        if (!recipientId) continue;
        await conn.query(
          `INSERT INTO tbl_sign_field
             (id, documentId, recipientId, type, label, page, x, y, width, height, required, locked, config)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            documentId,
            recipientId,
            f.type,
            f.label,
            f.page,
            f.x,
            f.y,
            f.width,
            f.height,
            f.required ? 1 : 0,
            f.locked ? 1 : 0,
            JSON.stringify(f.config ?? {}),
          ]
        );
      }

      await db.commit(conn);
    } catch (err) {
      await db.rollback(conn);
      await deleteObject(destKey);
      throw err;
    }

    return signingService.getDocument(documentId, userId);
  },
};
