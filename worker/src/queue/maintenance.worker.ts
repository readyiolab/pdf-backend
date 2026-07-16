import { Queue, Worker, Job } from 'bullmq';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { getPool } from '../lib/mysql';
import { deleteFromS3 } from '../storage/s3';
import { env } from '../config/env';
import { MAINTENANCE_QUEUE } from '../../../shared/constants';

const CLEANUP_JOB = 'cleanup-expired';

/**
 * Deletes expired jobs and their input/output files. Runs on a BullMQ repeatable
 * schedule (replacing the API's setInterval) so it executes once across the whole
 * cluster, survives restarts, and can be observed/retried like any other job.
 */
async function cleanupExpired(): Promise<void> {
  const pool = getPool();
  const now = new Date();

  const [expired]: any = await pool.query(
    'SELECT id, inputFiles, outputFile FROM tbl_job WHERE expiresAt < ? LIMIT 1000',
    [now]
  );

  if (!expired.length) return;

  const keys: string[] = [];
  for (const job of expired) {
    try {
      const inputs =
        typeof job.inputFiles === 'string' ? JSON.parse(job.inputFiles) : job.inputFiles;
      if (Array.isArray(inputs)) keys.push(...inputs);
    } catch {
      /* ignore malformed inputFiles */
    }
    if (job.outputFile) keys.push(job.outputFile);
  }

  await deleteFromS3(keys);

  const ids = expired.map((j: any) => j.id);
  const [del]: any = await pool.query('DELETE FROM tbl_job WHERE id IN (?)', [ids]);
  logger.info(
    { deletedJobs: del.affectedRows, deletedFiles: keys.length },
    'Maintenance: cleaned up expired jobs'
  );
}

/**
 * Fails jobs left in PROCESSING far longer than any job should take — the
 * signature of a worker that crashed mid-job without BullMQ recovering it.
 */
async function reapStalledJobs(): Promise<void> {
  const pool = getPool();
  const cutoff = new Date(Date.now() - env.STALE_JOB_MINUTES * 60 * 1000);
  const [res]: any = await pool.query(
    `UPDATE tbl_job
        SET status = 'FAILED', errorMessage = 'Processing stalled and was terminated', completedAt = ?
      WHERE status = 'PROCESSING' AND createdAt < ?`,
    [new Date(), cutoff]
  );
  if (res.affectedRows > 0) {
    logger.warn({ count: res.affectedRows }, 'Maintenance: reaped stalled PROCESSING jobs');
  }
}

export async function startMaintenanceWorker() {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection: redis as any });

  // A fixed repeat key ensures only one repeatable exists even with many replicas.
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

  // Run one sweep shortly after boot rather than waiting a full interval.
  await queue.add(CLEANUP_JOB, {}, { removeOnComplete: true, removeOnFail: 20 });

  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job: Job) => {
      if (job.name === CLEANUP_JOB) {
        await reapStalledJobs();
        await cleanupExpired();
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
