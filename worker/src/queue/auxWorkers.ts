import { Worker, Job } from 'bullmq';
import archiver from 'archiver';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { redis } from '../lib/redis';
import { db } from '../lib/mysql';
import { logger } from '../lib/logger';
import { LETTER_ZIP_QUEUE, AI_EXTRACT_QUEUE } from '../../../shared/constants';
import { downloadFromS3, uploadToS3, cleanupLocalFile } from '../storage/s3';
import { jobStorageContext } from '../storage/context';
import { PDFParse } from 'pdf-parse';

const AI_TEXT_CACHE_PREFIX = 'ai:pdftext:';
const AI_TEXT_CACHE_TTL = 30 * 60;
const AI_MAX_BYTES = 30 * 1024 * 1024;
const AI_MAX_TEXT_CHARS = 400_000;
const ZIP_STATUS_PREFIX = 'letter:zip:';
const ZIP_STATUS_TTL = 60 * 60;

export interface LetterZipJob {
  zipJobId: string;
  batchId: string;
  organizationId: string;
  userId: string;
  storageBindingId: string | null;
}

export interface AiExtractJob {
  fileKey: string;
  userId: string;
  organizationId: string | null;
  storageBindingId: string | null;
}

async function setZipStatus(
  jobId: string,
  data: Record<string, unknown>
): Promise<void> {
  await redis.set(`${ZIP_STATUS_PREFIX}${jobId}`, JSON.stringify(data), 'EX', ZIP_STATUS_TTL);
}

async function processLetterZip(job: Job<LetterZipJob>): Promise<void> {
  const { zipJobId, batchId, organizationId, userId, storageBindingId } = job.data;

  return jobStorageContext.run(
    { organizationId, storageBindingId },
    async () => {
      await setZipStatus(zipJobId, {
        status: 'PROCESSING',
        batchId,
        organizationId,
        userId,
      });

      const rows = await db.queryAll(
        `SELECT id, pdfKey, pdfFileName FROM tbl_letter_batch_employee
          WHERE batchId = ? AND pdfKey IS NOT NULL AND pdfKey <> ''
          ORDER BY rowIndex ASC`,
        [batchId]
      );

      if (!rows.length) {
        await setZipStatus(zipJobId, {
          status: 'FAILED',
          error: 'No PDFs ready',
          batchId,
          organizationId,
          userId,
        });
        return;
      }

      const tempDir = path.join(process.cwd(), 'temp');
      await fsp.mkdir(tempDir, { recursive: true });
      const zipPath = path.join(tempDir, `letter-zip-${zipJobId}.zip`);
      const localPaths: string[] = [];

      try {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 1 } });
        const done = new Promise<void>((resolve, reject) => {
          output.on('close', () => resolve());
          archive.on('error', reject);
          output.on('error', reject);
        });
        archive.pipe(output);

        const usedNames = new Set<string>();
        const DOWNLOAD_CONCURRENCY = 4;
        let nextIdx = 0;
        const downloaded: { localPath: string; name: string }[] = new Array(rows.length);

        await Promise.all(
          Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, rows.length) }, async () => {
            while (nextIdx < rows.length) {
              const i = nextIdx++;
              const row = rows[i] as any;
              const localPath = await downloadFromS3(String(row.pdfKey));
              localPaths.push(localPath);
              let name = String(row.pdfFileName || `${row.id}.pdf`).replace(/[\\/]/g, '_');
              if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
              if (usedNames.has(name)) name = `${String(row.id).slice(0, 8)}_${name}`;
              usedNames.add(name);
              downloaded[i] = { localPath, name };
            }
          })
        );

        for (const entry of downloaded) {
          if (entry) archive.file(entry.localPath, { name: entry.name });
        }

        await archive.finalize();
        await done;

        const destKey = `pdf-saas-results/letter-zip/${batchId}/${zipJobId}.zip`;
        const zipKey = await uploadToS3(zipPath, destKey, 'application/zip');

        await setZipStatus(zipJobId, {
          status: 'COMPLETED',
          zipKey,
          batchId,
          organizationId,
          userId,
        });
        logger.info({ zipJobId, batchId, zipKey, count: rows.length }, 'Letter ZIP completed');
      } catch (err: any) {
        logger.error({ zipJobId, err }, 'Letter ZIP failed');
        await setZipStatus(zipJobId, {
          status: 'FAILED',
          error: err?.message || 'ZIP failed',
          batchId,
          organizationId,
          userId,
        });
        throw err;
      } finally {
        localPaths.forEach((p) => cleanupLocalFile(p));
        cleanupLocalFile(zipPath);
      }
    }
  );
}

async function extractPdfTextFromFile(localPath: string): Promise<string> {
  const bytes = await fsp.readFile(localPath);
  if (bytes.length > AI_MAX_BYTES) {
    throw new Error(
      `This PDF is too large for AI processing (max ${Math.floor(AI_MAX_BYTES / 1024 / 1024)}MB).`
    );
  }
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    let text = (result.text ?? '').trim();
    if (!text || text.length < 20) {
      throw new Error(
        'This PDF has little or no extractable text. Run OCR first, then try AI again.'
      );
    }
    if (text.length > AI_MAX_TEXT_CHARS) {
      text =
        text.slice(0, AI_MAX_TEXT_CHARS) +
        '\n\n[Document truncated — too long to process in full.]';
    }
    return text;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function processAiExtract(job: Job<AiExtractJob>): Promise<{ text: string }> {
  const { fileKey, organizationId, storageBindingId } = job.data;

  return jobStorageContext.run(
    { organizationId: organizationId ?? null, storageBindingId: storageBindingId ?? null },
    async () => {
      const cacheKey = `${AI_TEXT_CACHE_PREFIX}${fileKey}`;
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) return { text: cached };

      let localPath = '';
      try {
        localPath = await downloadFromS3(fileKey);
        const text = await extractPdfTextFromFile(localPath);
        await redis.set(cacheKey, text, 'EX', AI_TEXT_CACHE_TTL).catch(() => undefined);
        return { text };
      } finally {
        if (localPath) cleanupLocalFile(localPath);
      }
    }
  );
}

let zipWorker: Worker | null = null;
let aiExtractWorker: Worker | null = null;

export function startLetterZipWorker() {
  zipWorker = new Worker<LetterZipJob>(LETTER_ZIP_QUEUE, processLetterZip, {
    connection: redis as any,
    concurrency: 1,
  });
  zipWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'letter-zip job failed');
  });
  logger.info('Letter ZIP worker started');
  return zipWorker;
}

export function startAiExtractWorker() {
  aiExtractWorker = new Worker<AiExtractJob>(AI_EXTRACT_QUEUE, processAiExtract, {
    connection: redis as any,
    concurrency: 2,
  });
  aiExtractWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'ai-extract job failed');
  });
  logger.info('AI extract worker started');
  return aiExtractWorker;
}

export async function stopAuxWorkers() {
  await zipWorker?.close();
  await aiExtractWorker?.close();
}
