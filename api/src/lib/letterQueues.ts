import { Queue } from 'bullmq';
import { redis } from './redis';
import {
  LETTER_GENERATE_QUEUE,
  LETTER_PARSE_QUEUE,
  LETTER_SEND_QUEUE,
} from '../../../shared/constants';
import { logger } from './logger';

export interface LetterGenerateJob {
  batchId: string;
  organizationId: string;
  employeeIds: string[];
  passwordMode: 'NONE' | 'FROM_COLUMN' | 'EMPLOYEE_ID' | 'LAST4_ID';
  userId: string;
}

export interface LetterSendJob {
  batchId: string;
  organizationId: string;
  employeeIds: string[];
  mode: 'CREATE_DRAFTS' | 'SEND_NOW';
  subject: string;
  bodyHtml: string;
  userId: string;
  mailAccountId: string;
}

export const letterGenerateQueue = new Queue<LetterGenerateJob>(LETTER_GENERATE_QUEUE, {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: { age: 24 * 3600, count: 500 },
  },
});

export const letterParseQueue = new Queue(LETTER_PARSE_QUEUE, {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: true,
    removeOnFail: { age: 24 * 3600, count: 200 },
  },
});

export const letterSendQueue = new Queue<LetterSendJob>(LETTER_SEND_QUEUE, {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 8000 },
    removeOnComplete: true,
    removeOnFail: { age: 24 * 3600, count: 500 },
  },
});

export async function enqueueLetterGenerate(job: LetterGenerateJob, chunkIndex: number) {
  logger.info(
    { batchId: job.batchId, count: job.employeeIds.length, chunkIndex },
    'Enqueueing letter-generate chunk'
  );
  await letterGenerateQueue.add('generate', job, {
    // Unique per enqueue so retries are not blocked by a stuck prior jobId
    jobId: `letter-gen-${job.batchId}-${chunkIndex}-${Date.now()}`,
  });
}

export async function enqueueLetterSend(job: LetterSendJob, chunkIndex: number) {
  logger.info(
    { batchId: job.batchId, count: job.employeeIds.length, chunkIndex },
    'Enqueueing letter-send chunk'
  );
  await letterSendQueue.add('send', job, {
    jobId: `letter-send-${job.batchId}-${chunkIndex}-${Date.now()}`,
  });
}
