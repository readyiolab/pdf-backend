import crypto from 'crypto';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import { encryptSecret, isSecretBoxConfigured } from '../../lib/secretBox';
import { writeLetterAudit } from '../orgs/orgs.service';
import { orgScope } from './orgScope';
import { batchService } from './batch.service';
import { enqueueLetterGenerate } from '../../lib/letterQueues';
import { safePdfFileName } from './letterRender';

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function resolvePassword(
  mode: 'NONE' | 'FROM_COLUMN' | 'EMPLOYEE_ID' | 'LAST4_ID',
  data: Record<string, string>
): string | null {
  switch (mode) {
    case 'NONE':
      return null;
    case 'FROM_COLUMN': {
      const pw = String(data.PDF_Password || '').trim();
      return pw || null;
    }
    case 'EMPLOYEE_ID':
      return String(data.Employee_ID || '').trim() || null;
    case 'LAST4_ID': {
      const id = String(data.Employee_ID || '').trim();
      return id ? id.slice(-4) : null;
    }
    default:
      return null;
  }
}

export const generateService = {
  async samplePreview(organizationId: string, batchId: string) {
    const batch = await batchService.get(organizationId, batchId);
    const countRow = await db.query<any>(
      `SELECT COUNT(*) AS total FROM tbl_letter_batch_employee
        WHERE batchId = ? AND validationStatus IN ('READY', 'WARNING')`,
      [batchId]
    );
    const eligibleCount = Number(countRow?.total || 0);
    if (!eligibleCount) {
      throw new AppError('No ready/warning rows to preview. Fix blocked rows first.', 400);
    }

    const first = await db.query<any>(
      `SELECT id, rowIndex, employeeDataJson FROM tbl_letter_batch_employee
        WHERE batchId = ? AND validationStatus IN ('READY', 'WARNING')
        ORDER BY rowIndex ASC LIMIT 1`,
      [batchId]
    );
    const midOffset = Math.floor((eligibleCount - 1) / 2);
    const mid = await db.query<any>(
      `SELECT id, rowIndex, employeeDataJson FROM tbl_letter_batch_employee
        WHERE batchId = ? AND validationStatus IN ('READY', 'WARNING')
        ORDER BY rowIndex ASC LIMIT 1 OFFSET ${midOffset}`,
      [batchId]
    );
    const last = await db.query<any>(
      `SELECT id, rowIndex, employeeDataJson FROM tbl_letter_batch_employee
        WHERE batchId = ? AND validationStatus IN ('READY', 'WARNING')
        ORDER BY rowIndex DESC LIMIT 1`,
      [batchId]
    );

    const pick = (row: any) => {
      const data = parseJson<Record<string, string>>(row.employeeDataJson, {});
      const { PDF_Password: _pw, ...safe } = data;
      return {
        id: row.id,
        rowIndex: row.rowIndex,
        employeeData: safe,
        suggestedFileName: safePdfFileName(
          data.Employee_ID || 'unknown',
          data.Employee_Name || 'employee',
          'LETTER'
        ),
      };
    };

    return {
      batch,
      samples: {
        first: pick(first),
        middle: pick(mid || first),
        last: pick(last || first),
      },
      eligibleCount,
    };
  },

  async approveAndEnqueue(
    organizationId: string,
    userId: string,
    batchId: string,
    passwordMode: 'NONE' | 'FROM_COLUMN' | 'EMPLOYEE_ID' | 'LAST4_ID' = 'NONE'
  ) {
    const batch = await batchService.get(organizationId, batchId);
    if (!['VALIDATED', 'MAPPED', 'GENERATING', 'GENERATED'].includes(batch.status)) {
      // Allow VALIDATED primarily
    }
    if (batch.status === 'GENERATING') {
      throw new AppError('Generation is already in progress for this batch', 409);
    }

    // Encrypt passwords at rest when present — never log them
    if (passwordMode !== 'NONE' && !isSecretBoxConfigured()) {
      throw new AppError(
        'Server is missing INFRA_CREDENTIALS_KEY — cannot store PDF passwords securely.',
        503
      );
    }

    // Chunked load + password updates to avoid unbounded memory/time
    const pageSize = 500;
    const ids: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await db.queryAll<any>(
        `SELECT id, employeeDataJson FROM tbl_letter_batch_employee
          WHERE batchId = ? AND validationStatus IN ('READY', 'WARNING')
          ORDER BY rowIndex ASC
          LIMIT ${pageSize} OFFSET ${offset}`,
        [batchId]
      );
      if (!page.length) break;
      for (const emp of page) {
        const data = parseJson<Record<string, string>>(emp.employeeDataJson, {});
        const password = resolvePassword(passwordMode, data);
        await db.update(
          'tbl_letter_batch_employee',
          {
            encryptedPdfPassword: password ? encryptSecret(password) : null,
            pdfKey: null,
            pdfFileName: null,
            sendStatus: 'PENDING',
          },
          'id = ?',
          [emp.id]
        );
        ids.push(emp.id);
      }
      offset += page.length;
      if (page.length < pageSize) break;
    }

    if (!ids.length) {
      throw new AppError('No eligible employees to generate. Resolve blocked rows first.', 400);
    }

    await orgScope.update(
      organizationId,
      'tbl_letter_batch',
      {
        status: 'GENERATING',
        passwordMode,
        approvedAt: new Date(),
        generatedCount: 0,
        failedCount: 0,
      },
      'id = ?',
      [batchId]
    );

    await writeLetterAudit(organizationId, userId, 'BATCH_GENERATE_APPROVED', 'letter_batch', batchId, {
      eligible: ids.length,
      passwordMode,
      // Explicitly do not include any passwords
    });

    const chunkSize = 25;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      await enqueueLetterGenerate(
        {
          batchId,
          organizationId,
          employeeIds: chunk,
          passwordMode,
          userId,
        },
        Math.floor(i / chunkSize)
      );
    }

    return {
      batch: await batchService.get(organizationId, batchId),
      queued: ids.length,
      chunks: Math.ceil(ids.length / chunkSize),
    };
  },

  /** Re-queue only rows that failed PDF generation (null pdfKey + FAILED). */
  async retryFailedOnly(organizationId: string, userId: string, batchId: string) {
    const batch = await batchService.get(organizationId, batchId);
    if (batch.status === 'GENERATING') {
      throw new AppError('Generation is already in progress for this batch', 409);
    }

    const employees = await db.queryAll<any>(
      `SELECT id FROM tbl_letter_batch_employee
        WHERE batchId = ?
          AND validationStatus IN ('READY', 'WARNING')
          AND (pdfKey IS NULL OR pdfKey = '')
          AND sendStatus = 'FAILED'
        ORDER BY rowIndex ASC`,
      [batchId]
    );

    if (!employees.length) {
      throw new AppError('No failed letters to retry.', 400);
    }

    for (const emp of employees) {
      await db.update(
        'tbl_letter_batch_employee',
        { sendStatus: 'PENDING', pdfKey: null, pdfFileName: null },
        'id = ?',
        [emp.id]
      );
    }

    const passwordMode = (batch.passwordMode || 'NONE') as
      | 'NONE'
      | 'FROM_COLUMN'
      | 'EMPLOYEE_ID'
      | 'LAST4_ID';

    await orgScope.update(
      organizationId,
      'tbl_letter_batch',
      {
        status: 'GENERATING',
        // Keep prior successes; only recount failures after this run
      },
      'id = ?',
      [batchId]
    );

    await writeLetterAudit(organizationId, userId, 'BATCH_GENERATE_RETRY_FAILED', 'letter_batch', batchId, {
      retryCount: employees.length,
    });

    const chunkSize = 25;
    const ids = employees.map((e: any) => e.id as string);
    for (let i = 0; i < ids.length; i += chunkSize) {
      await enqueueLetterGenerate(
        {
          batchId,
          organizationId,
          employeeIds: ids.slice(i, i + chunkSize),
          passwordMode,
          userId,
        },
        Math.floor(i / chunkSize)
      );
    }

    return {
      batch: await batchService.get(organizationId, batchId),
      queued: ids.length,
    };
  },

  async progress(organizationId: string, batchId: string) {
    const batch = await batchService.get(organizationId, batchId);
    // Avoid reserved MySQL aliases (GENERATED is reserved in MySQL 8+)
    const counts = await db.queryAll<any>(
      `SELECT
         SUM(CASE WHEN pdfKey IS NOT NULL AND pdfKey <> '' THEN 1 ELSE 0 END) AS generatedCount,
         SUM(CASE WHEN validationStatus = 'BLOCKED' THEN 1 ELSE 0 END) AS skippedCount,
         SUM(CASE WHEN validationStatus IN ('READY','WARNING')
                   AND (pdfKey IS NULL OR pdfKey = '')
                   AND IFNULL(sendStatus, 'PENDING') <> 'FAILED' THEN 1 ELSE 0 END) AS pendingCount,
         SUM(CASE WHEN sendStatus = 'SENT' THEN 1 ELSE 0 END) AS sentCount,
         SUM(CASE WHEN sendStatus = 'FAILED' THEN 1 ELSE 0 END) AS sendFailedCount
       FROM tbl_letter_batch_employee WHERE batchId = ?`,
      [batchId]
    );
    const row = counts[0] || {};
    const generated = Number(row.generatedCount || 0);
    let pending = Number(row.pendingCount || 0);
    const failed = Number(batch.failedCount || 0);
    const inFlight = ['GENERATING', 'GENERATED', 'SENDING', 'SENT'].includes(
      String(batch.status || '')
    );

    // Not generating yet — don't report "pending" rows (that confuses the UI into polling forever)
    if (!inFlight) {
      return {
        status: batch.status,
        generated,
        skipped: Number(row.skippedCount || 0),
        pending: 0,
        sent: Number(row.sentCount || 0),
        sendFailed: Number(row.sendFailedCount || 0),
        failed,
        totalRows: Number(batch.totalRows || 0),
        aiSummary: batch.aiSummary,
        lastError: null,
        failedEmployees: [],
      };
    }

    // Heal stuck batches from before failures were marked on rows:
    // all attempts failed, nothing uploaded, still showing as pending forever.
    if (
      batch.status === 'GENERATING' &&
      generated === 0 &&
      failed > 0 &&
      pending > 0 &&
      failed >= pending
    ) {
      pending = 0;
      await orgScope.update(
        organizationId,
        'tbl_letter_batch',
        { status: 'GENERATED', generatedAt: new Date() },
        'id = ?',
        [batchId]
      );
    }

    const status =
      pending === 0 && batch.status === 'GENERATING' ? 'GENERATED' : batch.status;

    // Surface a sample generation error for the UI (plain language)
    let lastError: string | null = null;
    let failedEmployees: Array<{ id: string; name: string; message: string }> = [];
    if (failed > 0) {
      const errRows = await db.queryAll<any>(
        `SELECT id, employeeDataJson, anomalyFlagsJson FROM tbl_letter_batch_employee
          WHERE batchId = ? AND sendStatus = 'FAILED'
            AND (pdfKey IS NULL OR pdfKey = '')
          ORDER BY rowIndex ASC LIMIT 20`,
        [batchId]
      );
      failedEmployees = errRows.map((r: any) => {
        const data =
          typeof r.employeeDataJson === 'string'
            ? JSON.parse(r.employeeDataJson || '{}')
            : r.employeeDataJson || {};
        const flags =
          typeof r.anomalyFlagsJson === 'string'
            ? JSON.parse(r.anomalyFlagsJson || '[]')
            : r.anomalyFlagsJson || [];
        const genErr = (flags as any[]).find((f) => f.code === 'GENERATION_FAILED');
        let message = String(genErr?.message || 'Letter PDF could not be created');
        if (/chrome|chromium|puppeteer|executable/i.test(message)) {
          message =
            'The letter printer on the server is not ready. Please try again in a few minutes, or contact support.';
        }
        return {
          id: r.id,
          name: String(data.Employee_Name || data.Employee_ID || 'Employee'),
          message,
        };
      });
      if (generated === 0) {
        lastError =
          failedEmployees[0]?.message ||
          'PDF creation failed. Please try again, or contact support if it keeps happening.';
      }
    }

    return {
      status,
      generated,
      skipped: Number(row.skippedCount || 0),
      pending,
      sent: Number(row.sentCount || 0),
      sendFailed: Number(row.sendFailedCount || 0),
      failed,
      totalRows: Number(batch.totalRows || 0),
      aiSummary: batch.aiSummary,
      lastError,
      failedEmployees,
    };
  },
};
