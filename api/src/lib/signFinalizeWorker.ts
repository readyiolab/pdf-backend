import { Worker } from 'bullmq';
import { redis } from './redis';
import { SIGN_FINALIZE_QUEUE } from '../../../shared/constants';
import { signFinalizeQueue, type SignFinalizePayload } from './queue';
import { finalizeService } from '../modules/signing/finalize.service';
import { logger } from './logger';

let finalizeWorker: Worker<SignFinalizePayload> | null = null;

/**
 * Processes PDF sealing off the HTTP request path.
 * Runs inside the API process so it can reuse finalizeService (pdf-lib, P12, TSA)
 * without duplicating the signing stack into the PDF-tools worker.
 */
export function startSignFinalizeWorker(): Worker<SignFinalizePayload> {
  finalizeWorker = new Worker<SignFinalizePayload>(
    SIGN_FINALIZE_QUEUE,
    async (job) => {
      const { documentId } = job.data;
      logger.info({ documentId, jobId: job.id }, 'Sign-finalize worker: starting');
      await finalizeService.finalize(documentId);
    },
    {
      connection: redis as any,
      concurrency: 1,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );

  finalizeWorker.on('completed', (job) => {
    logger.info({ jobId: job.id, documentId: job.data.documentId }, 'Sign-finalize completed');
  });

  finalizeWorker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, documentId: job?.data?.documentId, err },
      'Sign-finalize failed'
    );
  });

  // Touch the queue export so the module graph always includes producers + worker.
  void signFinalizeQueue;

  logger.info('Sign-finalize worker listening');
  return finalizeWorker;
}

export async function stopSignFinalizeWorker(): Promise<void> {
  await finalizeWorker?.close();
  finalizeWorker = null;
}
