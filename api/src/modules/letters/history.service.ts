import { db } from '../../lib/mysql';
import { orgScope } from './orgScope';
import { batchService } from './batch.service';
import { getStorageForUser, resolveUserStorageContext } from '../../lib/storage';
import { AppError } from '../../middleware/errorHandler.middleware';
import { logger } from '../../lib/logger';
import { redis } from '../../lib/redis';
import { enqueueLetterZip } from '../../lib/letterQueues';
import crypto from 'crypto';

const ZIP_STATUS_PREFIX = 'letter:zip:';
const ZIP_STATUS_TTL = 60 * 60; // 1 hour

export type LetterZipStatus = {
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  zipKey?: string;
  error?: string;
  batchId: string;
  organizationId: string;
  userId: string;
};

export async function setLetterZipStatus(jobId: string, data: LetterZipStatus): Promise<void> {
  await redis.set(`${ZIP_STATUS_PREFIX}${jobId}`, JSON.stringify(data), 'EX', ZIP_STATUS_TTL);
}

export async function getLetterZipStatusRaw(jobId: string): Promise<LetterZipStatus | null> {
  const raw = await redis.get(`${ZIP_STATUS_PREFIX}${jobId}`);
  return raw ? (JSON.parse(raw) as LetterZipStatus) : null;
}

export const historyService = {
  async listBatches(organizationId: string) {
    const rows = await db.queryAll<any>(
      `SELECT b.*,
              t.name AS templateName, t.type AS templateType, t.version AS templateVersion,
              bp.name AS brandName
         FROM tbl_letter_batch b
         LEFT JOIN tbl_letter_template t ON t.id = b.templateId
         LEFT JOIN tbl_letter_brand_profile bp ON bp.id = b.brandProfileId
        WHERE b.organizationId = ?
        ORDER BY b.createdAt DESC
        LIMIT 200`,
      [organizationId]
    );
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      totalRows: r.totalRows,
      readyCount: r.readyCount,
      warningCount: r.warningCount,
      blockedCount: r.blockedCount,
      generatedCount: r.generatedCount,
      failedCount: r.failedCount,
      sentCount: r.sentCount,
      templateName: r.templateName,
      templateType: r.templateType,
      templateVersion: r.templateVersion,
      brandName: r.brandName,
      aiSummary: r.aiSummary,
      sourceFileName: r.sourceFileName,
      createdAt: r.createdAt,
      generatedAt: r.generatedAt,
    }));
  },

  async getBatchDetail(organizationId: string, batchId: string) {
    const batch = await batchService.get(organizationId, batchId);
    const template = batch.templateId
      ? await orgScope.selectOne(organizationId, 'tbl_letter_template', '*', 'id = ?', [
          batch.templateId,
        ])
      : null;
    const sendCounts = await db.queryAll<any>(
      `SELECT sendStatus, COUNT(*) AS cnt
         FROM tbl_letter_batch_employee WHERE batchId = ?
         GROUP BY sendStatus`,
      [batchId]
    );
    return {
      batch,
      template: template
        ? {
            id: template.id,
            name: template.name,
            type: template.type,
            version: template.version,
          }
        : null,
      sendCounts: Object.fromEntries(sendCounts.map((r: any) => [r.sendStatus, Number(r.cnt)])),
    };
  },

  async listAudit(organizationId: string, limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = await db.queryAll<any>(
      `SELECT id, action, entityType, entityId, metadataJson, aiAssisted, userId, createdAt
         FROM tbl_letter_audit
        WHERE organizationId = ?
        ORDER BY createdAt DESC
        LIMIT ?`,
      [organizationId, safeLimit]
    );
    return rows.map((r: any) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      metadata:
        typeof r.metadataJson === 'string' ? JSON.parse(r.metadataJson || '{}') : r.metadataJson,
      aiAssisted: Boolean(r.aiAssisted),
      userId: r.userId,
      createdAt: r.createdAt,
    }));
  },

  async downloadReport(organizationId: string, batchId: string) {
    await batchService.get(organizationId, batchId);
    const rows = await db.queryAll<any>(
      `SELECT rowIndex, validationStatus, sendStatus, pdfFileName, employeeDataJson, validationErrorsJson
         FROM tbl_letter_batch_employee WHERE batchId = ? ORDER BY rowIndex ASC`,
      [batchId]
    );
    return rows.map((r) => {
      const data =
        typeof r.employeeDataJson === 'string'
          ? JSON.parse(r.employeeDataJson)
          : r.employeeDataJson || {};
      const { PDF_Password: _pw, ...safe } = data;
      return {
        rowIndex: r.rowIndex,
        validationStatus: r.validationStatus,
        sendStatus: r.sendStatus,
        pdfFileName: r.pdfFileName,
        employee: safe,
        errors:
          typeof r.validationErrorsJson === 'string'
            ? JSON.parse(r.validationErrorsJson || '[]')
            : r.validationErrorsJson,
      };
    });
  },

  /**
   * Enqueue a background ZIP of all batch PDFs. The ZIP is built in the worker
   * process and uploaded to storage; clients poll getPdfsZipStatus for a
   * short-lived download URL.
   */
  async enqueuePdfsZip(organizationId: string, userId: string, batchId: string) {
    await batchService.get(organizationId, batchId);
    const rows = await db.queryAll<any>(
      `SELECT id FROM tbl_letter_batch_employee
        WHERE batchId = ? AND pdfKey IS NOT NULL AND pdfKey <> ''
        LIMIT 1`,
      [batchId]
    );
    if (!rows.length) {
      throw new AppError('No PDFs are ready to download for this batch yet.', 404);
    }

    const { storageBindingId } = await resolveUserStorageContext(userId);
    const zipJobId = crypto.randomUUID();
    await setLetterZipStatus(zipJobId, {
      status: 'QUEUED',
      batchId,
      organizationId,
      userId,
    });

    await enqueueLetterZip({
      zipJobId,
      batchId,
      organizationId,
      userId,
      storageBindingId: storageBindingId ?? null,
    });

    return { zipJobId, status: 'QUEUED' as const };
  },

  async getPdfsZipStatus(organizationId: string, userId: string, zipJobId: string) {
    const state = await getLetterZipStatusRaw(zipJobId);
    if (!state || state.organizationId !== organizationId || state.userId !== userId) {
      throw new AppError('ZIP job not found', 404);
    }

    if (state.status === 'FAILED') {
      return { status: 'FAILED' as const, error: state.error || 'ZIP failed' };
    }
    if (state.status !== 'COMPLETED' || !state.zipKey) {
      return { status: state.status };
    }

    const { storage } = await getStorageForUser(userId);
    const url = await storage.presignGet(state.zipKey, {
      ttlSeconds: 300,
      fileName: `letters-${state.batchId.slice(0, 8)}.zip`,
      disposition: 'attachment',
      contentType: 'application/zip',
    });
    return {
      status: 'COMPLETED' as const,
      url,
      expiresInSeconds: 300,
      fileName: `letters-${state.batchId.slice(0, 8)}.zip`,
    };
  },

  async presignEmployeePdf(
    organizationId: string,
    userId: string,
    batchId: string,
    employeeId: string
  ) {
    await batchService.get(organizationId, batchId);
    const emp = await db.select(
      'tbl_letter_batch_employee',
      'id, pdfKey, pdfFileName',
      'id = ? AND batchId = ?',
      [employeeId, batchId]
    );
    if (!emp?.pdfKey) {
      throw new AppError('PDF not found for this employee', 404);
    }
    const { storage } = await getStorageForUser(userId);
    const url = await storage.presignGet(emp.pdfKey, { ttlSeconds: 300 });
    return {
      url,
      fileName: emp.pdfFileName || 'letter.pdf',
      expiresInSeconds: 300,
    };
  },
};

