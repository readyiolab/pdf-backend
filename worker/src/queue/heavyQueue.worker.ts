import { Worker } from 'bullmq';
import { redis } from '../lib/redis';
import { HEAVY_JOBS_QUEUE } from '../../../shared/constants';
import { jobRouter } from './jobRouter';
import { logger } from '../lib/logger';

export const startHeavyWorker = () => {
  const worker = new Worker(HEAVY_JOBS_QUEUE, jobRouter, {
    connection: redis as any,
    concurrency: 2, // Only process 2 heavy tasks (e.g. LibreOffice, OCR, compress) at a time
  });

  worker.on('active', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Heavy worker: job active');
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Heavy worker: job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err }, 'Heavy worker: job failed');
  });

  logger.info('Heavy jobs worker listener initialized');
  return worker;
};
