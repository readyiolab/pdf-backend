import { Queue } from 'bullmq';
import { redis } from './redis';
import { HEAVY_JOBS_QUEUE, LIGHT_JOBS_QUEUE, HEAVY_TOOLS } from '../../../shared/constants';
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
    removeOnComplete: true, // Clean up completed jobs from Redis
    removeOnFail: false,   // Keep failed jobs for debugging
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

export async function pushToQueue(
  jobId: string,
  userId: string | null,
  tool: ToolName,
  inputFiles: string[],
  options: Record<string, any>
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

  logger.info({ jobId, tool, queueName }, 'Pushing job to BullMQ');

  await queue.add(tool as any, payload, {
    jobId, // Use the DB's jobId as the BullMQ jobId to prevent duplicate processing
  });
}
