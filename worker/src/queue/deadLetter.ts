import { Queue } from 'bullmq';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';
import { DEAD_JOBS_QUEUE } from '../../../shared/constants';
import { JobPayload } from '../../../shared/types';

// Holds jobs that exhausted all retries, with full context for inspection/replay.
export const deadJobsQueue = new Queue(DEAD_JOBS_QUEUE, {
  connection: redis as any,
  defaultJobOptions: {
    // Keep dead jobs around for a week so they can be reviewed, then auto-prune.
    removeOnComplete: false,
    removeOnFail: false,
  },
});

export async function moveToDeadLetter(
  payload: JobPayload,
  errorMessage: string,
  attemptsMade: number
): Promise<void> {
  try {
    await deadJobsQueue.add(
      payload.tool,
      { ...payload, errorMessage, attemptsMade, failedAt: new Date().toISOString() },
      { removeOnComplete: false }
    );
    logger.warn({ jobId: payload.jobId, tool: payload.tool }, 'Job moved to dead-letter queue');
  } catch (err) {
    logger.error({ err, jobId: payload.jobId }, 'Failed to move job to dead-letter queue');
  }
}
