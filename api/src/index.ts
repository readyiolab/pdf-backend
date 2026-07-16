import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import apiRouter from './routes';
import healthRoutes from './modules/health/health.routes';
import webhookRoutes from './modules/webhooks/webhooks.routes';
import { rateLimiter } from './middleware/rateLimit.middleware';
import { errorHandler } from './middleware/errorHandler.middleware';
import { createDashboard } from './lib/bullBoard';
import { createMysqlPool } from './lib/mysql';

const app = express();

// Trust the reverse proxy so express-rate-limit keys on the real client IP
app.set('trust proxy', 1);

// Secure Express headers
app.use(helmet());

// Restrict CORS to known origins (never reflect arbitrary origins)
const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin / non-browser tools (no Origin header)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  })
);

// Admin queue dashboard (bull-board), gated by HTTP Basic Auth against
// ADMIN_TOKEN. Disabled entirely when ADMIN_TOKEN is not set. Mounted before the
// JSON parser and API rate limiter since it serves its own UI + API.
const dashboard = createDashboard();
if (dashboard) {
  app.use(dashboard.basePath, dashboard.auth, dashboard.router);
  logger.info(`🔐 Queue dashboard available at ${dashboard.basePath}`);
}

// Webhooks need the untouched raw body for signature verification and must
// bypass both the JSON parser and the general rate limiter. Mount before them.
app.use('/api/webhooks', webhookRoutes);

// Gzip/brotli-compress responses, except Server-Sent Events (which must stream
// unbuffered) — the SSE handler sets text/event-stream, which we skip here.
app.use(
  compression({
    filter: (req, res) => {
      if (res.getHeader('Content-Type') === 'text/event-stream') return false;
      return compression.filter(req, res);
    },
  })
);

// Parse JSON bodies with a strict size limit (large-payload DoS protection)
app.use(express.json({ limit: env.MAX_JSON_BODY }));

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

// Serve the test client at http://localhost:5000/test (development only)
app.get('/test', (req, res) => {
  if (env.NODE_ENV === 'production') {
    return res.status(404).send('Not found');
  }
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
      // NOTE: expired-file cleanup now runs in the worker as a BullMQ repeatable
      // job (distributed-safe, survives restarts) rather than a per-instance
      // setInterval here — otherwise every API replica would sweep in parallel.
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
