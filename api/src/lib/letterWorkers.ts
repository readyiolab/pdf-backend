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
import { fetchWithTimeout } from './httpFetch';

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let cachedChromePath: string | null | undefined;

/**
 * Puppeteer's own executablePath() only matches the version pinned in
 * package.json, so a `puppeteer browsers install chrome` of any other build is
 * invisible to it. Scan the download cache too before giving up.
 */
function scanPuppeteerCache(dir: string, fsSync: typeof import('fs')): string | undefined {
  let versions: string[];
  try {
    versions = fsSync.readdirSync(path.join(dir, 'chrome'));
  } catch {
    return undefined;
  }
  // Newest build wins
  for (const version of versions.sort().reverse()) {
    for (const platform of ['chrome-linux64', 'chrome-linux', 'chrome-headless-shell-linux64']) {
      const binary = path.join(
        dir,
        'chrome',
        version,
        platform,
        platform.startsWith('chrome-headless-shell') ? 'chrome-headless-shell' : 'chrome'
      );
      try {
        if (fsSync.existsSync(binary)) return binary;
      } catch {
        /* try next */
      }
    }
  }
  return undefined;
}

async function resolveChromeExecutable(): Promise<string | undefined> {
  if (cachedChromePath !== undefined) return cachedChromePath ?? undefined;

  const fsSync = await import('fs');
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    process.env.CHROMIUM_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      if (fsSync.existsSync(p)) {
        cachedChromePath = p;
        return p;
      }
    } catch {
      /* try next */
    }
  }

  try {
    const puppeteer = await import('puppeteer');
    const bundled = await Promise.resolve(puppeteer.executablePath());
    if (bundled && fsSync.existsSync(bundled)) {
      cachedChromePath = bundled;
      return bundled;
    }
  } catch {
    /* ignore */
  }

  const cacheDirs = [
    process.env.PUPPETEER_CACHE_DIR,
    path.join(os.homedir(), '.cache', 'puppeteer'),
    '/root/.cache/puppeteer',
  ].filter(Boolean) as string[];

  for (const dir of cacheDirs) {
    const found = scanPuppeteerCache(dir, fsSync);
    if (found) {
      cachedChromePath = found;
      return found;
    }
  }

  logger.error({ candidates, cacheDirs }, 'No Chrome binary found for letter PDF rendering');
  cachedChromePath = null;
  return undefined;
}

async function launchChromeBrowser() {
  const puppeteer = await import('puppeteer');
  const executablePath = await resolveChromeExecutable();

  logger.info(
    { executablePath: executablePath || '(none)' },
    'Launching Chrome for letter PDF chunk'
  );

  if (!executablePath) {
    throw new Error(
      'Chrome/Chromium not found. Set PUPPETEER_EXECUTABLE_PATH in api/.env to a real chrome binary, or run: npx puppeteer browsers install chrome'
    );
  }

  // Do not race-abandon puppeteer.launch — an orphaned Chrome process would leak.
  // Puppeteer's own launch timeout closes the browser; we still track the handle
  // so a hard outer timeout can force-close if needed.
  let browser: any = null;
  const launchPromise = puppeteer
    .launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--font-render-hinting=none',
      ],
      timeout: 30_000,
    })
    .then((b) => {
      browser = b;
      return b;
    });

  try {
    return await withTimeout(launchPromise, 45_000, 'Chrome launch');
  } catch (err) {
    if (browser) {
      await browser.close().catch(() => undefined);
    } else {
      // Launch may still resolve after our timeout — close when it does.
      void launchPromise
        .then((b) => b.close())
        .catch(() => undefined);
    }
    throw err;
  }
}

