import { Queue } from 'bullmq';
import { redis } from './redis';
import {
  HEAVY_JOBS_QUEUE,
  LIGHT_JOBS_QUEUE,
  MAINTENANCE_QUEUE,
  DEAD_JOBS_QUEUE,
  HEAVY_TOOLS,
  SIGN_FINALIZE_QUEUE,
} from '../../../shared/constants';
import { ToolName, JobPayload } from '../../../shared/types';
import { logger } from './logger';

export const heavyQueue = new Queue<JobPayload>(HEAVY_JOBS_QUEUE, {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: { age: 24 * 3600, count: 1000 },
  },
});

export const lightQueue = new Queue<JobPayload>(LIGHT_JOBS_QUEUE, {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export interface SignFinalizePayload {
  documentId: string;
}

export const signFinalizeQueue = new Queue<SignFinalizePayload>(SIGN_FINALIZE_QUEUE, {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 8000 },
    removeOnComplete: true,
    removeOnFail: { age: 24 * 3600, count: 500 },
  },
});

export const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: redis as any });
export const deadQueue = new Queue(DEAD_JOBS_QUEUE, { connection: redis as any });

export async function enqueueSignFinalize(documentId: string): Promise<void> {
  logger.info({ documentId }, 'Enqueueing sign-finalize job');
  await signFinalizeQueue.add(
    'finalize',
    { documentId },
    {
      jobId: `finalize-${documentId}`,
    }
  );
}

export async function pushToQueue(
  jobId: string,
  userId: string | null,
  tool: ToolName,
  inputFiles: string[],
  options: Record<string, any>,
  plan: 'FREE' | 'PRO' = 'FREE'
) {
  const payload: JobPayload = {
    jobId,
    userId,
    tool,
    inputFiles,
    options,
  };

  const isHeavy = HEAVY_TOOLS.includes(tool);
  const queue = isHeavy ? heavyQueue : lightQueue;
  const queueName = isHeavy ? HEAVY_JOBS_QUEUE : LIGHT_JOBS_QUEUE;

  const priority = plan === 'PRO' ? 1 : 10;

  logger.info({ jobId, tool, queueName, priority }, 'Pushing job to BullMQ');

  await queue.add(tool as any, payload, {
    jobId,
    priority,
  });
}
