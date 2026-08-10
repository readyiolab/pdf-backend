import { Worker, Job } from 'bullmq';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { redis } from './redis';
import { db } from './mysql';
import { logger } from './logger';
import { decryptSecret } from './secretBox';
import { LETTER_GENERATE_QUEUE, LETTER_SEND_QUEUE } from '../../../shared/constants';
import type { LetterGenerateJob, LetterSendJob } from './letterQueues';
import { buildLetterHtml, safePdfFileName } from '../modules/letters/letterRender';
import { getStorageForUser } from './storage';
import { env } from '../config/env';

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

async function renderPdfWithPuppeteer(html: string, outPath: string): Promise<void> {
  // Dynamic import so API still boots if puppeteer isn't installed yet
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });
  } finally {
    await browser.close();
  }
}

async function encryptPdfWithQpdf(inputPath: string, outputPath: string, userPassword: string) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  // Never log the password
  await execFileAsync('qpdf', [
    '--encrypt',
    userPassword,
    userPassword,
    '256',
    '--',
    inputPath,
    outputPath,
  ]);
}

async function processGenerateChunk(job: Job<LetterGenerateJob>) {
  const { batchId, organizationId, employeeIds, userId } = job.data;
  const batch = await db.select('tbl_letter_batch', '*', 'id = ? AND organizationId = ?', [
    batchId,
    organizationId,
  ]);
  if (!batch) {
    logger.warn({ batchId, organizationId }, 'Letter generate: batch not found');
    return;
  }

  const template = batch.templateId
    ? await db.select('tbl_letter_template', '*', 'id = ?', [batch.templateId])
    : null;
  const brand = batch.brandProfileId
    ? await db.select('tbl_letter_brand_profile', '*', 'id = ?', [batch.brandProfileId])
    : null;

  const { storage, keyPrefix } = await getStorageForUser(userId);

  let logoUrl: string | null = null;
  let letterheadUrl: string | null = null;
  try {
    if (brand?.logoKey) logoUrl = await storage.presignGet(brand.logoKey, { ttlSeconds: 600 });
    if (brand?.letterheadKey)
      letterheadUrl = await storage.presignGet(brand.letterheadKey, { ttlSeconds: 600 });
  } catch {
    /* optional assets */
  }

  const contentJson = parseJson(template?.contentJson, { type: 'doc', content: [] });
  const templateType = template?.type || 'LETTER';

  let generated = 0;
  let failed = 0;

  for (const employeeId of employeeIds) {
    const emp = await db.select('tbl_letter_batch_employee', '*', 'id = ? AND batchId = ?', [
      employeeId,
      batchId,
    ]);
    if (!emp) continue;
    if (!['READY', 'WARNING'].includes(emp.validationStatus)) continue;

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'letter-'));
    const plainPath = path.join(tmpDir, 'plain.pdf');
    const finalPath = path.join(tmpDir, 'final.pdf');

    try {
      const data = parseJson<Record<string, string>>(emp.employeeDataJson, {});
      const html = buildLetterHtml({
        contentJson,
        employeeData: data,
        brand: brand
          ? {
              footerText: brand.footerText,
              signatoryName: brand.signatoryName,
              signatoryDesignation: brand.signatoryDesignation,
              defaultFont: brand.defaultFont,
              logoUrl,
              letterheadUrl,
            }
          : undefined,
      });

      await renderPdfWithPuppeteer(html, plainPath);

      let uploadPath = plainPath;
      if (emp.encryptedPdfPassword) {
        try {
          const password = decryptSecret(emp.encryptedPdfPassword);
          await encryptPdfWithQpdf(plainPath, finalPath, password);
          uploadPath = finalPath;
        } catch (err) {
          logger.error(
            { employeeId, err: (err as Error).message },
            'Letter PDF password protect failed; uploading unprotected'
          );
        }
      }

      const fileName = safePdfFileName(
        data.Employee_ID || 'unknown',
        data.Employee_Name || 'employee',
        templateType
      );
      const pdfKey = `${keyPrefix}/letters/${batchId}/${fileName}`;
      const bytes = await fs.readFile(uploadPath);

      if (typeof (storage as any).putObject === 'function') {
        await (storage as any).putObject(pdfKey, bytes, 'application/pdf');
      } else if (typeof (storage as any).upload === 'function') {
        await (storage as any).upload(pdfKey, bytes, 'application/pdf');
      } else {
        const putUrl = await storage.presignPut(pdfKey, 'application/pdf', env.PRESIGN_TTL_SECONDS);
        const resp = await fetch(putUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/pdf' },
          body: bytes,
        });
        if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
      }

      await db.update(
        'tbl_letter_batch_employee',
        { pdfKey, pdfFileName: fileName },
        'id = ?',
        [employeeId]
      );
      generated += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        { employeeId, batchId, err: (err as Error).message },
        'Letter PDF generation failed'
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // Update batch counters
  const counts = await db.queryAll<any>(
    `SELECT
       SUM(CASE WHEN pdfKey IS NOT NULL AND pdfKey <> '' THEN 1 ELSE 0 END) AS generatedCount,
       SUM(CASE WHEN validationStatus IN ('READY','WARNING') AND (pdfKey IS NULL OR pdfKey = '') THEN 1 ELSE 0 END) AS pending
     FROM tbl_letter_batch_employee WHERE batchId = ?`,
    [batchId]
  );
  const generatedCount = Number(counts[0]?.generatedCount || 0);
  const pending = Number(counts[0]?.pending || 0);
  const prevFailed = Number(batch.failedCount || 0);

  await db.update(
    'tbl_letter_batch',
    {
      generatedCount,
      failedCount: prevFailed + failed,
      status: pending === 0 ? 'GENERATED' : 'GENERATING',
      generatedAt: pending === 0 ? new Date() : batch.generatedAt,
    },
    'id = ?',
    [batchId]
  );

  logger.info({ batchId, generated, failed, pending }, 'Letter generate chunk complete');
}

