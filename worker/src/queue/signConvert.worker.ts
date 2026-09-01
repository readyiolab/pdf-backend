import { Worker } from 'bullmq';
import { SIGN_CONVERT_QUEUE } from '../../../shared/constants';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import {
  signConvertProcessor,
  type SignConvertPayload,
} from '../processors/signConvert.processor';

export function startSignConvertWorker(): Worker<SignConvertPayload> {
  const worker = new Worker<SignConvertPayload>(
    SIGN_CONVERT_QUEUE,
    async (job) => {
      logger.info({ jobId: job.id, documentId: job.data.documentId }, 'sign-convert: starting');
      await signConvertProcessor(job.data);
    },
    {
      connection: redis as any,
      concurrency: 2,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, documentId: job.data.documentId }, 'sign-convert: completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, documentId: job?.data.documentId, err }, 'sign-convert: failed');
  });

  logger.info('Sign-convert worker listener initialized');
  return worker;
}
