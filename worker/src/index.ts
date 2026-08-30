import express from 'express';
import { env } from './config/env';
import { logger } from './lib/logger';
import { startHeavyWorker } from './queue/heavyQueue.worker';
import { startLightWorker } from './queue/lightQueue.worker';
import { startMaintenanceWorker } from './queue/maintenance.worker';
import {
  startLetterZipWorker,
  startAiExtractWorker,
  stopAuxWorkers,
} from './queue/auxWorkers';
import { redis } from './lib/redis';
import { createMysqlPool, db } from './lib/mysql';
import { startWorkerStorageCacheSubscriber } from './storage/s3';

logger.info('Initializing Worker Service...');

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

let heavyWorker: any;
let lightWorker: any;
let maintenanceWorker: any;
let letterZipWorker: any;
let aiExtractWorker: any;
let server: any;

// Spin up a minimal Express server for container/health checks
const app = express();

app.get('/health', async (req, res) => {
  let dbStatus = 'UP';
  let redisStatus = 'UP';

  try {
    await db.queryAll('SELECT 1 AS ok');
  } catch (err) {
    dbStatus = 'DOWN';
  }

  try {
    await redis.ping();
  } catch (err) {
    redisStatus = 'DOWN';
  }

  const overallStatus = dbStatus === 'UP' && redisStatus === 'UP' ? 'UP' : 'DEGRADED';
  const statusCode = overallStatus === 'UP' ? 200 : 503;

  res.status(statusCode).json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    services: {
      database: dbStatus,
      redis: redisStatus,
    },
  });
});

// Graceful Shutdown
const gracefulShutdown = async () => {
  logger.info('Shutting down Worker Service...');
  
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed.');
    });
  }

  if (heavyWorker) {
    await heavyWorker.close();
    logger.info('Heavy worker closed.');
  }
  
  if (lightWorker) {
    await lightWorker.close();
    logger.info('Light worker closed.');
  }

  if (maintenanceWorker) {
    await maintenanceWorker.close();
    logger.info('Maintenance worker closed.');
  }

  await stopAuxWorkers();
  logger.info('Aux workers closed.');

  // Disconnect Redis
  await redis.quit();
  logger.info('Redis connection closed.');

  // Disconnect MySQL Pool
  try {
    await db.close();
    logger.info('MySQL Pool closed.');
  } catch (err) {
    // Ignore if not initialized
  }

  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function bootstrap() {
  try {
    // 1. Initialize MySQL connection pool
    await createMysqlPool();

    // Cross-process BYOC provider cache invalidation (API ↔ worker)
    startWorkerStorageCacheSubscriber();

    // 2. Start BullMQ workers
    heavyWorker = startHeavyWorker();
    lightWorker = startLightWorker();
    maintenanceWorker = await startMaintenanceWorker();
    letterZipWorker = startLetterZipWorker();
    aiExtractWorker = startAiExtractWorker();

    // 3. Start health check listener
    server = app.listen(env.PORT, () => {
      logger.info(`🚀 Worker healthcheck endpoint active on port ${env.PORT}`);
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start Worker service');
    process.exit(1);
  }
}

bootstrap();