async function renderPdfWithBrowser(browser: any, html: string, outPath: string): Promise<void> {
  const page = await browser.newPage();
  try {
    // domcontentloaded — don't wait on remote logo/letterhead images (they hang headless Chrome)
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await withTimeout(
      page.pdf({
        path: outPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      }),
      45_000,
      'page.pdf'
    );
  } finally {
    await page.close().catch(() => undefined);
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
  logger.info(
    { batchId, organizationId, count: employeeIds.length, jobId: job.id },
    'Letter generate chunk started'
  );

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
  let browser: any = null;

  try {
    browser = await launchChromeBrowser();

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

        await renderPdfWithBrowser(browser, html, plainPath);

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
          const putUrl = await storage.presignPut(
            pdfKey,
            'application/pdf',
            env.PRESIGN_TTL_SECONDS
          );
          const resp = await fetchWithTimeout(
            putUrl,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/pdf' },
              body: bytes,
            },
            60_000
          );
          if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
        }

        await db.update(
          'tbl_letter_batch_employee',
          { pdfKey, pdfFileName: fileName, sendStatus: 'PENDING' },
          'id = ?',
          [employeeId]
        );
        generated += 1;
      } catch (err) {
        failed += 1;
        const message = ((err as Error).message || 'PDF generation failed').slice(0, 500);
        logger.error({ employeeId, batchId, err: message }, 'Letter PDF generation failed');
        try {
          const prevFlags = parseJson<Array<{ code: string; message: string }>>(
            emp.anomalyFlagsJson,
            []
          ).filter((f) => f.code !== 'GENERATION_FAILED');
          await db.update(
            'tbl_letter_batch_employee',
            {
              sendStatus: 'FAILED',
              anomalyFlagsJson: JSON.stringify([
                ...prevFlags,
                { code: 'GENERATION_FAILED', message },
              ]),
            },
            'id = ?',
            [employeeId]
          );
        } catch (markErr) {
          logger.error(
            { employeeId, err: (markErr as Error).message },
            'Failed to mark employee generation error'
          );
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } catch (chunkErr) {
    // Browser launch failed — mark every employee in this chunk as failed
    const message = ((chunkErr as Error).message || 'PDF generation failed').slice(0, 500);
    logger.error({ batchId, err: message }, 'Letter generate chunk aborted');
    for (const employeeId of employeeIds) {
      failed += 1;
      try {
        await db.update(
          'tbl_letter_batch_employee',
          {
            sendStatus: 'FAILED',
            anomalyFlagsJson: JSON.stringify([{ code: 'GENERATION_FAILED', message }]),
          },
          'id = ? AND batchId = ? AND (pdfKey IS NULL OR pdfKey = \'\')',
          [employeeId, batchId]
        );
      } catch {
        /* ignore */
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }

  const counts = await db.queryAll<any>(
    `SELECT
       SUM(CASE WHEN pdfKey IS NOT NULL AND pdfKey <> '' THEN 1 ELSE 0 END) AS generatedCount,
       SUM(CASE WHEN validationStatus IN ('READY','WARNING')
                 AND (pdfKey IS NULL OR pdfKey = '')
                 AND IFNULL(sendStatus, 'PENDING') <> 'FAILED' THEN 1 ELSE 0 END) AS pendingCount,
       SUM(CASE WHEN validationStatus IN ('READY','WARNING')
                 AND (pdfKey IS NULL OR pdfKey = '')
                 AND sendStatus = 'FAILED' THEN 1 ELSE 0 END) AS failedCount
     FROM tbl_letter_batch_employee WHERE batchId = ?`,
    [batchId]
  );
  const generatedCount = Number(counts[0]?.generatedCount || 0);
  const pending = Number(counts[0]?.pendingCount || 0);
  const failedCount = Number(counts[0]?.failedCount || 0);

  await db.update(
    'tbl_letter_batch',
    {
      generatedCount,
      failedCount,
      status: pending === 0 ? 'GENERATED' : 'GENERATING',
      generatedAt: pending === 0 ? new Date() : batch.generatedAt,
    },
    'id = ?',
    [batchId]
  );

  logger.info({ batchId, generated, failed, pending, failedCount }, 'Letter generate chunk complete');
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

  const { mailAccountService } = await import('../modules/letters/send.service.js');
  let accessToken: string;
  try {
    accessToken = await mailAccountService.getValidAccessToken({
      id: String(account.id),
      provider: String(account.provider),
      encryptedTokens: String(account.encryptedTokens),
    });
  } catch (err) {
    logger.error(
      { mailAccountId, err: (err as Error).message },
      'Mail account token unavailable'
    );
    return;
  }
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
      const pdfBytes = await storage.getObjectBytes(emp.pdfKey);
      const pdfBase64 = pdfBytes.toString('base64');
      const fileName = emp.pdfFileName || 'letter.pdf';
      const tokens = { access_token: accessToken };

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
    const resp = await fetchWithTimeout(
      'https://graph.microsoft.com/v1.0/me/messages',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload.message),
      },
      30_000
    );
    if (!resp.ok) throw new Error(`Graph draft failed: ${resp.status} ${await resp.text()}`);
    return;
  }

  const resp = await fetchWithTimeout(
    'https://graph.microsoft.com/v1.0/me/sendMail',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    30_000
  );
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
  const resp = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    30_000
  );
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
    { connection: redis as any, concurrency: 2 }
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
