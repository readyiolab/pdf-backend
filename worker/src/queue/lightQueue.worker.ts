import { Worker } from 'bullmq';
import { redis } from '../lib/redis';
import { LIGHT_JOBS_QUEUE } from '../../../shared/constants';
import { jobRouter } from './jobRouter';
import { logger } from '../lib/logger';

export const startLightWorker = () => {
  const worker = new Worker(LIGHT_JOBS_QUEUE, jobRouter, {
    connection: redis as any,
    concurrency: 10, // Process up to 10 lightweight tasks concurrently
    // Detect workers that died mid-job and recover the job rather than losing it.
    stalledInterval: 30000,
    maxStalledCount: 2,
  });

  worker.on('active', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Light worker: job active');
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Light worker: job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err }, 'Light worker: job failed');
  });

  logger.info('Light jobs worker listener initialized');
  return worker;
};
