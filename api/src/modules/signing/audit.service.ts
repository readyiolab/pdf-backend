import crypto from 'crypto';
import type { Request } from 'express';
import { db } from '../../lib/mysql';
import { logger } from '../../lib/logger';
import { getRequestContext } from '../../lib/userAgent';
import type { SignAuditAction } from '../../../../shared/signing';

export interface AuditEntry {
  documentId: string;
  action: SignAuditAction;
  recipientId?: string | null;
  actorId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  detail?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Append-only audit trail. There is intentionally no update or delete method:
 * the log is evidence, and the only way a row disappears is the document itself
 * being deleted (ON DELETE CASCADE).
 */
export const auditService = {
  async record(req: Request | null, entry: AuditEntry): Promise<void> {
    try {
      const ctx = req
        ? getRequestContext(req)
        : { ipAddress: null, userAgent: null, browser: null, os: null, device: null, location: null };

      await db.insert('tbl_sign_audit', {
        id: crypto.randomUUID(),
        documentId: entry.documentId,
        recipientId: entry.recipientId ?? null,
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        actorName: entry.actorName ?? null,
        action: entry.action,
        detail: entry.detail ?? null,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        browser: ctx.browser,
        os: ctx.os,
        device: ctx.device,
        location: ctx.location,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      });
    } catch (err) {
      logger.error({ err, action: entry.action, documentId: entry.documentId }, 'Failed to write audit log entry');
    }
  },

  async list(documentId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;

    const [rows, totalCount] = await Promise.all([
      db.queryAll(
        `SELECT id, documentId, recipientId, actorId, actorEmail, actorName, action, detail,
                ipAddress, userAgent, browser, os, device, location, metadata, createdAt
           FROM tbl_sign_audit
          WHERE documentId = ?
          ORDER BY createdAt DESC, id DESC
          LIMIT ? OFFSET ?`,
        [documentId, limit, offset]
      ),
      db.count('tbl_sign_audit', 'documentId = ?', [documentId]),
    ]);

    return {
      entries: rows.map((r: any) => ({
        ...r,
        metadata: typeof r.metadata === 'string' ? safeParse(r.metadata) : r.metadata,
      })),
      pagination: { page, limit, total: totalCount, totalPages: Math.ceil(totalCount / limit) },
    };
  },
};

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
