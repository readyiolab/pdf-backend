import { db } from '../../lib/mysql';
import { orgScope } from './orgScope';
import { batchService } from './batch.service';
import { getStorageForUser } from '../../lib/storage';

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
    const rows = await orgScope.selectAll(
      organizationId,
      'tbl_letter_audit',
      '*',
      '',
      [],
      'ORDER BY createdAt DESC'
    );
    return rows.slice(0, limit).map((r: any) => ({
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
    const rows = await db.queryAll<any>(
      `SELECT e.id, e.pdfKey, b.createdBy
         FROM tbl_letter_batch_employee e
         JOIN tbl_letter_batch b ON b.id = e.batchId
        WHERE b.organizationId = ?
          AND e.pdfKey IS NOT NULL AND e.pdfKey <> ''
          AND b.createdAt < ?`,
      [org.id, cutoff]
    );
    if (!rows.length) continue;

    // Best-effort delete via first creator's storage context
    try {
      const userId = rows[0].createdBy;
      if (userId) {
        const { storage } = await getStorageForUser(userId);
        for (const r of rows) {
            try {
              await storage.deleteObject(r.pdfKey);
            } catch {
              /* continue */
            }
          await db.update(
            'tbl_letter_batch_employee',
            { pdfKey: null },
            'id = ?',
            [r.id]
          );
          purged += 1;
        }
      }
    } catch {
      // Mark cleared even if storage delete fails so retention policy advances
      for (const r of rows) {
        await db.update('tbl_letter_batch_employee', { pdfKey: null }, 'id = ?', [r.id]);
        purged += 1;
      }
    }
  }
  return { purged };
}