/**
 * Purge PDF objects older than org retention; keep metadata rows.
 * Called from maintenance worker.
 */
export async function purgeExpiredLetterPdfs(): Promise<{ purged: number }> {
  const orgs = await db.queryAll<any>(
    `SELECT id, letterRetentionDays FROM tbl_organization WHERE status = 'ACTIVE'`
  );
  let purged = 0;
  for (const org of orgs) {
    const days = Number(org.letterRetentionDays || 30);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const pageSize = 200;
    let offset = 0;
    for (;;) {
      const rows = await db.queryAll<any>(
        `SELECT e.id, e.pdfKey, b.createdBy
           FROM tbl_letter_batch_employee e
           JOIN tbl_letter_batch b ON b.id = e.batchId
          WHERE b.organizationId = ?
            AND e.pdfKey IS NOT NULL AND e.pdfKey <> ''
            AND b.createdAt < ?
          ORDER BY e.id ASC
          LIMIT ${pageSize} OFFSET ${offset}`,
        [org.id, cutoff]
      );
      if (!rows.length) break;

      try {
        const uid = rows[0].createdBy;
        if (uid) {
          const { storage } = await getStorageForUser(uid);
          for (const r of rows) {
            try {
              await storage.deleteObject(r.pdfKey);
            } catch {
              /* continue */
            }
            await db.update('tbl_letter_batch_employee', { pdfKey: null }, 'id = ?', [r.id]);
            purged += 1;
          }
        }
      } catch (err) {
        logger.warn({ err, orgId: org.id }, 'Letter PDF retention purge failed for org');
      }

      if (rows.length < pageSize) break;
      // Keys were nullified, so keep offset at 0 to walk remaining matching rows
      offset = 0;
    }
  }
  return { purged };
}
