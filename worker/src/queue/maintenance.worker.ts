import { Queue, Worker, Job } from 'bullmq';
import crypto from 'crypto';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { db } from '../lib/mysql';
import { deleteFromS3 } from '../storage/s3';
import { env } from '../config/env';
import { MAINTENANCE_QUEUE } from '../../../shared/constants';

import { runByocHealthSweep } from './byocHealth';

const CLEANUP_JOB = 'cleanup-expired';
const BYOC_HEALTH_JOB = 'byoc-health';

/**
 * Deletes expired jobs and their input/output files. Runs on a BullMQ repeatable
 * schedule (replacing the API's setInterval) so it executes once across the whole
 * cluster, survives restarts, and can be observed/retried like any other job.
 */
async function cleanupExpired(): Promise<void> {
  const now = new Date();

  const expired = await db.queryAll(
    'SELECT id, inputFiles, outputFile, storageBindingId FROM tbl_job WHERE expiresAt < ? LIMIT 1000',
    [now]
  );

  if (!expired.length) return;

  const byBinding = new Map<string | null, string[]>();
  for (const job of expired) {
    const keys: string[] = [];
    try {
      const inputs =
        typeof job.inputFiles === 'string' ? JSON.parse(job.inputFiles) : job.inputFiles;
      if (Array.isArray(inputs)) keys.push(...inputs);
    } catch {
      /* ignore malformed inputFiles */
    }
    if (job.outputFile) keys.push(job.outputFile);
    const bid = (job.storageBindingId as string) || null;
    const list = byBinding.get(bid) ?? [];
    list.push(...keys);
    byBinding.set(bid, list);
  }

  // deleteFromS3 uses ALS binding when set; fall back to key-prefix grouping via null ALS
  for (const [, keys] of byBinding) {
    await deleteFromS3(keys);
  }

  const ids = expired.map((j: any) => j.id as string);
  const placeholders = ids.map(() => '?').join(',');
  const del = await db.execute(`DELETE FROM tbl_job WHERE id IN (${placeholders})`, ids);
  let deletedFiles = 0;
  for (const keys of byBinding.values()) deletedFiles += keys.length;
  logger.info(
    { deletedJobs: del.affectedRows, deletedFiles },
    'Maintenance: cleaned up expired jobs'
  );
}

/**
 * Fails jobs left in PROCESSING far longer than any job should take — the
 * signature of a worker that crashed mid-job without BullMQ recovering it.
 */
async function reapStalledJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - env.STALE_JOB_MINUTES * 60 * 1000);
  const res = await db.execute(
    `UPDATE tbl_job
        SET status = 'FAILED', errorMessage = 'Processing stalled and was terminated', completedAt = ?
      WHERE status = 'PROCESSING' AND createdAt < ?`,
    [new Date(), cutoff]
  );
  if (res.affectedRows > 0) {
    logger.warn({ count: res.affectedRows }, 'Maintenance: reaped stalled PROCESSING jobs');
  }
}

/**
 * Flips past-deadline SENT signing documents to EXPIRED and writes audit rows.
 * Business expiry only — never deletes the sealed PDF or audit trail.
 */
async function expireSignDocuments(): Promise<void> {
  const now = new Date();
  const rows = await db.queryAll(
    `SELECT id FROM tbl_sign_document
      WHERE status = 'SENT' AND expiresAt IS NOT NULL AND expiresAt < ?
      ORDER BY expiresAt ASC
      LIMIT 500`,
    [now]
  );
  if (!rows.length) return;

  const ids = rows.map((r: any) => r.id as string);
  const placeholders = ids.map(() => '?').join(',');
  const upd = await db.execute(
    `UPDATE tbl_sign_document SET status = 'EXPIRED'
      WHERE status = 'SENT' AND id IN (${placeholders})`,
    ids
  );
  if (upd.affectedRows === 0) return;

  const expired = await db.queryAll(
    `SELECT id FROM tbl_sign_document WHERE status = 'EXPIRED' AND id IN (${placeholders})`,
    ids
  );

  for (const row of expired) {
    try {
      await db.insert('tbl_sign_audit', {
        id: crypto.randomUUID(),
        documentId: row.id,
        action: 'DOCUMENT_EXPIRED',
        detail: 'Signing deadline passed',
      });
    } catch (err) {
      logger.error({ err, documentId: row.id }, 'Maintenance: failed to write DOCUMENT_EXPIRED audit');
    }
  }

  logger.info({ count: expired.length }, 'Maintenance: expired signing documents');
}

export async function startMaintenanceWorker() {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection: redis as any });

  await queue.add(
    CLEANUP_JOB,
    {},
    {
      repeat: { every: env.CLEANUP_INTERVAL_MINUTES * 60 * 1000 },
      jobId: 'repeat:cleanup',
      removeOnComplete: true,
      removeOnFail: 20,
    }
  );

  await queue.add(
    BYOC_HEALTH_JOB,
    {},
    {
      repeat: { every: 15 * 60 * 1000 },
      jobId: 'repeat:byoc-health',
      removeOnComplete: true,
      removeOnFail: 20,
    }
  );

  await queue.add(CLEANUP_JOB, {}, { removeOnComplete: true, removeOnFail: 20 });

  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job: Job) => {
      if (job.name === CLEANUP_JOB) {
        await reapStalledJobs();
        await cleanupExpired();
        await expireSignDocuments();
      } else if (job.name === BYOC_HEALTH_JOB) {
        await runByocHealthSweep();
      }
    },
    { connection: redis as any, concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Maintenance job failed');
  });

  logger.info(
    { everyMinutes: env.CLEANUP_INTERVAL_MINUTES },
    'Maintenance worker initialized (scheduled cleanup)'
  );
  return worker;
}