async function processSendChunk(job: Job<LetterSendJob>) {
  const { batchId, organizationId, employeeIds, mode, subject, bodyHtml, userId, mailAccountId } =
    job.data;

  const account = await db.select('tbl_user_mail_account', '*', 'id = ? AND userId = ?', [
    mailAccountId,
    userId,
  ]);
  if (!account) {
    logger.warn({ mailAccountId }, 'Mail account missing for letter send');
    return;
  }

  const { decryptJson } = await import('./secretBox.js');
  const tokens = decryptJson(account.encryptedTokens) as Record<string, any>;
  const { storage } = await getStorageForUser(userId);

  let sent = 0;
  for (const employeeId of employeeIds) {
    const emp = await db.select('tbl_letter_batch_employee', '*', 'id = ? AND batchId = ?', [
      employeeId,
      batchId,
    ]);
    if (!emp?.pdfKey) continue;
    const data = parseJson<Record<string, string>>(emp.employeeDataJson, {});
    const to = String(data.Employee_Email || '').trim();
    if (!to) {
      await db.update('tbl_letter_batch_employee', { sendStatus: 'SKIPPED' }, 'id = ?', [
        employeeId,
      ]);
      continue;
    }

    try {
      // Download PDF bytes
      const url = await storage.presignGet(emp.pdfKey, { ttlSeconds: 300 });
      const pdfResp = await fetch(url);
      if (!pdfResp.ok) throw new Error('Failed to download PDF for email');
      const pdfBytes = Buffer.from(await pdfResp.arrayBuffer());
      const pdfBase64 = pdfBytes.toString('base64');
      const fileName = emp.pdfFileName || 'letter.pdf';

      if (account.provider === 'OUTLOOK') {
        await sendViaGraph(tokens, {
          to,
          subject,
          bodyHtml,
          pdfBase64,
          fileName,
          asDraft: mode === 'CREATE_DRAFTS',
        });
      } else {
        await sendViaGmail(tokens, {
          to,
          subject,
          bodyHtml,
          pdfBase64,
          fileName,
          asDraft: mode === 'CREATE_DRAFTS',
        });
      }

      const status = mode === 'CREATE_DRAFTS' ? 'DRAFT_CREATED' : 'SENT';
      await db.update('tbl_letter_batch_employee', { sendStatus: status }, 'id = ?', [employeeId]);
      await db.insert('tbl_letter_send_log', {
        id: cryptoRandomId(),
        batchEmployeeId: employeeId,
        channel: account.provider,
        status,
        errorMessage: null,
        sentAt: mode === 'SEND_NOW' ? new Date() : null,
      });
      sent += 1;
    } catch (err) {
      await db.update('tbl_letter_batch_employee', { sendStatus: 'FAILED' }, 'id = ?', [
        employeeId,
      ]);
      await db.insert('tbl_letter_send_log', {
        id: cryptoRandomId(),
        batchEmployeeId: employeeId,
        channel: account.provider,
        status: 'FAILED',
        errorMessage: (err as Error).message,
        sentAt: null,
      });
      logger.error({ employeeId, err: (err as Error).message }, 'Letter send failed');
    }
  }

  const sentCountRow = await db.queryAll<any>(
    `SELECT COUNT(*) AS cnt FROM tbl_letter_batch_employee
      WHERE batchId = ? AND sendStatus IN ('SENT', 'DRAFT_CREATED')`,
    [batchId]
  );
  await db.update(
    'tbl_letter_batch',
    {
      sentCount: Number(sentCountRow[0]?.cnt || 0),
      status: 'SENT',
    },
    'id = ? AND organizationId = ?',
    [batchId, organizationId]
  );

  logger.info({ batchId, sent, mode }, 'Letter send chunk complete');
}

