import { Queue } from 'bullmq';
import { redis } from './redis';
import {
  LETTER_GENERATE_QUEUE,
  LETTER_PARSE_QUEUE,
  LETTER_SEND_QUEUE,
  LETTER_ZIP_QUEUE,
  AI_EXTRACT_QUEUE,
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

export interface LetterZipJob {
  zipJobId: string;
  batchId: string;
  organizationId: string;
  userId: string;
  storageBindingId: string | null;
}

export interface AiExtractJob {
  fileKey: string;
  userId: string;
  organizationId: string | null;
  storageBindingId: string | null;
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

export const letterZipQueue = new Queue<LetterZipJob>(LETTER_ZIP_QUEUE, {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: { age: 24 * 3600, count: 200 },
  },
});

export const aiExtractQueue = new Queue<AiExtractJob>(AI_EXTRACT_QUEUE, {
  connection: redis as any,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: true,
    removeOnFail: { age: 24 * 3600, count: 200 },
  },
});

export async function enqueueLetterGenerate(job: LetterGenerateJob, chunkIndex: number) {
  logger.info(
    { batchId: job.batchId, count: job.employeeIds.length, chunkIndex },
    'Enqueueing letter-generate chunk'
  );
  await letterGenerateQueue.add('generate', job, {
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

export async function enqueueLetterZip(job: LetterZipJob) {
  logger.info({ batchId: job.batchId, zipJobId: job.zipJobId }, 'Enqueueing letter-zip job');
  await letterZipQueue.add('zip', job, {
    jobId: `letter-zip-${job.zipJobId}`,
  });
}

export async function enqueueAiExtract(job: AiExtractJob): Promise<string> {
  logger.info({ fileKey: job.fileKey }, 'Enqueueing AI extract job');
  const jobId = `ai-extract-${job.fileKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)}`;
  const existing = await aiExtractQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed') {
      return jobId;
    }
    if (state === 'failed') {
      await existing.remove().catch(() => undefined);
    } else {
      // waiting / active / delayed — reuse
      return jobId;
    }
  }
  await aiExtractQueue.add('extract', job, { jobId });
  return jobId;
}
