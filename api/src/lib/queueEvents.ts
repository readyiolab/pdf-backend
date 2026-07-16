import { QueueEvents } from 'bullmq';
import { redis } from './redis';
import { HEAVY_JOBS_QUEUE, LIGHT_JOBS_QUEUE } from '../../../shared/constants';
import { logger } from './logger';

// QueueEvents open a dedicated blocking connection and poll Redis continuously.
// To avoid burning Redis commands when nobody is watching a job (the common idle
// case), we create them lazily on the first SSE subscriber and tear them down
// when the last one disconnects. Only active processing with an open stream
// incurs any Redis traffic here.
let heavyEvents: QueueEvents | null = null;
let lightEvents: QueueEvents | null = null;
let subscriberCount = 0;

function ensureEvents(): [QueueEvents, QueueEvents] {
  if (!heavyEvents) {
    heavyEvents = new QueueEvents(HEAVY_JOBS_QUEUE, { connection: redis.duplicate() as any });
    heavyEvents.setMaxListeners(0);
    heavyEvents.on('error', (err) => logger.warn({ err }, 'heavy QueueEvents error'));
  }
  if (!lightEvents) {
    lightEvents = new QueueEvents(LIGHT_JOBS_QUEUE, { connection: redis.duplicate() as any });
    lightEvents.setMaxListeners(0);
    lightEvents.on('error', (err) => logger.warn({ err }, 'light QueueEvents error'));
  }
  return [heavyEvents, lightEvents];
}

function maybeTeardown(): void {
  if (subscriberCount > 0) return;
  const toClose = [heavyEvents, lightEvents];
  heavyEvents = null;
  lightEvents = null;
  for (const qe of toClose) {
    qe?.close().catch(() => undefined);
  }
}

export interface JobEventHandlers {
  onProgress?: (progress: number | object) => void;
  onCompleted?: () => void;
  onFailed?: (reason?: string) => void;
}

/**
 * Subscribes to BullMQ events for a single job across both queues and returns an
 * unsubscribe function. Lets the API push job updates to clients (SSE) instead
 * of polling the database. Connections are reference-counted (see above).
 */
export function subscribeJob(jobId: string, handlers: JobEventHandlers): () => void {
  const [heavy, light] = ensureEvents();
  subscriberCount++;

  const onProgress = ({ jobId: id, data }: { jobId: string; data: any }) => {
    if (id === jobId) handlers.onProgress?.(data);
  };
  const onCompleted = ({ jobId: id }: { jobId: string }) => {
    if (id === jobId) handlers.onCompleted?.();
  };
  const onFailed = ({ jobId: id, failedReason }: { jobId: string; failedReason?: string }) => {
    if (id === jobId) handlers.onFailed?.(failedReason);
  };

  for (const qe of [heavy, light]) {
    qe.on('progress', onProgress);
    qe.on('completed', onCompleted);
    qe.on('failed', onFailed);
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    for (const qe of [heavy, light]) {
      qe.off('progress', onProgress);
      qe.off('completed', onCompleted);
      qe.off('failed', onFailed);
    }
    subscriberCount = Math.max(0, subscriberCount - 1);
    maybeTeardown();
  };
}