async function sendViaGraph(
  tokens: Record<string, any>,
  msg: {
    to: string;
    subject: string;
    bodyHtml: string;
    pdfBase64: string;
    fileName: string;
    asDraft: boolean;
  }
) {
  const accessToken = tokens.access_token || tokens.accessToken;
  if (!accessToken) throw new Error('Outlook access token missing');

  const payload = {
    message: {
      subject: msg.subject,
      body: { contentType: 'HTML', content: msg.bodyHtml },
      toRecipients: [{ emailAddress: { address: msg.to } }],
      attachments: [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: msg.fileName,
          contentType: 'application/pdf',
          contentBytes: msg.pdfBase64,
        },
      ],
    },
    saveToSentItems: true,
  };

  if (msg.asDraft) {
    const resp = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload.message),
    });
    if (!resp.ok) throw new Error(`Graph draft failed: ${resp.status} ${await resp.text()}`);
    return;
  }

  const resp = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Graph send failed: ${resp.status} ${await resp.text()}`);
}

async function sendViaGmail(
  tokens: Record<string, any>,
  msg: {
    to: string;
    subject: string;
    bodyHtml: string;
    pdfBase64: string;
    fileName: string;
    asDraft: boolean;
  }
) {
  const accessToken = tokens.access_token || tokens.accessToken;
  if (!accessToken) throw new Error('Gmail access token missing');

  const boundary = 'letter_boundary_' + Date.now();
  const mime = [
    `To: ${msg.to}`,
    `Subject: ${msg.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    msg.bodyHtml,
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${msg.fileName}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${msg.fileName}"`,
    '',
    msg.pdfBase64,
    `--${boundary}--`,
  ].join('\r\n');

  const raw = Buffer.from(mime)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const endpoint = msg.asDraft
    ? 'https://gmail.googleapis.com/gmail/v1/users/me/drafts'
    : 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

  const body = msg.asDraft ? { message: { raw } } : { raw };
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Gmail API failed: ${resp.status} ${await resp.text()}`);
}

function cryptoRandomId() {
  return require('crypto').randomUUID();
}

let generateWorker: Worker | null = null;
let sendWorker: Worker | null = null;

export function startLetterWorkers() {
  generateWorker = new Worker<LetterGenerateJob>(
    LETTER_GENERATE_QUEUE,
    async (job) => processGenerateChunk(job),
    { connection: redis as any, concurrency: 1 }
  );
  sendWorker = new Worker<LetterSendJob>(
    LETTER_SEND_QUEUE,
    async (job) => processSendChunk(job),
    { connection: redis as any, concurrency: 1 }
  );

  generateWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'letter-generate job failed');
  });
  sendWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'letter-send job failed');
  });

  logger.info('Letter Studio workers started (generate + send)');
  return { generateWorker, sendWorker };
}

export async function stopLetterWorkers() {
  await generateWorker?.close();
  await sendWorker?.close();
}
