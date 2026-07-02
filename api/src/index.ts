import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import apiRouter from './routes';
import healthRoutes from './modules/health/health.routes';
import { rateLimiter } from './middleware/rateLimit.middleware';
import { errorHandler } from './middleware/errorHandler.middleware';
import { cleanupService } from './modules/cleanup/cleanup.service';
import { createMysqlPool } from './lib/mysql';

const app = express();

// Secure Express headers
app.use(helmet());

// Enable CORS
app.use(cors());

// Parse JSON request bodies (keeping raw body for webhook verification)
app.use(
  express.json({
    verify: (req: any, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// Request logging
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === '/health' || req.url === '/api/health',
    },
  })
);

import path from 'path';

// Register root-level health check endpoint (ideal for load balancers)
app.use('/health', healthRoutes);

import fs from 'fs';

// Serve the test client at http://localhost:5000/test
app.get('/test', (req, res) => {
  const pathsToTry = [
    path.join(__dirname, '../../test_client.html'),
    path.join(__dirname, '../test_client.html'),
    path.join(process.cwd(), 'test_client.html'),
    path.join(process.cwd(), '../test_client.html'),
  ];
  const testClientPath = pathsToTry.find((p) => fs.existsSync(p));
  
  if (testClientPath) {
    res.sendFile(testClientPath);
  } else {
    res.status(404).send('test_client.html not found on server');
  }
});

// Register main API routes with rate limiting
app.use('/api', rateLimiter, apiRouter);

// Global Error Handler (must be registered after all routes/middlewares)
app.use(errorHandler);

async function bootstrap() {
  try {
    // 1. Initialize MySQL Connection Pool & tables
    await createMysqlPool();

    // 2. Start HTTP Server
    const server = app.listen(env.PORT, () => {
      logger.info(`🚀 API Service running on port ${env.PORT} in ${env.NODE_ENV} mode`);
      
      // Run immediate cleanup on startup
      cleanupService.cleanupExpiredJobs().catch((err) => {
        logger.error({ err }, 'Error running initial cleanup on startup');
      });

      // Schedule cleanup to run every 15 minutes
      setInterval(() => {
        cleanupService.cleanupExpiredJobs().catch((err) => {
          logger.error({ err }, 'Error running scheduled cleanup');
        });
      }, 15 * 60 * 1000);
    });

    // Graceful Shutdown Handler
    const gracefulShutdown = () => {
      logger.info('Shutting down API Service...');
      server.close(() => {
        logger.info('HTTP server closed.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
  } catch (err) {
    logger.error({ err }, 'Failed to bootstrap API service');
    process.exit(1);
  }
}

bootstrap();
