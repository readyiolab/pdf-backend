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
    const employees = await db.queryAll<any>(
      `SELECT * FROM tbl_letter_batch_employee
        WHERE batchId = ? AND validationStatus IN ('READY', 'WARNING')
        ORDER BY rowIndex ASC`,
      [batchId]
    );
    if (!employees.length) {
      throw new AppError('No ready/warning rows to preview. Fix blocked rows first.', 400);
    }

    const first = employees[0];
    const mid = employees[Math.floor(employees.length / 2)];
    const last = employees[employees.length - 1];

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
        middle: pick(mid),
        last: pick(last),
      },
      eligibleCount: employees.length,
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

    const employees = await db.queryAll<any>(
      `SELECT id, employeeDataJson FROM tbl_letter_batch_employee
        WHERE batchId = ? AND validationStatus IN ('READY', 'WARNING')
        ORDER BY rowIndex ASC`,
      [batchId]
    );

    if (!employees.length) {
      throw new AppError('No eligible employees to generate. Resolve blocked rows first.', 400);
    }

    // Encrypt passwords at rest when present — never log them
    if (passwordMode !== 'NONE' && !isSecretBoxConfigured()) {
      throw new AppError(
        'Server is missing INFRA_CREDENTIALS_KEY — cannot store PDF passwords securely.',
        503
      );
    }

    for (const emp of employees) {
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
      eligible: employees.length,
      passwordMode,
      // Explicitly do not include any passwords
    });

    const chunkSize = 25;
    const ids = employees.map((e: any) => e.id as string);
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

    // Surface a sample generation error for the UI
    let lastError: string | null = null;
    if (failed > 0 && generated === 0) {
      const errRows = await db.queryAll<any>(
        `SELECT anomalyFlagsJson FROM tbl_letter_batch_employee
          WHERE batchId = ? AND sendStatus = 'FAILED' LIMIT 1`,
        [batchId]
      );
      const flags =
        typeof errRows[0]?.anomalyFlagsJson === 'string'
          ? JSON.parse(errRows[0].anomalyFlagsJson || '[]')
          : errRows[0]?.anomalyFlagsJson || [];
      const genErr = (flags as any[]).find((f) => f.code === 'GENERATION_FAILED');
      lastError =
        genErr?.message ||
        'PDF creation failed on the server. Ask your admin to check Chromium/Puppeteer and storage logs.';
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
    };
  },
};
