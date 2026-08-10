import crypto from 'crypto';
import * as XLSX from 'xlsx';
import { db } from '../../lib/mysql';
import { AppError } from '../../middleware/errorHandler.middleware';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { writeLetterAudit } from '../orgs/orgs.service';
import { orgScope } from './orgScope';
import { SYSTEM_FIELDS, REQUIRED_FIELDS_BY_TYPE, type LetterType, type SystemField } from './letterFields';
import { templateService } from './brandTemplate.service';

function newId() {
  return crypto.randomUUID();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const batchService = {
  async list(organizationId: string) {
    const rows = await orgScope.selectAll(
      organizationId,
      'tbl_letter_batch',
      '*',
      '',
      [],
      'ORDER BY createdAt DESC'
    );
    return rows.map(publicBatch);
  },

  async get(organizationId: string, batchId: string) {
    const row = await orgScope.selectOne(organizationId, 'tbl_letter_batch', '*', 'id = ?', [
      batchId,
    ]);
    if (!row) throw new AppError('Batch not found', 404);
    return publicBatch(row);
  },

  async create(
    organizationId: string,
    userId: string,
    input: { templateId: string; brandProfileId?: string | null }
  ) {
    await templateService.get(organizationId, input.templateId);
    if (input.brandProfileId) {
      const brand = await orgScope.selectOne(
        organizationId,
        'tbl_letter_brand_profile',
        'id',
        'id = ?',
        [input.brandProfileId]
      );
      if (!brand) throw new AppError('Brand profile not found', 404);
    }

    const id = newId();
    await db.insert('tbl_letter_batch', {
      id,
      organizationId,
      templateId: input.templateId,
      brandProfileId: input.brandProfileId ?? null,
      status: 'DRAFT',
      createdBy: userId,
    });
    await writeLetterAudit(organizationId, userId, 'BATCH_CREATED', 'letter_batch', id, {
      templateId: input.templateId,
    });
    return this.get(organizationId, id);
  },

  /**
   * Parse workbook buffer, return headers + preview. Does not persist rows yet
   * unless createEmployees=true (after mapping).
   */
  parseWorkbook(buffer: Buffer): { headers: string[]; preview: Record<string, unknown>[]; totalRows: number; rows: Record<string, unknown>[] } {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new AppError('Spreadsheet has no sheets', 400);
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
      raw: false,
    });
    if (!rows.length) throw new AppError('Spreadsheet has no data rows', 400);
    const headers = Object.keys(rows[0]);
    return {
      headers,
      preview: rows.slice(0, 10),
      totalRows: rows.length,
      rows,
    };
  },

  async attachSource(
    organizationId: string,
    userId: string,
    batchId: string,
    input: { sourceFileKey: string; sourceFileName: string; headers: string[]; preview: unknown[] }
  ) {
    await this.get(organizationId, batchId);
    await orgScope.update(
      organizationId,
      'tbl_letter_batch',
      {
        sourceFileKey: input.sourceFileKey,
        sourceFileName: input.sourceFileName,
        status: 'IMPORTED',
        columnMappingJson: JSON.stringify({ headers: input.headers, preview: input.preview }),
      },
      'id = ?',
      [batchId]
    );
    await writeLetterAudit(organizationId, userId, 'BATCH_IMPORT_ATTACHED', 'letter_batch', batchId, {
      sourceFileName: input.sourceFileName,
      headers: input.headers,
    });
    return this.get(organizationId, batchId);
  },

  async applyMappingAndRows(
    organizationId: string,
    userId: string,
    batchId: string,
    plan: 'FREE' | 'PRO' | 'ENTERPRISE',
    mapping: Record<string, string>,
    rawRows: Record<string, unknown>[]
  ) {
    const batch = await this.get(organizationId, batchId);
    const limits = PLAN_LIMITS[plan];
    if (rawRows.length > limits.maxLetterBatchRows) {
      throw new AppError(
        `Your plan allows up to ${limits.maxLetterBatchRows} rows per batch. Upgrade to process more.`,
        403
      );
    }

    // Clear previous employees
    await db.execute('DELETE FROM tbl_letter_batch_employee WHERE batchId = ?', [batchId]);

    const mappedRows = rawRows.map((row, index) => {
      const data: Record<string, string> = {};
      for (const [excelCol, systemField] of Object.entries(mapping)) {
        if (!systemField) continue;
        const val = row[excelCol];
        data[systemField] = val == null ? '' : String(val).trim();
      }
      return { rowIndex: index, data };
    });

    // Bulk insert in chunks
    const chunkSize = 100;
    for (let i = 0; i < mappedRows.length; i += chunkSize) {
      const chunk = mappedRows.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(',');
      const params: unknown[] = [];
      for (const r of chunk) {
        params.push(
          newId(),
          batchId,
          r.rowIndex,
          JSON.stringify(r.data),
          'PENDING',
          'PENDING'
        );
      }
      await db.insertAll(
        `INSERT INTO tbl_letter_batch_employee
          (id, batchId, rowIndex, employeeDataJson, validationStatus, sendStatus)
         VALUES ${placeholders}`,
        params
      );
    }

    await orgScope.update(
      organizationId,
      'tbl_letter_batch',
      {
        columnMappingJson: JSON.stringify(mapping),
        totalRows: mappedRows.length,
        status: 'MAPPED',
        readyCount: 0,
        warningCount: 0,
        blockedCount: 0,
      },
      'id = ?',
      [batchId]
    );

    await writeLetterAudit(organizationId, userId, 'BATCH_MAPPED', 'letter_batch', batchId, {
      totalRows: mappedRows.length,
      mapping,
    });

    return {
      batch: await this.get(organizationId, batchId),
      preview: mappedRows.slice(0, 10).map((r) => r.data),
    };
  },

  async listEmployees(
    organizationId: string,
    batchId: string,
    opts: { validationStatus?: string; sendStatus?: string; limit?: number; offset?: number } = {}
  ) {
    await this.get(organizationId, batchId);
    const where: string[] = ['batchId = ?'];
    const params: unknown[] = [batchId];
    if (opts.validationStatus) {
      where.push('validationStatus = ?');
      params.push(opts.validationStatus);
    }
    if (opts.sendStatus) {
      where.push('sendStatus = ?');
      params.push(opts.sendStatus);
    }
    const limit = Math.min(opts.limit ?? 100, 500);
    const offset = opts.offset ?? 0;
    const rows = await db.queryAll<any>(
      `SELECT * FROM tbl_letter_batch_employee
        WHERE ${where.join(' AND ')}
        ORDER BY rowIndex ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return rows.map(publicEmployee);
  },

  async validate(
    organizationId: string,
    userId: string,
    batchId: string,
    opts: { sendModeSelected?: boolean } = {}
  ) {
    const batch = await this.get(organizationId, batchId);
    const template = batch.templateId
      ? await templateService.get(organizationId, batch.templateId)
      : null;

    const employees = await db.queryAll<any>(
      `SELECT * FROM tbl_letter_batch_employee WHERE batchId = ? ORDER BY rowIndex ASC`,
      [batchId]
    );
    if (!employees.length) throw new AppError('No employees in batch. Map your Excel first.', 400);

    const templateTokens = (template?.fieldTokens || []) as string[];
    const requiredExtra = template
      ? REQUIRED_FIELDS_BY_TYPE[template.type as LetterType] || []
      : [];

    const idCounts = new Map<string, number>();
    for (const emp of employees) {
      const data = parseJson<Record<string, string>>(emp.employeeDataJson, {});
      const id = (data.Employee_ID || '').trim();
      if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
    }

    let ready = 0;
    let warning = 0;
    let blocked = 0;

    for (const emp of employees) {
      const data = parseJson<Record<string, string>>(emp.employeeDataJson, {});
      const errors: Array<{ code: string; severity: 'BLOCKED' | 'WARNING'; message: string; field?: string }> =
        [];

      const empId = (data.Employee_ID || '').trim();
      const empName = (data.Employee_Name || '').trim();
      const email = (data.Employee_Email || '').trim();

      if (!empId) {
        errors.push({
          code: 'BLANK_EMPLOYEE_ID',
          severity: 'BLOCKED',
          message: 'Employee_ID is blank',
          field: 'Employee_ID',
        });
      } else if ((idCounts.get(empId) || 0) > 1) {
        errors.push({
          code: 'DUPLICATE_EMPLOYEE_ID',
          severity: 'BLOCKED',
          message: `Duplicate Employee_ID: ${empId}`,
          field: 'Employee_ID',
        });
      }

      if (!empName) {
        errors.push({
          code: 'BLANK_EMPLOYEE_NAME',
          severity: 'BLOCKED',
          message: 'Employee_Name is blank',
          field: 'Employee_Name',
        });
      }

      if (email && !EMAIL_RE.test(email)) {
        errors.push({
          code: 'INVALID_EMAIL',
          severity: 'BLOCKED',
          message: 'Employee_Email format is invalid',
          field: 'Employee_Email',
        });
      }

      if (opts.sendModeSelected && !email) {
        errors.push({
          code: 'EMAIL_REQUIRED_FOR_SEND',
          severity: 'BLOCKED',
          message: 'Employee_Email is required when send mode is selected',
          field: 'Employee_Email',
        });
      }

      for (const token of templateTokens) {
        if (token === 'PDF_Password') continue;
        if (!(token in data) || String(data[token] ?? '').trim() === '') {
          // Only block if it's a required field for the template type or a core identity field
          if (
            requiredExtra.includes(token as SystemField) ||
            token === 'Employee_ID' ||
            token === 'Employee_Name'
          ) {
            errors.push({
              code: 'MISSING_TEMPLATE_FIELD',
              severity: 'BLOCKED',
              message: `Template field ${token} is missing or blank`,
              field: token,
            });
          }
        }
      }

      if (template && (template.type === 'INCREMENT' || template.type === 'SALARY_REVISION')) {
        const newCtc = String(data.New_CTC ?? '').trim();
        const num = Number(String(newCtc).replace(/,/g, ''));
        if (!newCtc || !Number.isFinite(num) || num <= 0) {
          errors.push({
            code: 'INVALID_NEW_CTC',
            severity: 'BLOCKED',
            message: 'New_CTC is blank, zero, or non-numeric',
            field: 'New_CTC',
          });
        }
      }

      if (
        template &&
        requiredExtra.includes('Effective_Date') &&
        !String(data.Effective_Date ?? '').trim()
      ) {
        errors.push({
          code: 'BLANK_EFFECTIVE_DATE',
          severity: 'BLOCKED',
          message: 'Effective_Date is blank',
          field: 'Effective_Date',
        });
      }

      if (!String(data.Old_CTC ?? '').trim() && template?.type === 'INCREMENT') {
        errors.push({
          code: 'BLANK_OLD_CTC',
          severity: 'WARNING',
          message: 'Old_CTC is blank',
          field: 'Old_CTC',
        });
      }

      if (!String(data.PDF_Password ?? '').trim()) {
        errors.push({
          code: 'BLANK_PDF_PASSWORD',
          severity: 'WARNING',
          message: 'PDF_Password is blank (will use password mode rule if set)',
          field: 'PDF_Password',
        });
      }

      const hasBlocked = errors.some((e) => e.severity === 'BLOCKED');
      const hasWarning = errors.some((e) => e.severity === 'WARNING');
      let status: 'READY' | 'WARNING' | 'BLOCKED' = 'READY';
      if (hasBlocked) {
        status = 'BLOCKED';
        blocked += 1;
      } else if (hasWarning) {
        status = 'WARNING';
        warning += 1;
      } else {
        ready += 1;
      }

      await db.update(
        'tbl_letter_batch_employee',
        {
          validationStatus: status,
          validationErrorsJson: JSON.stringify(errors),
        },
        'id = ?',
        [emp.id]
      );
    }

    await orgScope.update(
      organizationId,
      'tbl_letter_batch',
      {
        status: 'VALIDATED',
        readyCount: ready,
        warningCount: warning,
        blockedCount: blocked,
      },
      'id = ?',
      [batchId]
    );

    await writeLetterAudit(organizationId, userId, 'BATCH_VALIDATED', 'letter_batch', batchId, {
      ready,
      warning,
      blocked,
    });

    return {
      batch: await this.get(organizationId, batchId),
      summary: { ready, warning, blocked, total: employees.length },
    };
  },

  async validationIssues(organizationId: string, batchId: string) {
    await this.get(organizationId, batchId);
    const rows = await db.queryAll<any>(
      `SELECT id, rowIndex, employeeDataJson, validationStatus, validationErrorsJson, anomalyFlagsJson
         FROM tbl_letter_batch_employee
        WHERE batchId = ? AND validationStatus IN ('WARNING', 'BLOCKED')
        ORDER BY rowIndex ASC`,
      [batchId]
    );
    return rows.map((r) => ({
      id: r.id,
      rowIndex: r.rowIndex,
      validationStatus: r.validationStatus,
      employee: parseJson(r.employeeDataJson, {}),
      errors: parseJson(r.validationErrorsJson, []),
      anomalies: parseJson(r.anomalyFlagsJson, []),
    }));
  },

  systemFields: SYSTEM_FIELDS,
};

function publicBatch(row: any) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    templateId: row.templateId,
    brandProfileId: row.brandProfileId,
    status: row.status,
    totalRows: row.totalRows,
    readyCount: row.readyCount,
    warningCount: row.warningCount,
    blockedCount: row.blockedCount,
    generatedCount: row.generatedCount,
    failedCount: row.failedCount,
    sentCount: row.sentCount,
    columnMapping: parseJson(row.columnMappingJson, null),
    sourceFileKey: row.sourceFileKey,
    sourceFileName: row.sourceFileName,
    passwordMode: row.passwordMode,
    sendMode: row.sendMode,
    aiSummary: row.aiSummary,
    retentionDays: row.retentionDays,
    createdBy: row.createdBy,
    approvedAt: row.approvedAt,
    generatedAt: row.generatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicEmployee(row: any) {
  const data = parseJson<Record<string, string>>(row.employeeDataJson, {});
  // Never expose PDF password in API responses
  const { PDF_Password: _pw, ...safe } = data;
  return {
    id: row.id,
    batchId: row.batchId,
    rowIndex: row.rowIndex,
    employeeData: safe,
    hasPdfPassword: Boolean(_pw && String(_pw).trim()),
    validationStatus: row.validationStatus,
    validationErrors: parseJson(row.validationErrorsJson, []),
    anomalyFlags: parseJson(row.anomalyFlagsJson, []),
    pdfKey: row.pdfKey,
    pdfFileName: row.pdfFileName,
    sendStatus: row.sendStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
