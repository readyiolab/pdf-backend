import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // Required by BullMQ
});

redis.on('connect', () => {
  logger.info('Worker connected to Redis');
});

redis.on('error', (err) => {
  logger.error({ err }, 'Worker Redis connection error');
});
