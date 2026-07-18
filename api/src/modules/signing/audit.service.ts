import crypto from 'crypto';
import type { Request } from 'express';
import { getPool } from '../../lib/mysql';
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
  /**
   * Records an action. Never throws.
   *
   * A failed audit write must not roll back or 500 the user action that
   * triggered it — refusing to record "document opened" is not a reason to
   * refuse to open the document. Failures are logged at error level so they
   * surface in monitoring instead of vanishing.
   */
  async record(req: Request | null, entry: AuditEntry): Promise<void> {
    try {
      const ctx = req
        ? getRequestContext(req)
        : { ipAddress: null, userAgent: null, browser: null, os: null, device: null, location: null };

      await getPool().query(
        `INSERT INTO tbl_sign_audit
          (id, documentId, recipientId, actorId, actorEmail, actorName, action, detail,
           ipAddress, userAgent, browser, os, device, location, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          entry.documentId,
          entry.recipientId ?? null,
          entry.actorId ?? null,
          entry.actorEmail ?? null,
          entry.actorName ?? null,
          entry.action,
          entry.detail ?? null,
          ctx.ipAddress,
          ctx.userAgent,
          ctx.browser,
          ctx.os,
          ctx.device,
          ctx.location,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
        ]
      );
    } catch (err) {
      logger.error({ err, action: entry.action, documentId: entry.documentId }, 'Failed to write audit log entry');
    }
  },

  async list(documentId: string, page: number, limit: number) {
    const pool = getPool();
    const offset = (page - 1) * limit;

    const [rows]: any = await pool.query(
      `SELECT id, documentId, recipientId, actorId, actorEmail, actorName, action, detail,
              ipAddress, userAgent, browser, os, device, location, metadata, createdAt
         FROM tbl_sign_audit
        WHERE documentId = ?
        ORDER BY createdAt DESC, id DESC
        LIMIT ? OFFSET ?`,
      [documentId, limit, offset]
    );

    const [[{ total }]]: any = await pool.query(
      'SELECT COUNT(1) AS total FROM tbl_sign_audit WHERE documentId = ?',
      [documentId]
    );

    return {
      entries: rows.map((r: any) => ({
        ...r,
        // mysql2 returns JSON columns already parsed on some driver versions and
        // as a string on others; normalize so the client sees one shape.
        metadata: typeof r.metadata === 'string' ? safeParse(r.metadata) : r.metadata,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
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
